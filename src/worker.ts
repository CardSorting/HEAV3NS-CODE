/// <reference path="./worker-configuration.d.ts" />
/**
 * LUMI-NEW: Cloudflare Edge Worker & Multi-Token Round-Robin Gateway
 *
 * Runs on Cloudflare Anycast Global Edge:
 * 1. Multi-Token Smooth Weighted Round-Robin (SWRR) with quota guard for HTTP/SSE keys.
 * 2. Session-sticky routing within a Worker isolate.
 * 3. OpenAI-compatible HTTP/SSE transport projection.
 * 4. Single-Flight Reactive OAuth Refresh & 429 Failover.
 * 5. Dynamic Runtime Ingestion API (/v1/tokens/ingest).
 *
 * ARCHITECTURAL BOUNDARY:
 * Serverless V8 isolates in Cloudflare Workers provide the HTTP/SSE transport used by this gateway.
 * Persistent bidirectional Codex WebSockets are outside this worker's scope.
 */

import { SmoothWeightedPool, type PooledTokenAccount } from './agents/extensions/credential/smooth-weighted-pool.js';

declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

interface WorkerEnv extends Env {
  LUMI_ADMIN_SECRET?: string;
  OPENAI_API_KEY?: string;
  RELEASES_BUCKET?: R2Bucket;
}

interface JsonRecord {
  [key: string]: unknown;
}

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPSTREAM_ERROR_BYTES = 16 * 1024;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_CREDENTIAL_RECORDS = 1_000;

// This pool is an isolate-local routing projection. KV is the durable credential
// registry; neither structure is an authoritative distributed quota ledger.
const globalPool = new SmoothWeightedPool();
let poolInitialization: Promise<void> | undefined;

// Single-flight refresh lock to coalesce concurrent OAuth refreshes
const refreshInFlightMap = new Map<string, Promise<string | null>>();

function logEvent(level: 'info' | 'warn' | 'error', event: string, details: JsonRecord = {}): void {
  const entry = JSON.stringify({ level, event, ...details });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

function corsHeaders(request: Request, env: WorkerEnv): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const requestOrigin = request.headers.get('Origin');
  const allowedOrigin = env.CORS_ALLOWED_ORIGIN?.trim();
  if (allowedOrigin && requestOrigin && requestOrigin === allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', requestOrigin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function jsonResponse(
  request: Request,
  env: WorkerEnv,
  payload: unknown,
  status = 200,
  extraHeaders?: HeadersInit
): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

async function timingSafeSecretEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
}

async function requireAdmin(request: Request, env: WorkerEnv): Promise<Response | undefined> {
  const expected = env.LUMI_ADMIN_SECRET;
  if (!expected) {
    logEvent('error', 'admin_auth_not_configured');
    return jsonResponse(request, env, { error: 'Gateway administration is unavailable' }, 503);
  }

  const provided = request.headers.get('X-Lumi-Admin-Secret');
  if (!provided || !(await timingSafeSecretEqual(provided, expected))) {
    return jsonResponse(
      request,
      env,
      { error: 'Unauthorized' },
      401,
      { 'WWW-Authenticate': 'LumiAdmin realm="lumi-edge"' }
    );
  }
}

async function readBoundedJson(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<JsonRecord> {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RangeError('Request body exceeds the configured limit');
  }
  if (!request.body) throw new SyntaxError('Request body is required');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('request body limit exceeded');
      throw new RangeError('Request body exceeds the configured limit');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('JSON body must be an object');
  }
  return parsed as JsonRecord;
}

