import { and, eq, gt, isNull } from 'drizzle-orm'
import { normalizeCode, randomId, randomSecret, sha256 } from '@/lib/crypto'
import { db } from '@/lib/db'
import { devices, pairingCodes } from '@/lib/db/schema'
import { json, readJson } from '@/lib/http'

export const runtime = 'nodejs'

type ClaimBody = {
  code?: string
  hostname?: string
  platform?: string
}

export async function POST(request: Request) {
  const body = await readJson<ClaimBody>(request)
  const code = normalizeCode(body?.code || '')
  if (!code) return json({ error: 'Invalid pairing code' }, 400)

  const laptopSecret = randomSecret()
  const deviceId = randomId('dev')
  const hostname = (body?.hostname || 'laptop').slice(0, 120)
  const platform = (body?.platform || '').slice(0, 60)

  try {
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(pairingCodes)
        .set({
          claimedAt: new Date(),
          deviceId,
        })
        .where(
          and(
            eq(pairingCodes.code, code),
            isNull(pairingCodes.claimedAt),
            gt(pairingCodes.expiresAt, new Date())
          )
        )
        .returning()

      if (!claimed) {
        throw new Error('UNAVAILABLE')
      }

      await tx.insert(devices).values({
        id: deviceId,
        hostname,
        platform,
        laptopSecretHash: sha256(laptopSecret),
        phoneSecretHash: claimed.phoneSecretHash,
        daemonOk: false,
      })
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAVAILABLE') {
      return json({ error: 'Code expired, already used, or not found' }, 409)
    }
    throw error
  }

  return json({
    deviceId,
    laptopSecret,
    daemonUrl: 'http://127.0.0.1:8473',
  })
}
