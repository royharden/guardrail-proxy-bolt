// Shared helpers: Supabase service client, CORS, usage limits, request limits, admin + key auth.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, X-Admin-Token, X-Proxy-Key',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export const serviceUnavailable = () => json({ error: 'service_unavailable' }, 503);

// Service-role client built only from env; null (callers answer 503) if either var is missing.
export function supabaseAdmin(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- Request limits ----

export const LIMITS = {
  proxyBodyBytes: 256 * 1024,
  screenBodyBytes: 64 * 1024,
  adminBodyBytes: 16 * 1024,
  maxMessages: 50,
  maxMessageChars: 8000,
};

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

// Reads a JSON object body, rejecting anything over maxBytes with 413 before it is buffered.
export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const tooLarge = (): BodyResult => ({ ok: false, response: json({ error: 'payload_too_large', max_bytes: maxBytes }, 413) });
  const invalid = (): BodyResult => ({ ok: false, response: json({ error: 'invalid_json' }, 400) });

  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!req.body) return invalid();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
  return { ok: true, body: parsed as Record<string, unknown> };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ---- Daily caps ----

const DEFAULT_DAILY_LIMIT = 200;
export const PER_KEY_DAILY_LIMIT = 50;
// Counter for every paid upstream fetch (Jev or OpenAI), across all functions.
export const UPSTREAM_COUNTER = 'upstream';
// Counter for screen requests, so the screen function can't log unbounded events.
export const SCREEN_COUNTER = 'screen';

export function getDailyLimit(): number {
  const v = Deno.env.get('DAILY_CALL_LIMIT')?.trim();
  return v && /^\d+$/.test(v) ? parseInt(v, 10) : DEFAULT_DAILY_LIMIT;
}

export type CapReason = 'daily_limit' | 'unavailable';
export type CapResult = { ok: true; calls: number } | { ok: false; reason: CapReason };

// Atomically increments today's counter via increment_usage() (service role only).
// Fails closed: an RPC error or a null / non-integer result is never treated as OK.
export async function consumeQuota(sb: SupabaseClient, fn: string, limit: number): Promise<CapResult> {
  try {
    const { data, error } = await sb.rpc('increment_usage', { p_fn: fn });
    if (error) {
      console.error(`increment_usage(${fn}) failed:`, error.message);
      return { ok: false, reason: 'unavailable' };
    }
    if (typeof data !== 'number' || !Number.isInteger(data)) {
      console.error(`increment_usage(${fn}) returned a non-integer:`, data);
      return { ok: false, reason: 'unavailable' };
    }
    return data <= limit ? { ok: true, calls: data } : { ok: false, reason: 'daily_limit' };
  } catch (e) {
    console.error(`increment_usage(${fn}) threw:`, e instanceof Error ? e.message : String(e));
    return { ok: false, reason: 'unavailable' };
  }
}

// Returns a callback that counts one paid upstream fetch against the global daily cap.
// Call it right before every fetch, including retries.
export function upstreamQuota(sb: SupabaseClient): () => Promise<CapResult> {
  const limit = getDailyLimit();
  return () => consumeQuota(sb, UPSTREAM_COUNTER, limit);
}

export function capFailure(reason: CapReason) {
  return reason === 'daily_limit' ? json({ error: 'daily_limit' }, 429) : serviceUnavailable();
}

// ---- Auth ----

async function sha256Bytes(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

export async function sha256Hex(input: string): Promise<string> {
  return Array.from(await sha256Bytes(input)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Every admin action requires the ADMIN_TOKEN secret in the x-admin-token header.
// Returns an error response, or null when the caller is allowed through.
export async function requireAdmin(req: Request): Promise<Response | null> {
  const expected = Deno.env.get('ADMIN_TOKEN');
  if (!expected) {
    console.error('ADMIN_TOKEN is not set; admin actions are disabled');
    return json({ error: 'admin_not_configured' }, 503);
  }
  const given = req.headers.get('x-admin-token') ?? '';
  if (!given || !(await timingSafeEqual(given, expected))) return json({ error: 'unauthorized' }, 401);
  return null;
}

export function generateProxyKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `gp_${hex}`;
}

export const PROXY_KEY_RE = /^gp_[0-9a-f]{48}$/;
