import { and, count, eq, gt } from 'drizzle-orm'
import {
  bearerToken,
  clientIpHash,
  hashEquals,
  isOnline,
  normalizeCode,
  randomCode,
  randomId,
  randomSecret,
  sha256,
} from '@/lib/crypto'
import { db } from '@/lib/db'
import { devices, pairingCodes } from '@/lib/db/schema'
import { json } from '@/lib/http'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const ipHash = clientIpHash(request)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [usage] = await db
    .select({ n: count() })
    .from(pairingCodes)
    .where(and(eq(pairingCodes.ipHash, ipHash), gt(pairingCodes.createdAt, hourAgo)))

  if ((usage?.n || 0) >= 20) {
    return json({ error: 'Too many pairing codes from this network. Try again later.' }, 429)
  }

  const code = randomCode()
  const phoneSecret = randomSecret()
  const id = randomId('pair')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await db.insert(pairingCodes).values({
    id,
    code,
    phoneSecretHash: sha256(phoneSecret),
    ipHash,
    expiresAt,
  })

  return json({
    code,
    phoneSecret,
    expiresAt: expiresAt.toISOString(),
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = normalizeCode(url.searchParams.get('code') || '')
  const secret = bearerToken(request)

  if (!code || !secret) {
    return json({ error: 'code and phoneSecret required' }, 400)
  }

  const [row] = await db.select().from(pairingCodes).where(eq(pairingCodes.code, code)).limit(1)
  if (!row || !hashEquals(secret, row.phoneSecretHash)) {
    return json({ error: 'Unknown pairing code' }, 404)
  }

  if (row.expiresAt.getTime() < Date.now() && !row.claimedAt) {
    return json({ status: 'expired' })
  }

  if (!row.claimedAt || !row.deviceId) {
    return json({ status: 'waiting', expiresAt: row.expiresAt.toISOString() })
  }

  const [device] = await db.select().from(devices).where(eq(devices.id, row.deviceId)).limit(1)

  return json({
    status: device && isOnline(device.lastSeenAt) ? 'online' : 'claimed',
    deviceId: row.deviceId,
    hostname: device?.hostname || null,
    platform: device?.platform || null,
    daemonOk: device?.daemonOk || false,
    lastSeenAt: device?.lastSeenAt?.toISOString() || null,
  })
}
