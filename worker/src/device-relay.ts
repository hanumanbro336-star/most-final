import type { Env, LaptopMessage, RpcRequest } from './types'
import { HttpError, json, readJson } from './util'

type PendingRpc = {
  stream: TransformStream<Uint8Array, Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  resolveStart: (response: Response) => void
  rejectStart: (error: Error) => void
  started: boolean
  bytes: number
  timeout: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const FIRST_BYTE_TIMEOUT_MS = 15_000
const RPC_LIFETIME_MS = 5 * 60_000
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024

export class DeviceRelay implements DurableObject {
  private laptop: WebSocket | null = null
  private daemonOnline = false
  private pending = new Map<string, PendingRpc>()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const sockets = this.state.getWebSockets('laptop')
    this.laptop = sockets.at(0) ?? null
  }

  async fetch(request: Request) {
    if (request.headers.get('x-forge-authorized') !== this.env.WORKER_PROXY_SECRET) {
      return json({ error: 'Unauthorized relay request' }, 401)
    }

    const url = new URL(request.url)
    if (url.pathname.endsWith('/connect')) return this.connectLaptopSocket(request)
    if (url.pathname.endsWith('/status')) {
      return json({
        online: this.laptop?.readyState === WebSocket.OPEN,
        daemonOnline: this.daemonOnline,
      })
    }
    if (url.pathname.endsWith('/disconnect') && request.method === 'POST') {
      this.laptop?.close(1000, 'Device removed')
      this.laptop = null
      this.daemonOnline = false
      this.failAll(new Error('Device removed'))
      return json({ disconnected: true })
    }
    if (url.pathname.endsWith('/rpc') && request.method === 'POST') return this.rpc(request)
    return json({ error: 'Not found' }, 404)
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (socket !== this.laptop) return
    let payload: LaptopMessage
    try {
      payload = JSON.parse(typeof message === 'string' ? message : decoder.decode(message)) as LaptopMessage
    } catch {
      socket.close(1003, 'Invalid JSON')
      return
    }

    if (payload.type === 'heartbeat') {
      this.daemonOnline = payload.daemonOnline
      socket.send(JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }))
      return
    }
    if (!('id' in payload)) return
    const pending = this.pending.get(payload.id)
    if (!pending) return

    if (payload.type === 'rpc_start') {
      if (pending.started) return
      pending.started = true
      clearTimeout(pending.timeout)
      pending.timeout = setTimeout(() => this.fail(payload.id, new Error('RPC lifetime exceeded')), RPC_LIFETIME_MS)
      const headers = new Headers(payload.headers)
      headers.delete('content-length')
      headers.delete('content-encoding')
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
      pending.resolveStart(new Response(pending.stream.readable, { status: payload.status, headers }))
      return
    }
    if (payload.type === 'rpc_chunk') {
      const chunk = decodeBase64(payload.bodyBase64)
      pending.bytes += chunk.byteLength
      if (pending.bytes > MAX_RESPONSE_BYTES) {
        this.fail(payload.id, new Error('RPC response is too large'))
        return
      }
      void pending.writer.write(chunk)
      return
    }
    if (payload.type === 'rpc_end') {
      clearTimeout(pending.timeout)
      void pending.writer.close()
      this.pending.delete(payload.id)
      return
    }
    if (payload.type === 'rpc_error') this.fail(payload.id, new Error(payload.message))
  }

  webSocketClose(socket: WebSocket) {
    if (socket === this.laptop) this.laptop = null
    this.daemonOnline = false
    this.failAll(new Error('Laptop disconnected'))
  }

  webSocketError(socket: WebSocket) {
    if (socket === this.laptop) this.laptop = null
    this.daemonOnline = false
    this.failAll(new Error('Laptop connection failed'))
  }

  private connectLaptopSocket(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426)
    }
    this.laptop?.close(1012, 'Replaced by a new connection')
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server, ['laptop'])
    this.laptop = server
    return new Response(null, { status: 101, webSocket: client })
  }

  private async rpc(request: Request) {
    if (!this.laptop || this.laptop.readyState !== WebSocket.OPEN) {
      return json({ error: 'Laptop is offline' }, 503)
    }
    if (this.pending.size >= 16) return json({ error: 'Laptop is busy' }, 429)

    let rpc: RpcRequest
    try {
      rpc = await readJson<RpcRequest>(request)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      throw error
    }

    const id = crypto.randomUUID()
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    let resolveStart!: (response: Response) => void
    let rejectStart!: (error: Error) => void
    const response = new Promise<Response>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const timeout = setTimeout(() => this.fail(id, new Error('Laptop did not respond')), FIRST_BYTE_TIMEOUT_MS)
    this.pending.set(id, {
      stream,
      writer: stream.writable.getWriter(),
      resolveStart,
      rejectStart,
      started: false,
      bytes: 0,
      timeout,
    })
    this.laptop.send(JSON.stringify({ type: 'rpc_request', id, ...rpc }))

    try {
      return await response
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'RPC failed' }, 504)
    }
  }

  private fail(id: string, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    if (pending.started) void pending.writer.abort(error)
    else pending.rejectStart(error)
    this.pending.delete(id)
  }

  private failAll(error: Error) {
    for (const id of this.pending.keys()) this.fail(id, error)
  }
}

function decodeBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
