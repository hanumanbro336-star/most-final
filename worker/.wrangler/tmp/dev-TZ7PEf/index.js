var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/util.ts
var encoder = new TextEncoder();
var codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
__name(json, "json");
function randomToken(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(values);
}
__name(randomToken, "randomToken");
function randomCode() {
  const values = crypto.getRandomValues(new Uint8Array(9));
  const raw = Array.from(values, (value) => codeAlphabet[value % codeAlphabet.length]).join("");
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`;
}
__name(randomCode, "randomCode");
async function hashSecret(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
__name(hashSecret, "hashSecret");
function safeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return difference === 0;
}
__name(safeEqual, "safeEqual");
function requireProxy(request, env) {
  const provided = request.headers.get("x-forge-proxy-secret") ?? "";
  return Boolean(env.WORKER_PROXY_SECRET) && safeEqual(provided, env.WORKER_PROXY_SECRET);
}
__name(requireProxy, "requireProxy");
async function readJson(request, maxBytes = 1048576) {
  const size = Number(request.headers.get("content-length") ?? "0");
  if (size > maxBytes) throw new HttpError(413, "Request body is too large");
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new HttpError(413, "Request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
__name(readJson, "readJson");
function normalizePath(path) {
  if (!path.startsWith("/") || path.includes("..") || path.length > 2048) {
    throw new HttpError(400, "Invalid RPC path");
  }
  return path;
}
__name(normalizePath, "normalizePath");
async function consumeRateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT window_started_at, count FROM rate_limits WHERE key = ?").bind(key).first();
  if (!row || now - row.window_started_at >= windowMs) {
    await env.DB.prepare("INSERT INTO rate_limits (key, window_started_at, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_started_at = excluded.window_started_at, count = 1").bind(key, now).run();
    return;
  }
  if (row.count >= limit) throw new HttpError(429, "Too many requests");
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
}
__name(consumeRateLimit, "consumeRateLimit");
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
  static {
    __name(this, "HttpError");
  }
};
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64Url, "base64Url");

// src/device-relay.ts
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
var FIRST_BYTE_TIMEOUT_MS = 15e3;
var RPC_LIFETIME_MS = 5 * 6e4;
var MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
var DeviceRelay = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const sockets = this.state.getWebSockets("laptop");
    this.laptop = sockets.at(0) ?? null;
  }
  state;
  env;
  static {
    __name(this, "DeviceRelay");
  }
  laptop = null;
  daemonOnline = false;
  pending = /* @__PURE__ */ new Map();
  async fetch(request) {
    if (request.headers.get("x-forge-authorized") !== this.env.WORKER_PROXY_SECRET) {
      return json({ error: "Unauthorized relay request" }, 401);
    }
    const url = new URL(request.url);
    if (url.pathname.endsWith("/connect")) return this.connectLaptopSocket(request);
    if (url.pathname.endsWith("/status")) {
      return json({
        online: this.laptop?.readyState === WebSocket.OPEN,
        daemonOnline: this.daemonOnline
      });
    }
    if (url.pathname.endsWith("/disconnect") && request.method === "POST") {
      this.laptop?.close(1e3, "Device removed");
      this.laptop = null;
      this.daemonOnline = false;
      this.failAll(new Error("Device removed"));
      return json({ disconnected: true });
    }
    if (url.pathname.endsWith("/rpc") && request.method === "POST") return this.rpc(request);
    return json({ error: "Not found" }, 404);
  }
  webSocketMessage(socket, message) {
    if (socket !== this.laptop) return;
    let payload;
    try {
      payload = JSON.parse(typeof message === "string" ? message : decoder.decode(message));
    } catch {
      socket.close(1003, "Invalid JSON");
      return;
    }
    if (payload.type === "heartbeat") {
      this.daemonOnline = payload.daemonOnline;
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
      return;
    }
    if (!("id" in payload)) return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    if (payload.type === "rpc_start") {
      if (pending.started) return;
      pending.started = true;
      clearTimeout(pending.timeout);
      pending.timeout = setTimeout(() => this.fail(payload.id, new Error("RPC lifetime exceeded")), RPC_LIFETIME_MS);
      const headers = new Headers(payload.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      pending.resolveStart(new Response(pending.stream.readable, { status: payload.status, headers }));
      return;
    }
    if (payload.type === "rpc_chunk") {
      const chunk = decodeBase64(payload.bodyBase64);
      pending.bytes += chunk.byteLength;
      if (pending.bytes > MAX_RESPONSE_BYTES) {
        this.fail(payload.id, new Error("RPC response is too large"));
        return;
      }
      void pending.writer.write(chunk);
      return;
    }
    if (payload.type === "rpc_end") {
      clearTimeout(pending.timeout);
      void pending.writer.close();
      this.pending.delete(payload.id);
      return;
    }
    if (payload.type === "rpc_error") this.fail(payload.id, new Error(payload.message));
  }
  webSocketClose(socket) {
    if (socket === this.laptop) this.laptop = null;
    this.daemonOnline = false;
    this.failAll(new Error("Laptop disconnected"));
  }
  webSocketError(socket) {
    if (socket === this.laptop) this.laptop = null;
    this.daemonOnline = false;
    this.failAll(new Error("Laptop connection failed"));
  }
  connectLaptopSocket(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426);
    }
    this.laptop?.close(1012, "Replaced by a new connection");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, ["laptop"]);
    this.laptop = server;
    return new Response(null, { status: 101, webSocket: client });
  }
  async rpc(request) {
    if (!this.laptop || this.laptop.readyState !== WebSocket.OPEN) {
      return json({ error: "Laptop is offline" }, 503);
    }
    if (this.pending.size >= 16) return json({ error: "Laptop is busy" }, 429);
    let rpc;
    try {
      rpc = await readJson(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      throw error;
    }
    const id = crypto.randomUUID();
    const stream = new TransformStream();
    let resolveStart;
    let rejectStart;
    const response = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const timeout = setTimeout(() => this.fail(id, new Error("Laptop did not respond")), FIRST_BYTE_TIMEOUT_MS);
    this.pending.set(id, {
      stream,
      writer: stream.writable.getWriter(),
      resolveStart,
      rejectStart,
      started: false,
      bytes: 0,
      timeout
    });
    this.laptop.send(JSON.stringify({ type: "rpc_request", id, ...rpc }));
    try {
      return await response;
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "RPC failed" }, 504);
    }
  }
  fail(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    if (pending.started) void pending.writer.abort(error);
    else pending.rejectStart(error);
    this.pending.delete(id);
  }
  failAll(error) {
    for (const id of this.pending.keys()) this.fail(id, error);
  }
};
function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
__name(decodeBase64, "decodeBase64");

// src/index.ts
var PAIR_TTL_MS = 10 * 6e4;
var allowedMethods = /* @__PURE__ */ new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
var forwardedHeaders = /* @__PURE__ */ new Set(["accept", "content-type", "if-none-match", "last-event-id"]);
var src_default = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "forge-relay" });
      }
      if (url.pathname.match(/^\/v1\/devices\/[^/]+\/connect$/)) {
        return connectLaptop(request, env, url);
      }
      if (!requireProxy(request, env)) return json({ error: "Invalid proxy credential" }, 401);
      if (url.pathname === "/v1/pairs" && request.method === "POST") return createPair(request, env);
      if (url.pathname === "/v1/pairs/claim" && request.method === "POST") return claimPair(request, env);
      if (url.pathname === "/v1/pairs/status" && request.method === "GET") return pairStatus(request, env, url);
      const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)(?:\/(rpc))?$/);
      if (deviceMatch) {
        const deviceId = deviceMatch[1];
        if (deviceMatch[2] === "rpc" && request.method === "POST") return proxyRpc(request, env, deviceId);
        if (request.method === "GET") return deviceStatus(request, env, deviceId);
        if (request.method === "DELETE") return removeDevice(request, env, deviceId);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: "Relay request failed" }, 500);
    }
  }
};
async function createPair(request, env) {
  await consumeRateLimit(env, `create:${clientKey(request)}`, 12, 6e4);
  const now = Date.now();
  const expiresAt = now + PAIR_TTL_MS;
  const phoneSecret = randomToken();
  const phoneSecretHash = await hashSecret(phoneSecret);
  let code = randomCode();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const result = await env.DB.prepare("INSERT OR IGNORE INTO pairing_codes (code, phone_secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(code, phoneSecretHash, now, expiresAt).run();
    if (result.meta.changes === 1) {
      return json({ code, phoneSecret, expiresAt: new Date(expiresAt).toISOString() }, 201);
    }
    code = randomCode();
  }
  throw new HttpError(503, "Could not allocate a pairing code");
}
__name(createPair, "createPair");
async function claimPair(request, env) {
  await consumeRateLimit(env, `claim:${clientKey(request)}`, 30, 6e4);
  const body = await readJson(request, 16384);
  const code = normalizeCode(body.code);
  const pair = await env.DB.prepare("SELECT * FROM pairing_codes WHERE code = ?").bind(code).first();
  const now = Date.now();
  if (!pair || pair.expires_at <= now) throw new HttpError(410, "Pairing code expired");
  if (pair.claimed_at || pair.device_id) throw new HttpError(409, "Pairing code was already claimed");
  const deviceId = crypto.randomUUID();
  const deviceToken = randomToken();
  const deviceTokenHash = await hashSecret(deviceToken);
  const name = cleanLabel(body.name, "Forge laptop");
  const platform = cleanLabel(body.platform, "unknown");
  const claim = await env.DB.prepare("UPDATE pairing_codes SET claimed_at = ?, device_id = ? WHERE code = ? AND claimed_at IS NULL AND expires_at > ?").bind(now, deviceId, code, now).run();
  if (claim.meta.changes !== 1) throw new HttpError(409, "Pairing code was already claimed");
  try {
    await env.DB.prepare("INSERT INTO devices (id, name, platform, phone_secret_hash, device_token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(deviceId, name, platform, pair.phone_secret_hash, deviceTokenHash, now).run();
  } catch (error) {
    await env.DB.prepare("UPDATE pairing_codes SET claimed_at = NULL, device_id = NULL WHERE code = ? AND device_id = ?").bind(code, deviceId).run();
    throw error;
  }
  const workerUrl = new URL(request.url);
  workerUrl.protocol = workerUrl.protocol === "https:" ? "wss:" : "ws:";
  workerUrl.pathname = `/v1/devices/${deviceId}/connect`;
  workerUrl.search = `token=${encodeURIComponent(deviceToken)}`;
  return json({ deviceId, deviceToken, workerWebSocketUrl: workerUrl.toString(), name, platform }, 201);
}
__name(claimPair, "claimPair");
async function pairStatus(request, env, url) {
  const code = normalizeCode(url.searchParams.get("code"));
  const phoneSecret = request.headers.get("x-forge-phone-secret") ?? "";
  const pair = await env.DB.prepare("SELECT * FROM pairing_codes WHERE code = ?").bind(code).first();
  if (!pair || !phoneSecret || !safeEqual(await hashSecret(phoneSecret), pair.phone_secret_hash)) {
    throw new HttpError(404, "Pairing session not found");
  }
  if (pair.expires_at <= Date.now() && !pair.device_id) return json({ status: "expired" });
  if (!pair.device_id) return json({ status: "waiting", expiresAt: new Date(pair.expires_at).toISOString() });
  const device = await getAuthorizedDevice(env, pair.device_id, phoneSecret);
  const relay = await relayStatus(env, device.id);
  return json({ status: relay.online ? "online" : "claimed", device: publicDevice(device, relay) });
}
__name(pairStatus, "pairStatus");
async function deviceStatus(request, env, deviceId) {
  const device = await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request));
  const relay = await relayStatus(env, device.id);
  return json({ device: publicDevice(device, relay) });
}
__name(deviceStatus, "deviceStatus");
async function removeDevice(request, env, deviceId) {
  await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request));
  await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(Date.now(), deviceId).run();
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId));
  await stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/disconnect`, env, { method: "POST" }));
  return json({ removed: true });
}
__name(removeDevice, "removeDevice");
async function connectLaptop(request, env, url) {
  const deviceId = url.pathname.split("/")[3];
  const token = url.searchParams.get("token") ?? "";
  const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").bind(deviceId).first();
  if (!device || !token || !safeEqual(await hashSecret(token), device.device_token_hash)) {
    return json({ error: "Invalid device credential" }, 401);
  }
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), deviceId).run();
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId));
  return stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/connect`, env, request));
}
__name(connectLaptop, "connectLaptop");
async function proxyRpc(request, env, deviceId) {
  await getAuthorizedDevice(env, deviceId, phoneSecretFrom(request));
  await consumeRateLimit(env, `rpc:${deviceId}`, 240, 6e4);
  const body = await readJson(request);
  const method = body.method?.toUpperCase();
  if (!allowedMethods.has(method)) throw new HttpError(400, "Unsupported RPC method");
  const path = normalizePath(body.path);
  const headers = {};
  for (const [name, value] of Object.entries(body.headers ?? {})) {
    if (forwardedHeaders.has(name.toLowerCase()) && value.length <= 8192) headers[name.toLowerCase()] = value;
  }
  if (body.bodyBase64 && body.bodyBase64.length > 14e5) throw new HttpError(413, "RPC body is too large");
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId));
  return stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/rpc`, env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, path, headers, bodyBase64: body.bodyBase64 })
  }));
}
__name(proxyRpc, "proxyRpc");
async function getAuthorizedDevice(env, deviceId, phoneSecret) {
  const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").bind(deviceId).first();
  if (!device || !phoneSecret || !safeEqual(await hashSecret(phoneSecret), device.phone_secret_hash)) {
    throw new HttpError(404, "Device not found");
  }
  return device;
}
__name(getAuthorizedDevice, "getAuthorizedDevice");
async function relayStatus(env, deviceId) {
  const stub = env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(deviceId));
  const response = await stub.fetch(authorizedRelayRequest(`https://relay.internal/${deviceId}/status`, env));
  return response.json();
}
__name(relayStatus, "relayStatus");
function authorizedRelayRequest(input, env, init) {
  const headers = new Headers(init instanceof Request ? init.headers : init?.headers);
  headers.set("x-forge-authorized", env.WORKER_PROXY_SECRET);
  if (init instanceof Request) return new Request(input, { method: init.method, headers });
  return new Request(input, { ...init, headers });
}
__name(authorizedRelayRequest, "authorizedRelayRequest");
function publicDevice(device, relay) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    online: relay.online,
    daemonOnline: relay.daemonOnline,
    createdAt: new Date(device.created_at).toISOString(),
    lastSeenAt: device.last_seen_at ? new Date(device.last_seen_at).toISOString() : null
  };
}
__name(publicDevice, "publicDevice");
function phoneSecretFrom(request) {
  return request.headers.get("x-forge-phone-secret") ?? "";
}
__name(phoneSecretFrom, "phoneSecretFrom");
function normalizeCode(value) {
  const code = (value ?? "").trim().toUpperCase();
  if (!/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code)) throw new HttpError(400, "Invalid pairing code");
  return code;
}
__name(normalizeCode, "normalizeCode");
function cleanLabel(value, fallback) {
  const clean = (value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  return clean || fallback;
}
__name(cleanLabel, "cleanLabel");
function clientKey(request) {
  return request.headers.get("cf-connecting-ip") ?? "proxy";
}
__name(clientKey, "clientKey");

// ../node_modules/.pnpm/wrangler@4.131.2_@cloudflare+workers-types@5.20260915.1_@types+node@24.10.4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/.pnpm/wrangler@4.131.2_@cloudflare+workers-types@5.20260915.1_@types+node@24.10.4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-2gixfZ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../node_modules/.pnpm/wrangler@4.131.2_@cloudflare+workers-types@5.20260915.1_@types+node@24.10.4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-2gixfZ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  DeviceRelay,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
