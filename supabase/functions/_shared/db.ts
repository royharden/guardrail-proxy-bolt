// Shared helpers: Supabase service client, CORS, usage limits, key auth.

import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function supabaseAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

export async function getDailyLimit(): Promise<number> {
  const v = Deno.env.get('DAILY_CALL_LIMIT');
  return v ? parseInt(v, 10) : 200;
}

export type LimitResult = { allowed: boolean; calls: number; limit: number; error?: string };

// Read-modify-write increment; returns allowed=false once past the limit.
export async function checkAndIncrementUsage(fn: string, limit: number): Promise<LimitResult> {
  const sb = supabaseAdmin();
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('usage_counters')
    .select('calls')
    .eq('day', day)
    .eq('fn', fn)
    .maybeSingle();
  if (error) return { allowed: false, calls: 0, limit, error: error.message };
  const calls = (data?.calls ?? 0) + 1;
  const { error: upErr } = await sb
    .from('usage_counters')
    .upsert({ day, fn, calls }, { onConflict: 'day,fn' });
  if (upErr) return { allowed: false, calls: 0, limit, error: upErr.message };
  return { allowed: calls <= limit, calls, limit };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateProxyKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `gp_${hex}`;
}
