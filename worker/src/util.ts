import type { Env } from './types'

const encoder = new TextEncoder()
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

export function randomToken(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return base64Url(values)
}

export function randomCode() {
  const values = crypto.getRandomValues(new Uint8Array(9))
  const raw = Array.from(values, (value) => codeAlphabet[value % codeAlphabet.length]).join('')
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`
}

export async function hashSecret(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

export function safeEqual(left: string, right: string) {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0)
  }
  return difference === 0
}

export function requireProxy(request: Request, env: Env) {
  const provided = request.headers.get('x-forge-proxy-secret') ?? ''
  return Boolean(env.WORKER_PROXY_SECRET) && safeEqual(provided, env.WORKER_PROXY_SECRET)
}

export async function readJson<T>(request: Request, maxBytes = 1_048_576): Promise<T> {
  const size = Number(request.headers.get('content-length') ?? '0')
  if (size > maxBytes) throw new HttpError(413, 'Request body is too large')
  const text = await request.text()
  if (encoder.encode(text).byteLength > maxBytes) throw new HttpError(413, 'Request body is too large')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

export function normalizePath(path: string) {
  if (!path.startsWith('/') || path.includes('..') || path.length > 2048) {
    throw new HttpError(400, 'Invalid RPC path')
  }
  return path
}

export async function consumeRateLimit(env: Env, key: string, limit: number, windowMs: number) {
  const now = Date.now()
  const row = await env.DB.prepare('SELECT window_started_at, count FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ window_started_at: number; count: number }>()
  if (!row || now - row.window_started_at >= windowMs) {
    await env.DB.prepare('INSERT INTO rate_limits (key, window_started_at, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_started_at = excluded.window_started_at, count = 1')
      .bind(key, now)
      .run()
    return
  }
  if (row.count >= limit) throw new HttpError(429, 'Too many requests')
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run()
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
