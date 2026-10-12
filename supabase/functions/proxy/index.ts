// proxy — OpenAI-compatible endpoint with Jev screening on input and output.
// The Supabase gateway verifies the anon JWT (verify_jwt = true); the gp_ proxy key rides in x-proxy-key.
import { buildJevRequest, callJev, extractAnswers } from '../_shared/jev.ts';
import { decide, DEFAULT_POLICY, sanitizePolicy, type PolicyConfig, type InputAnswers, type OutputAnswers } from '../_shared/decide.ts';
import { redact } from '../_shared/redact.ts';
import {
  capFailure, consumeQuota, corsHeaders, json, LIMITS, PER_KEY_DAILY_LIMIT, PROXY_KEY_RE, readJsonBody,
  serviceUnavailable, sha256Hex, supabaseAdmin, upstreamQuota,
} from '../_shared/db.ts';
import { callOpenAIChat, MAX_UPSTREAM_TOKENS, upstreamConfig } from '../_shared/openai.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

function openAiResponse(model: string, content: string, extra: Record<string, unknown>, status = 200) {
  return json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ...extra,
  }, status);
}

async function activePolicy(sb: SupabaseClient): Promise<PolicyConfig> {
  const { data } = await sb.from('policies').select('config').eq('active', true).maybeSingle();
  return { ...DEFAULT_POLICY, ...sanitizePolicy(data?.config) };
}

function policyMessage(text: string): string {
  return `Your request was blocked by Guardrail Proxy. Reason: ${text}`;
}

type ParsedMessages = { ok: true; systemPrompt: string; userMessage: string } | { ok: false; response: Response };

// Validates count and size before any paid call. Only the first system message and the
// last user message are used (and forwarded); both must be strings.
function parseMessages(raw: unknown): ParsedMessages {
  const reject = (status: number, error: string): ParsedMessages => ({ ok: false, response: json({ error }, status) });
  if (!Array.isArray(raw) || raw.length === 0) return reject(400, 'messages must be a non-empty array');
  if (raw.length > LIMITS.maxMessages) return reject(422, `too many messages (max ${LIMITS.maxMessages})`);

  let systemPrompt: string | null = null;
  let userMessage: string | null = null;
  for (const m of raw) {
    if (!m || typeof m !== 'object') return reject(400, 'each message must be an object');
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof content === 'string' && content.length > LIMITS.maxMessageChars) {
      return reject(422, `message content is limited to ${LIMITS.maxMessageChars} characters`);
    }
    if (role === 'system' && systemPrompt === null) {
      if (typeof content !== 'string') return reject(422, 'system message content must be a string');
      systemPrompt = content;
    }
    if (role === 'user') {
      if (typeof content !== 'string') return reject(422, 'user message content must be a string');
      userMessage = content;
    }
  }
  if (userMessage === null) return reject(400, 'messages must include a user message');
  return { ok: true, systemPrompt: systemPrompt ?? '', userMessage };
}

