// Upstream LLM client shared by proxy and admin review.
// Base URL, model and key come only from env — never from the request.
import type { CapReason, CapResult } from './db.ts';

export const MAX_UPSTREAM_TOKENS = 1024;
const MAX_ATTEMPTS = 2;
const OPENAI_TIMEOUT_MS = 60_000;

export function upstreamConfig() {
  return {
    apiKey: Deno.env.get('OPENAI_API_KEY') ?? '',
    baseUrl: (Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini',
  };
}

export type UpstreamMessage = { role: 'system' | 'user'; content: string };
export type ChatResult =
  | { ok: true; content: string; model: string }
  | { ok: false; error: CapReason | 'upstream_error' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// consume() counts each paid fetch against the daily cap and runs before every attempt, retries included.
// Retries only on 429 / 529 / network errors, and never after the cap is hit.
export async function callOpenAIChat(
  messages: UpstreamMessage[],
  maxTokens: number,
  consume: () => Promise<CapResult>,
): Promise<ChatResult> {
  const { apiKey, baseUrl, model } = upstreamConfig();
  const body = JSON.stringify({ model, messages, max_tokens: Math.min(Math.max(1, maxTokens), MAX_UPSTREAM_TOKENS) });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(800);
    const quota = await consume();
    if (!quota.ok) return { ok: false, error: quota.reason };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (e) {
      console.error(`Upstream LLM request failed (attempt ${attempt + 1}):`, e instanceof Error ? e.message : String(e));
      continue;
    }
    if (res.status === 429 || res.status === 529) {
      console.error(`Upstream LLM returned ${res.status} (attempt ${attempt + 1})`);
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`Upstream LLM returned ${res.status}: ${text.slice(0, 500)}`);
      return { ok: false, error: 'upstream_error' };
    }
    try {
      const data = await res.json();
      return { ok: true, content: String(data?.choices?.[0]?.message?.content ?? ''), model: String(data?.model ?? model) };
    } catch (e) {
      console.error('Upstream LLM returned invalid JSON:', e instanceof Error ? e.message : String(e));
      return { ok: false, error: 'upstream_error' };
    }
  }
  return { ok: false, error: 'upstream_error' };
}