async function readBoundedText(response: Response, maxBytes = MAX_UPSTREAM_ERROR_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remainingBytes = maxBytes - totalBytes;
    if (value.byteLength > remainingBytes) {
      text += decoder.decode(value.subarray(0, remainingBytes), { stream: false });
      await reader.cancel('response body limit exceeded');
      return text;
    }
    totalBytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

async function initializePool(env: WorkerEnv): Promise<void> {
  if (env.OPENAI_API_KEY && !globalPool.getAccount('root_env_openai_key')) {
    globalPool.addTokenAccount({
      id: 'root_env_openai_key',
      accessToken: env.OPENAI_API_KEY,
      weight: 1,
      priority: 5,
    });
  }

  let cursor: string | undefined;
  let loaded = 0;
  let skipped = 0;
  do {
    const page = await env.TOKEN_POOL_KV.list({ prefix: 'token:', cursor });
    for (const key of page.keys) {
      if (loaded + skipped >= MAX_CREDENTIAL_RECORDS) {
        throw new RangeError('Credential registry exceeds the configured record limit');
      }
      const raw = await env.TOKEN_POOL_KV.get<JsonRecord>(key.name, 'json');
      if (raw) {
        const token = raw.accessToken ?? raw.access_token;
        if (typeof token === 'string') {
          try {
            globalPool.addTokenAccount({
              ...raw,
              accessToken: token,
            } as Parameters<SmoothWeightedPool['addTokenAccount']>[0]);
            loaded += 1;
          } catch {
            skipped += 1;
          }
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  logEvent('info', 'credential_pool_initialized', { loaded, skipped });
}

async function syncFromKv(env: WorkerEnv): Promise<void> {
  if (!poolInitialization) {
    poolInitialization = initializePool(env).catch((error: unknown) => {
      poolInitialization = undefined;
      throw error;
    });
  }
  await poolInitialization;
}

async function refreshCodexToken(
  refreshToken: string,
  clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as { access_token: string; refresh_token?: string };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

async function refreshAccountToken(account: PooledTokenAccount, env: WorkerEnv): Promise<string | null> {
  if (!account.refreshToken) return null;
  let refreshPromise = refreshInFlightMap.get(account.id);
  if (!refreshPromise) {
    const refreshToken = account.refreshToken;
    refreshPromise = (async () => {
      const refreshed = await refreshCodexToken(refreshToken);
      if (!refreshed) return null;
      globalPool.updateRefreshedTokens(account.id, refreshed.accessToken, refreshed.refreshToken);
      await env.TOKEN_POOL_KV.put(
        `token:${account.id}`,
        JSON.stringify({
          ...account,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? refreshToken,
        })
      );
      return refreshed.accessToken;
    })();
    refreshInFlightMap.set(account.id, refreshPromise);
  }

  try {
    return await refreshPromise;
  } finally {
    if (refreshInFlightMap.get(account.id) === refreshPromise) {
      refreshInFlightMap.delete(account.id);
    }
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      await syncFromKv(env);
    } catch (error: unknown) {
      logEvent('error', 'credential_pool_initialization_failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonResponse(request, env, { error: 'Credential registry is temporarily unavailable' }, 503);
    }

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const headers = corsHeaders(request, env);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Lumi-Admin-Secret, X-Session-Id, X-Shard-Id'
      );
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    if (url.pathname === '/health' || url.pathname === '/ping') {
      if (request.method !== 'GET') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'GET' });
      }
      const accounts = globalPool.listAccounts();
      return jsonResponse(request, env, {
        status: 'healthy',
        environment: env.ENVIRONMENT,
        timestamp: Date.now(),
        fleet: {
          totalRegistered: accounts.length,
          activeHealthy: accounts.filter((account) =>
            account.status === 'healthy' || account.status === 'soft_draining'
          ).length,
          inCooldown: accounts.filter((account) => account.status === 'cooldown').length,
          exhausted: accounts.filter((account) => account.status === 'exhausted').length,
        }
      });
    }

    if (url.pathname === '/download' || url.pathname === '/download/dmg' || url.pathname === '/releases/latest.dmg') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      return Response.redirect('https://releases.heav3ns.com/HEAV3NS-CODE-latest.dmg', 302);
    }

    if (url.pathname === '/download/zip' || url.pathname === '/releases/latest.zip') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      return Response.redirect('https://releases.heav3ns.com/HEAV3NS-CODE-v0.1.0-macOS-arm64.zip', 302);
    }

    if (url.pathname.startsWith('/releases/')) {
      const fileKey = url.pathname.slice('/releases/'.length);
      if (fileKey && !fileKey.includes('..') && /^[A-Za-z0-9._-]+$/.test(fileKey)) {
        if (env.RELEASES_BUCKET) {
          const object = await env.RELEASES_BUCKET.get(fileKey);
          if (object) {
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Cache-Control', 'public, max-age=14400');
            if (fileKey.endsWith('.dmg')) headers.set('Content-Type', 'application/x-apple-diskimage');
            if (fileKey.endsWith('.zip')) headers.set('Content-Type', 'application/zip');
            if (fileKey.endsWith('.xml')) headers.set('Content-Type', 'application/xml');
            if (fileKey.endsWith('.json')) headers.set('Content-Type', 'application/json');
            return new Response(object.body, { headers });
          }
        }
        return Response.redirect(`https://releases.heav3ns.com/${fileKey}`, 302);
      }
    }

    const protectedRoute =
      url.pathname.startsWith('/v1/tokens/') ||
      url.pathname.startsWith('/v1/debug/') ||
      url.pathname === '/v1/chat/completions';
    if (protectedRoute) {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) return unauthorized;
    }

    if (url.pathname === '/v1/tokens/status') {
      if (request.method !== 'GET') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'GET' });
      }
      const accounts = globalPool.listAccounts().map((account) => ({
        id: account.id,
        status: account.status,
        baseWeight: account.baseWeight,
        effectiveWeight: account.effectiveWeight,
        currentWeight: account.currentWeight,
        totalRequestsServed: account.totalRequestsServed,
        totalTokensConsumed: account.totalTokensConsumed,
        recentRequestsInWindow: account.requestHistoryTimestampsMs.length,
        maxRequestsPerWindow: account.maxRequestsPerWindow,
        tokenBucket: {
          remainingTokens: account.tokenBucket.remainingTokens,
          remainingRequests: account.tokenBucket.remainingRequests,
        },
        cooldownRemainingMs:
          account.cooldownUntilTimestampMs && account.cooldownUntilTimestampMs > Date.now()
            ? account.cooldownUntilTimestampMs - Date.now()
            : 0,
      }));
      return jsonResponse(request, env, { tokens: accounts, count: accounts.length });
    }

    if (url.pathname === '/v1/tokens/reset-cooldown') {
      if (request.method !== 'POST') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'POST' });
      }
      const resetCount = globalPool.resetAllCooldowns();
      return jsonResponse(request, env, { success: true, resetCount });
    }

    if (url.pathname === '/v1/debug/probe-ws') {
      return jsonResponse(request, env, {
        error: {
          message: 'WebSocket probing is not supported by the Cloudflare Edge Worker. Use the HTTP/SSE gateway endpoint.',
          type: 'unsupported_operation_error'
        }
      }, 410);
    }

    if (url.pathname === '/v1/tokens/ingest') {
      if (request.method !== 'POST') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'POST' });
      }
      try {
        const body = await readBoundedJson(request);
        const account = globalPool.addTokenAccount(
          body as unknown as Parameters<SmoothWeightedPool['addTokenAccount']>[0]
        );
        await env.TOKEN_POOL_KV.put(`token:${account.id}`, JSON.stringify({
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          accountId: account.accountId,
          email: account.email,
          weight: account.baseWeight,
          priority: account.priority,
          maxRequestsPerWindow: account.maxRequestsPerWindow,
          windowDurationHours: account.windowDurationMs / 3_600_000,
          maxTokensPerMinute: account.tokenBucket.maxTokens,
          maxRequestsPerMinute: account.tokenBucket.maxRequests,
        }));
        return jsonResponse(request, env, {
          success: true,
          token: { id: account.id, status: account.status, weight: account.baseWeight },
        });
      } catch (error: unknown) {
        const status = error instanceof RangeError ? 413 : 400;
        return jsonResponse(request, env, {
          error: error instanceof Error ? error.message : 'Invalid token record',
        }, status);
      }
    }

    if (url.pathname.startsWith('/v1/tokens/remove/')) {
      if (request.method !== 'DELETE') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'DELETE' });
      }
      const idToRemove = decodeURIComponent(url.pathname.slice('/v1/tokens/remove/'.length));
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idToRemove)) {
        return jsonResponse(request, env, { error: 'Invalid token id' }, 400);
      }
      const removed = globalPool.removeTokenAccount(idToRemove);
      await env.TOKEN_POOL_KV.delete(`token:${idToRemove}`);
      return jsonResponse(request, env, { success: removed, id: idToRemove });
    }

    if (url.pathname === '/v1/chat/completions') {
      if (request.method !== 'POST') {
        return jsonResponse(request, env, { error: 'Method not allowed' }, 405, { Allow: 'POST' });
      }
      let body: JsonRecord;
      try {
        body = await readBoundedJson(request);
      } catch (error: unknown) {
        const status = error instanceof RangeError ? 413 : 400;
        return jsonResponse(request, env, {
          error: { message: error instanceof Error ? error.message : 'Invalid JSON payload', type: 'invalid_request_error' },
        }, status);
      }

      const sessionId =
        optionalString(request.headers.get('x-session-id'), MAX_SESSION_ID_LENGTH) ??
        optionalString(body.conversation_id, MAX_SESSION_ID_LENGTH) ??
        optionalString(body.session_id, MAX_SESSION_ID_LENGTH);

      const requestedShardId = request.headers.get('x-shard-id');
      const incomingShardId = requestedShardId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestedShardId)
        ? requestedShardId
        : undefined;
      const authHeader = request.headers.get('Authorization');
      const incomingToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : undefined;
      const incomingAccountId =
        optionalString(request.headers.get('ChatGPT-Account-Id'), 256) ??
        optionalString(request.headers.get('OpenAI-Account'), 256);

      const maxRetries = Math.min(8, Math.max(1, globalPool.listAccounts().length + (incomingToken ? 1 : 0)));
      let lastFailure = 'No eligible credential was available';

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let account: PooledTokenAccount | undefined;
        let sticky = false;
        let activeFleetSize = globalPool.listAccounts().length;

        if (attempt === 1 && incomingShardId) {
          const targeted = globalPool.getAccount(incomingShardId);
          if (targeted && (targeted.status === 'healthy' || targeted.status === 'soft_draining')) {
            account = targeted;
          }
        }

        if (!account) {
          const selection = globalPool.selectAccount(sessionId, 100);
          account = selection.account;
          sticky = selection.sticky;
          activeFleetSize = selection.activeFleetSize;
          if (!account) {
            lastFailure = selection.reason ?? lastFailure;
          }
        }

        // An explicit bearer token is request-scoped only. Durable enrollment is
        // restricted to /v1/tokens/ingest and never happens as a chat side effect.
        if (!account && attempt === 1) {
          if (incomingToken && incomingToken.length > 20 && incomingToken.length <= 32_768) {
            account = {
              id: `edge_gateway_${crypto.randomUUID()}`,
              accessToken: incomingToken,
              accountId: incomingAccountId,
              baseWeight: 1,
              effectiveWeight: 1,
              currentWeight: 0,
              priority: 10,
              status: 'healthy',
              consecutiveFailures: 0,
              consecutiveCanaryPasses: 0,
              totalRequestsServed: 0,
              totalTokensConsumed: 0,
              maxRequestsPerWindow: 40,
              windowDurationMs: 3 * 3600 * 1000,
              requestHistoryTimestampsMs: [],
              tokenBucket: {
                maxTokens: 200000,
                remainingTokens: 200000,
                refillRatePerMinute: 200000,
                maxRequests: 500,
                remainingRequests: 500,
                lastRefillTimestampMs: Date.now(),
              },
              createdTimestampMs: Date.now(),
            };
          }
        }

        if (!account) {
          break;
        }

        const isChatGptSession =
          account.accessToken.startsWith('eyJ') ||
          !!account.accountId ||
          (account as PooledTokenAccount & { auth_mode?: string }).auth_mode === 'chatgpt';

        if (isChatGptSession) {
          logEvent('warn', 'chatgpt_session_incompatible_with_edge_worker', { accountId: account.id });
          return jsonResponse(request, env, {
            error: {
              message: 'ChatGPT Codex OAuth session tokens require a persistent WebSocket transport that this HTTP worker does not provide.',
              type: 'unsupported_transport_error',
              code: 'use_persistent_transport_required'
            }
          }, 400);
        }

        const upstreamUrl = env.DEFAULT_UPSTREAM_URL || 'https://api.openai.com/v1/chat/completions';

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${account.accessToken}`,
          'User-Agent': 'Codex-CLI/0.147.0 (darwin; arm64)',
          'X-Codex-Originator': 'codex_cli',
          Accept: body.stream ? 'text/event-stream' : 'application/json',
          'X-Zero-Data-Retention': 'true',
        };

        if (account.accountId) {
          headers['ChatGPT-Account-Id'] = account.accountId;
          headers['OpenAI-Account'] = account.accountId;
        }

        try {
          let upstreamResp = await fetch(upstreamUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });

          if (upstreamResp.status === 401 && account.refreshToken) {
            const newAccessToken = await refreshAccountToken(account, env);
            if (newAccessToken) {
              if (upstreamResp.body) await upstreamResp.body.cancel();
              headers.Authorization = `Bearer ${newAccessToken}`;
              upstreamResp = await fetch(upstreamUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
              });
            }
          }

          if (upstreamResp.status === 401) {
            const errorText = await readBoundedText(upstreamResp);
            const failure = globalPool.recordFailure(account.id, 401, errorText);
            if (failure.newStatus === 'dead') {
              ctx.waitUntil(env.TOKEN_POOL_KV.delete(`token:${account.id}`));
            }
            lastFailure = 'Upstream authorization failed';
            continue;
          }

          if (upstreamResp.status === 429) {
            const errorText = await readBoundedText(upstreamResp);
            const retryAfterHeader = upstreamResp.headers.get('retry-after');
            const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 30;
            const retryAfterSeconds = Number.isFinite(parsedRetryAfter) ? Math.min(3600, Math.max(1, parsedRetryAfter)) : 30;
            globalPool.recordFailure(account.id, 429, errorText, retryAfterSeconds);
            lastFailure = 'Upstream rate limit reached';
            continue;
          }

          if (upstreamResp.ok) {
            globalPool.recordSuccess(account.id);
            globalPool.recordUsage(account.id, 50, Date.now(), sessionId);
            return wrapResponse(upstreamResp, account, sticky, activeFleetSize, Boolean(body.stream), request, env);
          }

          const errorBody = await readBoundedText(upstreamResp);
          const responseHeaders = corsHeaders(request, env);
          responseHeaders.set('Content-Type', upstreamResp.headers.get('content-type') || 'application/json');
          responseHeaders.set('X-Lumi-Shard-Id', account.id);
          return new Response(errorBody, {
            status: upstreamResp.status,
            headers: responseHeaders,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Upstream request failed';
          lastFailure = 'Upstream request failed';
          globalPool.recordFailure(account.id, 500, message);
        }
      }

      return jsonResponse(request, env, {
        error: { message: lastFailure, type: 'api_error' },
      }, lastFailure.includes('rate limit') || lastFailure.includes('eligible') ? 429 : 502, {
        'Retry-After': '30',
      });
    }

    return jsonResponse(request, env, { error: 'Endpoint not found' }, 404);
  },
};

function wrapResponse(
  resp: Response,
  account: PooledTokenAccount,
  sticky: boolean,
  fleetSize: number,
  isStream: boolean,
  req: Request,
  env: WorkerEnv
): Response {
  const headers = new Headers(resp.headers);
  corsHeaders(req, env).forEach((value, key) => headers.set(key, value));
  headers.set('X-Lumi-Shard-Id', account.id);
  headers.set('X-Lumi-Session-Sticky', String(sticky));
  headers.set('X-Lumi-Fleet-Size', String(fleetSize));
  headers.set('X-Lumi-Governor', 'swrr-v1');

  if (isStream) {
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('Cache-Control', 'no-cache, no-transform');
  }

  return new Response(resp.body, {
    status: resp.status,
    headers,
  });
}
