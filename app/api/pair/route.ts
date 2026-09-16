import { relayFetch, relayPhoneHeaders, requireSameOrigin } from '@/lib/relay'

export async function POST(request: Request) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  return relayFetch('/v1/pairs', {
    method: 'POST',
    headers: { 'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '' },
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code') ?? ''
  return relayFetch(`/v1/pairs/status?code=${encodeURIComponent(code)}`, {
    headers: relayPhoneHeaders(request),
  })
}
