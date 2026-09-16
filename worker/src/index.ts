import { DeviceRelay } from './device-relay'
import type { DeviceRow, Env, PairingRow, RpcRequest } from './types'
import {
  hashSecret,
  HttpError,
  json,
  normalizePath,
  randomCode,
  randomToken,
  readJson,
  requireProxy,
  safeEqual,
  consumeRateLimit,
} from './util'

export { DeviceRelay }

const PAIR_TTL_MS = 10 * 60_000
const ONLINE_WINDOW_MS = 45_000
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const forwardedHeaders = new Set(['accept', 'content-type', 'if-none-match', 'last-event-id'])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true, service: 'forge-relay' })
      }
      if (url.pathname.match(/^\/v1\/devices\/[^/]+\/connect$/)) {
        return connectLaptop(request, env, url)
      }
      if (!requireProxy(request, env)) return json({ error: 'Invalid proxy credential' }, 401)

      if (url.pathname === '/v1/pairs' && request.method === 'POST') return createPair(request, env)
      if (url.pathname === '/v1/pairs/claim' && request.method === 'POST') return claimPair(request, env)
      if (url.pathname === '/v1/pairs/status' && request.method === 'GET') return pairStatus(request, env, url)

      const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)(?:\/(rpc))?$/)
      if (deviceMatch) {
        const deviceId = deviceMatch[1]
        if (deviceMatch[2] === 'rpc' && request.method === 'POST') return proxyRpc(request, env, deviceId)
        if (request.method === 'GET') return deviceStatus(request, env, deviceId)
        if (request.method === 'DELETE') return removeDevice(request, env, deviceId)
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      return json({ error: 'Relay request failed' }, 500)
    }
  },
} satisfies ExportedHandler<Env>

async function createPair(request: Request, env: Env) {
  await consumeRateLimit(env, `create:${clientKey(request)}`, 12, 60_000)
  const now = Date.now()
  const expiresAt = now + PAIR_TTL_MS
  const phoneSecret = randomToken()
  const phoneSecretHash = await hashSecret(phoneSecret)
  let code = randomCode()
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const result = await env.DB.prepare('INSERT OR IGNORE INTO pairing_codes (code, phone_secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(code, phoneSecretHash, now, expiresAt)
      .run()
    if (result.meta.changes === 1) {
      return json({ code, phoneSecret, expiresAt: new Date(expiresAt).toISOString() }, 201)
    }
    code = randomCode()
  }
  throw new HttpError(503, 'Could not allocate a pairing code')
}

async function claimPair(request: Request, env: Env) {
  await consumeRateLimit(env, `claim:${clientKey(request)}`, 30, 60_000)
  const body = await readJson<{ code?: string; name?: string; platform?: string }>(request, 16_384)
  const code = normalizeCode(body.code)
  const pair = await env.DB.prepare('SELECT * FROM pairing_codes WHERE code = ?').bind(code).first<PairingRow>()
  const now = Date.now()
  if (!pair || pair.expires_at <= now) throw new HttpError(410, 'Pairing code expired')
  if (pair.claimed_at || pair.device_id) throw new HttpError(409, 'Pairing code was already claimed')

  const deviceId = crypto.randomUUID()
  const deviceToken = randomToken()
  const deviceTokenHash = await hashSecret(deviceToken)
  const name = cleanLabel(body.name, 'Forge laptop')
  const platform = cleanLabel(body.platform, 'unknown')
  const claim = await env.DB.prepare('UPDATE pairing_codes SET claimed_at = ?, device_id = ? WHERE code = ? AND claimed_at IS NULL AND expires_at > ?')
    .bind(now, deviceId, code, now)
    .run()
  if (claim.meta.changes !== 1) throw new HttpError(409, 'Pairing code was already claimed')
  try {
    await env.DB.prepare('INSERT INTO devices (id, name, platform, phone_secret_hash, device_token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(deviceId, name, platform, pair.phone_secret_hash, deviceTokenHash, now)
      .run()
  } catch (error) {
    await env.DB.prepare('UPDATE pairing_codes SET claimed_at = NULL, device_id = NULL WHERE code = ? AND device_id = ?')
      .bind(code, deviceId)
      .run()
    throw error
  }

  const workerUrl = new URL(request.url)
  workerUrl.protocol = workerUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  workerUrl.pathname = `/v1/devices/${deviceId}/connect`
  workerUrl.search = `token=${encodeURIComponent(deviceToken)}`
  return json({ deviceId, deviceToken, workerWebSocketUrl: workerUrl.toString(), name, platform }, 201)
}

async function pairStatus(request: Request, env: Env, url: URL) {
  const code = normalizeCode(url.searchParams.get('code'))
  const phoneSecret = request.headers.get('x-forge-phone-secret') ?? ''
  const pair = await env.DB.prepare('SELECT * FROM pairing_codes WHERE code = ?').bind(code).first<PairingRow>()
  if (!pair || !phoneSecret || !safeEqual(await hashSecret(phoneSecret), pair.phone_secret_hash)) {
    throw new HttpError(404, 'Pairing session not found')
  }
  if (pair.expires_at <= Date.now() && !pair.device_id) return json({ status: 'expired' })
  if (!pair.device_id) return json({ status: 'waiting', expiresAt: new Date(pair.expires_at).toISOString() })
  const device = await getAuthorizedDevice(env, pair.device_id, phoneSecret)
  const relay = await relayStatus(env, device.id)
  return json({ status: relay.online ? 'online' : 'claimed', device: publicDevice(device, relay) })
}

async function deviceStatus(request: Request, env: Env, deviceId: string) {
  const device = await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request))
  const relay = await relayStatus(env, device.id)
  return json({ device: publicDevice(device, relay) })
}

