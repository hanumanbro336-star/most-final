import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function hashEquals(secret: string, hash: string) {
  const left = Buffer.from(sha256(secret))
  const right = Buffer.from(hash)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function randomId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export function randomSecret() {
  return randomBytes(32).toString('hex')
}

export function randomCode() {
  const bytes = randomBytes(8)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte & 31]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

export function normalizeCode(code: string) {
  const cleaned = code
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
  if (cleaned.length !== 8) return ''
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

export function bearerToken(request: Request) {
  const header = request.headers.get('authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  const token = request.headers.get('x-auth-token')
  if (token) return token.trim()
  return new URL(request.url).searchParams.get('token')?.trim() || ''
}

export function clientIpHash(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || ''
  const ip = forwarded.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
  return sha256(ip)
}

export function publicOrigin(request: Request) {
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host') ||
    new URL(request.url).host
  return `${proto}://${host}`
}

export function isOnline(lastSeenAt: Date | null | undefined) {
  if (!lastSeenAt) return false
  return Date.now() - lastSeenAt.getTime() < 12_000
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
