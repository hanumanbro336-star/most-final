import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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
