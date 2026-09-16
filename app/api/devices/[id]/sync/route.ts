import { and, asc, eq } from 'drizzle-orm'
import { bearerToken, hashEquals, sleep } from '@/lib/crypto'
import { db } from '@/lib/db'
import { devices, rpcJobs } from '@/lib/db/schema'
import { json, readJson } from '@/lib/http'

export const runtime = 'nodejs'
export const maxDuration = 30

type RpcResult = {
  id?: string
  status?: string
  responseStatus?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  error?: string
}

type SyncBody = {
  daemonOk?: boolean
  status?: Record<string, unknown>
  results?: RpcResult[]
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const secret = bearerToken(request)
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  if (!device || !secret || !hashEquals(secret, device.laptopSecretHash)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const body = (await readJson<SyncBody>(request)) || {}

  if (Array.isArray(body.results)) {
    for (const result of body.results) {
      if (!result?.id) continue
      await db
        .update(rpcJobs)
        .set({
          status: result.error ? 'error' : 'done',
          responseStatus: result.responseStatus ?? null,
          responseHeaders: result.responseHeaders ?? null,
          responseBody: result.responseBody ?? null,
          error: result.error ?? null,
          completedAt: new Date(),
        })
        .where(and(eq(rpcJobs.id, result.id), eq(rpcJobs.deviceId, id)))
    }
  }

  await db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      daemonOk: Boolean(body.daemonOk),
      lastStatus: body.status ?? device.lastStatus,
    })
    .where(eq(devices.id, id))

  const deadline = Date.now() + 15_000
  let jobs = await pendingJobs(id)
  while (jobs.length === 0 && Date.now() < deadline) {
    await sleep(400)
    jobs = await pendingJobs(id)
  }

  return json({
    jobs: jobs.map((job) => ({
      id: job.id,
      method: job.method,
      path: job.path,
      query: job.query,
      headers: job.requestHeaders,
      body: job.requestBody,
    })),
  })
}

function pendingJobs(deviceId: string) {
  return db
    .select()
    .from(rpcJobs)
    .where(and(eq(rpcJobs.deviceId, deviceId), eq(rpcJobs.status, 'pending')))
    .orderBy(asc(rpcJobs.createdAt))
    .limit(8)
}
