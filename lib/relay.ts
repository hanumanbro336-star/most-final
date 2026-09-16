import { json } from '@/lib/http'

const PHONE_SECRET_HEADER = 'x-forge-phone-secret'

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return json({ error: 'Origin header required' }, 403)
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const requestUrl = new URL(request.url)
  const expected = forwardedHost
    ? `${forwardedProto || 'https'}://${forwardedHost}`
    : requestUrl.origin
  if (origin !== expected) return json({ error: 'Cross-origin request blocked' }, 403)
  return null
}

export function phoneSecret(request: Request) {
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim()
  const headerToken = request.headers.get(PHONE_SECRET_HEADER) || request.headers.get('x-auth-token')
  if (headerToken) return headerToken.trim()
  return new URL(request.url).searchParams.get('token')?.trim() ?? ''
}

export async function relayFetch(path: string, init: RequestInit = {}) {
  const relayUrl = process.env.CLOUDFLARE_WORKER_URL?.replace(/\/+$/, '')
  const proxySecret = process.env.WORKER_PROXY_SECRET
  if (!relayUrl || !proxySecret) {
    return json(
      {
        error: 'Forge relay is not configured',
        code: 'RELAY_NOT_CONFIGURED',
      },
      503,
    )
  }

  const headers = new Headers(init.headers)
  headers.set('x-forge-proxy-secret', proxySecret)
  headers.set('accept', headers.get('accept') ?? 'application/json')
  try {
    const response = await fetch(`${relayUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(310_000),
    })
    return relayResponse(response)
  } catch {
    return json({ error: 'Forge relay is unavailable', code: 'RELAY_UNAVAILABLE' }, 502)
  }
}

export async function relayResponse(response: Response) {
  const headers = new Headers()
  const contentType = response.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, { status: response.status, headers })
}

export function relayPhoneHeaders(request: Request) {
  const headers = new Headers()
  const secret = phoneSecret(request)
  if (secret) headers.set(PHONE_SECRET_HEADER, secret)
  return headers
}
