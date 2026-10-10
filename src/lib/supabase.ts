import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export type ProxyKey = {
  id: string;
  name: string;
  mode: 'live' | 'mock';
  revoked: boolean;
  created_at: string;
};

export type FiredRule = { rule: string; detail: string; severity: 'block' | 'flag' };

export type EventRow = {
  id: string;
  key_id: string | null;
  stage: 'input' | 'output';
  original_text: string | null;
  redacted_text: string | null;
  jev_request: Record<string, unknown> | null;
  jev_response: Record<string, unknown> | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cost_usd: number | null;
  decision: 'pass' | 'redact' | 'flag' | 'block';
  fired_rules: FiredRule[] | null;
  review_status: 'none' | 'pending' | 'approved' | 'rejected';
  upstream_response: string | null;
  upstream_latency_ms: number | null;
  created_at: string;
};

export type PolicyRow = {
  id: string;
  name: string;
  config: Record<string, number | boolean>;
  active: boolean;
  created_at: string;
};

export async function callAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin', { body: { action, ...payload } });
  if (error) throw new Error(error.message);
  const res = data as T & { error?: string };
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(String(res.error));
  return data as T;
}

export const PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/proxy/v1/chat/completions`;
