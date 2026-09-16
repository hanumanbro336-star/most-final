import { relayFetch, relayPhoneHeaders, requireSameOrigin } from '@/lib/relay'

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: Context) {
  const { id } = await params
  return relayFetch(`/v1/devices/${encodeURIComponent(id)}`, {
    headers: relayPhoneHeaders(request),
  })
}

export async function DELETE(request: Request, { params }: Context) {
  const blocked = requireSameOrigin(request)
  if (blocked) return blocked
  const { id } = await params
  return relayFetch(`/v1/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: relayPhoneHeaders(request),
  })
}
