export interface Env {
  DB: D1Database
  DEVICE_RELAY: DurableObjectNamespace
  WORKER_PROXY_SECRET: string
}

export interface DeviceRow {
  id: string
  name: string
  platform: string
  phone_secret_hash: string
  device_token_hash: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

export interface PairingRow {
  code: string
  phone_secret_hash: string
  created_at: number
  expires_at: number
  claimed_at: number | null
  device_id: string | null
}

export interface RpcRequest {
  method: string
  path: string
  headers?: Record<string, string>
  bodyBase64?: string
}

export type LaptopMessage =
  | { type: 'heartbeat'; daemonOnline: boolean }
  | { type: 'rpc_start'; id: string; status: number; headers?: Record<string, string> }
  | { type: 'rpc_chunk'; id: string; bodyBase64: string }
  | { type: 'rpc_end'; id: string }
  | { type: 'rpc_error'; id: string; message: string }
