import { and, eq } from 'drizzle-orm'
import { bearerToken, hashEquals, randomId, sleep } from '@/lib/crypto'
import { db } from '@/lib/db'
import { devices, rpcJobs } from '@/lib/db/schema'
import { json } from '@/lib/http'

export const runtime = 'nodejs'
export const maxDuration = 30

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

async function handler(
  request: Request,
  context: { params: Promise<{ deviceId: string; path: string[] }> }
) {
  const { deviceId, path } = await context.params
  const joined = `/${(path || []).join('/')}`
  if (joined.startsWith('/internal')) {
    return json({ error: 'Forbidden' }, 403)
  }

  const secret = bearerToken(request)
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1)
  if (!device || !secret || !hashEquals(secret, device.phoneSecretHash)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  if (joined === '/sse/status' && request.method === 'GET') {
    return sseStatus(deviceId, device.phoneSecretHash)
  }

  const url = new URL(request.url)
  const rawBody = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text()
  if (rawBody && rawBody.length > 1_000_000) {
    return json({ error: 'Payload too large' }, 413)
  }

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value
  })

  const jobId = randomId('job')
  await db.insert(rpcJobs).values({
    id: jobId,
    deviceId,
    method: request.method,
    path: joined,
    query: url.searchParams.toString() || null,
    requestHeaders: headers,
    requestBody: rawBody,
    status: 'pending',
  })

  const deadline = Date.now() + 22_000
  while (Date.now() < deadline) {
    const [job] = await db.select().from(rpcJobs).where(and(eq(rpcJobs.id, jobId), eq(rpcJobs.deviceId, deviceId))).limit(1)
    if (job && job.status !== 'pending') {
      if (job.status === 'error') {
        return json({ error: job.error || 'Laptop failed the request' }, 502)
      }
      const responseHeaders = new Headers()
      if (job.responseHeaders) {
        for (const [key, value] of Object.entries(job.responseHeaders)) {
          if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value)
        }
      }
      if (!responseHeaders.has('content-type')) {
        responseHeaders.set('content-type', 'application/json')
      }
      return new Response(job.responseBody ?? '', {
        status: job.responseStatus || 200,
        headers: responseHeaders,
      })
    }
    await sleep(250)
  }

  return json({ error: 'Laptop did not answer in time. Is the bridge running?' }, 504)
}

function sseStatus(deviceId: string, _hash: string) {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const push = async () => {
        if (closed) return
        const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1)
        const payload = device?.lastStatus || { active: [] }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      await push()
      const timer = setInterval(() => {
        void push().catch(() => {})
      }, 1000)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        closed = true
        controller.close()
      }, 25_000)
      return () => {
        closed = true
        clearInterval(timer)
        clearTimeout(timeout)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
