import { createClient, FunctionsHttpError } from '@supabase/supabase-js';

export const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  SUPABASE_ANON_KEY,
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

export type UsageResponse = { limit: number; calls: number; counters: { fn: string; calls: number }[] };

// Pulls the { error } message out of a non-2xx Edge Function response.
export async function functionErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await (error.context as Response).clone().json();
      if (body && typeof body.error === 'string') return body.error;
    } catch {
      /* not JSON */
    }
  }
  return error instanceof Error ? error.message : 'Request failed';
}

// Admin actions need the ADMIN_TOKEN secret. Ask once, keep it in sessionStorage for this tab.
const ADMIN_TOKEN_KEY = 'guardrail-admin-token';
let adminPromptDeclined = false;

function storedAdminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredAdminToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives only for this call */
  }
}

// Background reads (usage) prompt at most once per page load; user actions always may prompt.
function getAdminToken(background: boolean): string | null {
  const stored = storedAdminToken();
  if (stored) return stored;
  if (background && adminPromptDeclined) return null;
  const entered = window.prompt('Enter the admin token (the ADMIN_TOKEN secret) to use dashboard actions:')?.trim();
  if (!entered) {
    adminPromptDeclined = true;
    return null;
  }
  setStoredAdminToken(entered);
  return entered;
}

export async function callAdmin<T>(
  action: string,
  payload: Record<string, unknown> = {},
  opts: { background?: boolean } = {},
): Promise<T> {
  const token = getAdminToken(Boolean(opts.background));
  if (!token) throw new Error('Admin token required');
  const { data, error } = await supabase.functions.invoke('admin', {
    body: { action, ...payload },
    headers: { 'x-admin-token': token },
  });
  if (error) {
    if (error instanceof FunctionsHttpError && (error.context as Response).status === 401) {
      setStoredAdminToken(null);
      if (opts.background) adminPromptDeclined = true;
      throw new Error('Admin token rejected. Try again to re-enter it.');
    }
    throw new Error(await functionErrorMessage(error));
  }
  const res = data as T & { error?: string };
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(String(res.error));
  return data as T;
}

export const PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/proxy/v1/chat/completions`;