async function removeDevice(request: Request, env: Env, deviceId: string) {
  await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request))
  await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(Date.now(), deviceId).run()
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId))
  await stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/disconnect`, env, { method: 'POST' }))
  return json({ removed: true })
}

async function connectLaptop(request: Request, env: Env, url: URL) {
  const deviceId = url.pathname.split('/')[3]
  const token = url.searchParams.get('token') ?? ''
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').bind(deviceId).first<DeviceRow>()
  if (!device || !token || !safeEqual(await hashSecret(token), device.device_token_hash)) {
    return json({ error: 'Invalid device credential' }, 401)
  }
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), deviceId).run()
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId))
  return stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/connect`, env, request))
}

async function proxyRpc(request: Request, env: Env, deviceId: string) {
  await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request))
  await consumeRateLimit(env, `rpc:${deviceId}`, 240, 60_000)
  const body = await readJson<RpcRequest>(request)
  const method = body.method?.toUpperCase()
  if (!allowedMethods.has(method)) throw new HttpError(400, 'Unsupported RPC method')
  const path = normalizePath(body.path)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(body.headers ?? {})) {
    if (forwardedHeaders.has(name.toLowerCase()) && value.length <= 8192) headers[name.toLowerCase()] = value
  }
  if (body.bodyBase64 && body.bodyBase64.length > 1_400_000) throw new HttpError(413, 'RPC body is too large')
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId))
  return stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/rpc`, env, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, headers, bodyBase64: body.bodyBase64 }),
  }))
}

async function getAuthorizedDevice(env: Env, deviceId: string, phoneSecret: string) {
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').bind(deviceId).first<DeviceRow>()
  if (!device || !phoneSecret || !safeEqual(await hashSecret(phoneSecret), device.phone_secret_hash)) {
    throw new HttpError(404, 'Device not found')
  }
  return device
}

async function relayStatus(env: Env, deviceId: string) {
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId))
  const response = await stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/status`, env))
  return response.json<{ online: boolean; daemonOnline: boolean }>()
}

function authorizedRelayRequest(input: string, env: Env, init?: Request | RequestInit) {
  const headers = new Headers(init instanceof Request ? init.headers : init?.headers)
  headers.set('x-forge-authorized', env.WORKER_PROXY_SECRET)
  if (init instanceof Request) return new Request(input, { method: init.method, headers })
  return new Request(input, { ...init, headers })
}

function publicDevice(device: DeviceRow, relay: { online: boolean; daemonOnline: boolean }) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    online: relay.online,
    daemonOnline: relay.daemonOnline,
    createdAt: new Date(device.created_at).toISOString(),
    lastSeenAt: device.last_seen_at ? new Date(device.last_seen_at).toISOString() : null,
  }
}

function phoneSecretFrom(request: Request) {
  return request.headers.get('x-forge-phone-secret') ?? ''
}

function normalizeCode(value: string | null | undefined) {
  const code = (value ?? '').trim().toUpperCase()
  if (!/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code)) throw new HttpError(400, 'Invalid pairing code')
  return code
}

function cleanLabel(value: string | undefined, fallback: string) {
  const clean = (value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)
  return clean || fallback
}

function clientKey(request: Request) {
  return request.headers.get('cf-connecting-ip') ?? 'proxy'
}
