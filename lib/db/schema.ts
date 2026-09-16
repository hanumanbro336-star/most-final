import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Better Auth tables. Column names are camelCase to match Better Auth's
// defaults — do not rename them.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
})

export const pairingCodes = pgTable('pairing_codes', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  phoneSecretHash: text('phone_secret_hash').notNull(),
  ipHash: text('ip_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  deviceId: text('device_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  hostname: text('hostname'),
  platform: text('platform'),
  laptopSecretHash: text('laptop_secret_hash').notNull(),
  phoneSecretHash: text('phone_secret_hash').notNull(),
  daemonOk: boolean('daemon_ok').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastStatus: jsonb('last_status').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const rpcJobs = pgTable('rpc_jobs', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  query: text('query'),
  requestHeaders: jsonb('request_headers').$type<Record<string, string> | null>(),
  requestBody: text('request_body'),
  status: text('status').notNull().default('pending'),
  responseStatus: integer('response_status'),
  responseHeaders: jsonb('response_headers').$type<Record<string, string> | null>(),
  responseBody: text('response_body'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})
