import { relayFetch, relayPhoneHeaders } from '@/lib/relay'
import { json } from '@/lib/http'

export const maxDuration = 300

const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const allowedHeaders = new Set(['accept', 'content-type', 'if-none-match', 'last-event-id'])

type Context = { params: Promise<{ deviceId: string; path: string[] }> }

async function handler(request: Request, { params }: Context) {
  const { deviceId, path } = await params
  if (!allowedMethods.has(request.method)) return json({ error: 'Method not allowed' }, 405)

  const joinedPath = `/${(path ?? []).map(encodeURIComponent).join('/')}`
  if (joinedPath.startsWith('/internal')) return json({ error: 'Forbidden' }, 403)
  const url = new URL(request.url)
  url.searchParams.delete('token')
  const query = url.searchParams.toString()
  const rpcPath = `${joinedPath}${query ? `?${query}` : ''}`
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    if (allowedHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value
  }
  const body = request.method === 'GET' ? undefined : Buffer.from(await request.arrayBuffer()).toString('base64')
  const relayHeaders = relayPhoneHeaders(request)
  relayHeaders.set('content-type', 'application/json')

  return relayFetch(`/v1/devices/${encodeURIComponent(deviceId)}/rpc`, {
    method: 'POST',
    headers: relayHeaders,
    body: JSON.stringify({ method: request.method, path: rpcPath, headers, bodyBase64: body }),
  })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