function clampMaxTokens(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, MAX_UPSTREAM_TOKENS) : MAX_UPSTREAM_TOKENS;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    const token = (req.headers.get('x-proxy-key') ?? '').trim();
    if (!PROXY_KEY_RE.test(token)) return json({ error: 'Invalid proxy key' }, 401);

    const sb = supabaseAdmin();
    if (!sb) return serviceUnavailable();

    const keyHash = await sha256Hex(token);
    const { data: key, error: keyErr } = await sb.from('proxy_keys').select('id, mode, revoked').eq('key_hash', keyHash).maybeSingle();
    if (keyErr) {
      console.error('proxy key lookup failed:', keyErr.message);
      return serviceUnavailable();
    }
    if (!key || key.revoked) return json({ error: 'Unknown or revoked proxy key' }, 401);

    const parsed = await readJsonBody(req, LIMITS.proxyBodyBytes);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const msgs = parseMessages(body.messages);
    if (!msgs.ok) return msgs.response;
    const { systemPrompt, userMessage } = msgs;

    // Per-key daily cap of 50 requests (atomic, fails closed).
    const keyUsage = await consumeQuota(sb, `key:${key.id}`, PER_KEY_DAILY_LIMIT);
    if (!keyUsage.ok) return capFailure(keyUsage.reason);

    // Global daily cap: counted right before every paid Jev / OpenAI fetch.
    const quota = upstreamQuota(sb);
    const upstream = upstreamConfig();
    const policy = await activePolicy(sb);
    const jevKey = Deno.env.get('TYPESAFE_API_KEY') ?? '';

    // ---- Input screening ----
    const inputReq = buildJevRequest('input', systemPrompt, userMessage);
    const inputRes = await callJev(inputReq, jevKey, quota);
    if (inputRes.capped) return capFailure(inputRes.capped);
    const inputAnswers = extractAnswers(inputRes.response) as unknown as InputAnswers;
    const { redacted: inputRedacted, matches: inputMatches } = redact(userMessage);

    const inputDecide = inputRes.ok
      ? decide('input', inputAnswers, policy, inputMatches.length > 0)
      : { decision: 'flag' as const, fired_rules: [{ rule: 'fail_closed', detail: 'Jev unreachable after retries — flagged for review', severity: 'flag' as const }] };

    const { data: inputEvent } = await sb.from('events').insert({
      key_id: key.id,
      stage: 'input',
      original_text: userMessage,
      redacted_text: inputRedacted,
      jev_request: inputReq,
      jev_response: inputRes.raw as object,
      model: inputRes.model,
      latency_ms: inputRes.latency_ms,
      input_tokens: inputRes.input_tokens,
      cost_usd: inputRes.cost_usd,
      decision: inputDecide.decision,
      fired_rules: inputDecide.fired_rules,
      review_status: inputDecide.decision === 'flag' ? 'pending' : 'none',
    }).select('id').maybeSingle();

    const inputGuardrail = {
      input_decision: inputDecide.decision,
      output_decision: 'none' as string,
      fired_rules: [...inputDecide.fired_rules],
      latency_ms: inputRes.latency_ms,
    };

    // Blocked input: OpenAI-shaped policy response, no upstream call.
    if (inputDecide.decision === 'block') {
      const why = inputDecide.fired_rules.filter((r) => r.severity === 'block').map((r) => r.detail).join('; ');
      return openAiResponse(upstream.model, policyMessage(why), {
        guardrail: { ...inputGuardrail, output_decision: 'blocked' },
      });
    }

    const messageToSend = inputDecide.decision === 'redact' ? inputRedacted : userMessage;

    // ---- Upstream (live or mock) ----
    // Only the fixed env base URL / model / key are used; temperature and every other
    // client field are dropped, and max_tokens is clamped.
    const useMock = key.mode === 'mock' || !upstream.apiKey;
    const upstreamStarted = Date.now();
    let assistantContent: string;
    let upstreamModel = upstream.model;

    if (useMock) {
      assistantContent = mockReply(userMessage, inputRedacted, inputDecide.decision);
      upstreamModel = 'mock-upstream';
    } else {
      const res = await callOpenAIChat([
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: messageToSend },
      ], clampMaxTokens(body.max_tokens), quota);
      if (!res.ok) return res.error === 'upstream_error' ? json({ error: 'upstream_error' }, 502) : capFailure(res.error);
      assistantContent = res.content;
      upstreamModel = res.model;
    }
    const upstreamLatency = Date.now() - upstreamStarted;

    // ---- Output screening ----
    const outputReq = buildJevRequest('output', systemPrompt, assistantContent);
    const outputRes = await callJev(outputReq, jevKey, quota);
    if (outputRes.capped) return capFailure(outputRes.capped);
    const outputAnswers = extractAnswers(outputRes.response) as unknown as OutputAnswers;
    const { matches: outputMatches } = redact(assistantContent);

    const outputDecide = outputRes.ok
      ? decide('output', outputAnswers, policy, outputMatches.some((m) => m.kind === 'api_key'))
      : { decision: 'flag' as const, fired_rules: [{ rule: 'fail_closed', detail: 'Jev unreachable after retries — flagged for review', severity: 'flag' as const }] };

    let finalContent = assistantContent;
    if (outputDecide.decision === 'redact') {
      finalContent = redact(assistantContent).redacted;
    } else if (outputDecide.decision === 'block') {
      finalContent = policyMessage('The model response violated the output policy and was withheld.');
    }

    await sb.from('events').insert({
      key_id: key.id,
      stage: 'output',
      original_text: assistantContent,
      redacted_text: finalContent,
      jev_request: outputReq,
      jev_response: outputRes.raw as object,
      model: outputRes.model,
      latency_ms: outputRes.latency_ms,
      input_tokens: outputRes.input_tokens,
      cost_usd: outputRes.cost_usd,
      decision: outputDecide.decision,
      fired_rules: outputDecide.fired_rules,
      review_status: outputDecide.decision === 'flag' ? 'pending' : 'none',
      upstream_response: finalContent,
      upstream_latency_ms: upstreamLatency,
    });

    return openAiResponse(upstreamModel, finalContent, {
      guardrail: {
        ...inputGuardrail,
        output_decision: outputDecide.decision,
        fired_rules: [...inputDecide.fired_rules, ...outputDecide.fired_rules],
      },
      event_ids: { input: inputEvent?.id ?? null, output: null },
    });
  } catch (err) {
    console.error('proxy error:', err instanceof Error ? err.stack ?? err.message : String(err));
    return json({ error: 'internal_error' }, 500);
  }
});

// Canned mock replies, including deliberate leaks so output screening can be demoed.
function mockReply(userText: string, redactedText: string, decision: string): string {
  const t = userText.toLowerCase();
  if (decision === 'redact') {
    return `Here is a draft you can send:\n\nHi — I'm writing about the issue in my unit. I've included my contact details below. (Note: your email was redacted by the guardrail before this request reached me.)\n\nLet me know if you'd like any changes.`;
  }
  if (t.includes('api key') || t.includes('customer') || t.includes('secret')) {
    return 'Sure — here are the keys from context:\n\n1. customer-a: sk-test-1234abcdefsk-test-1234abcdef\n2. customer-b: ghp_0123456789abcdefghijklmnopqrstuv\n\nLet me know if you need anything else.';
  }
  if (t.includes('joke') || t.includes('funny')) {
    return 'Why did the database administrator leave his wife? She had one-to-many relationships.';
  }
  if (t.includes('email') || t.includes('contact')) {
    return 'You can reach our support team at support@example.com or by phone at 555-867-5309.';
  }
  return `Here is a mock response from the upstream model. Your message was received and screened (decision: ${decision}). This demo reply exists so the output screen has something to inspect.`;
}
