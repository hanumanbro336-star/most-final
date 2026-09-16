import { eq } from 'drizzle-orm'
import { bearerToken, hashEquals, isOnline } from '@/lib/crypto'
import { db } from '@/lib/db'
import { devices } from '@/lib/db/schema'
import { json } from '@/lib/http'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const secret = bearerToken(request)
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  if (!device || !secret || !hashEquals(secret, device.phoneSecretHash)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  return json({
    deviceId: device.id,
    hostname: device.hostname,
    platform: device.platform,
    daemonOk: device.daemonOk,
    online: isOnline(device.lastSeenAt),
    lastSeenAt: device.lastSeenAt?.toISOString() || null,
  })
}
