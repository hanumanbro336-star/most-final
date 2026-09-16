import { relayFetch } from '@/lib/relay'

export async function POST(request: Request) {
  const body = await request.arrayBuffer()
  return relayFetch('/v1/pairs/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
    },
    body,
  })
}
