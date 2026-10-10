// proxy — OpenAI-compatible endpoint with Jev screening on input and output.
import { buildJevRequest, callJev, extractAnswers } from '../_shared/jev.ts';
import { decide, DEFAULT_POLICY, noulValue, isScore, isChoice, type PolicyConfig, type InputAnswers, type OutputAnswers, type JevAnswer } from '../_shared/decide.ts';
import { redact } from '../_shared/redact.ts';
import { checkAndIncrementUsage, corsHeaders, getDailyLimit, json, sha256Hex, supabaseAdmin } from '../_shared/db.ts';

const OPENAI_BASE_URL = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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

async function activePolicy(): Promise<PolicyConfig> {
  const sb = supabaseAdmin();
  const { data } = await sb.from('policies').select('config').eq('active', true).maybeSingle();
  return { ...DEFAULT_POLICY, ...((data?.config as Partial<PolicyConfig>) ?? {}) };
}

function policyMessage(text: string): string {
  return `Your request was blocked by Guardrail Proxy. Reason: ${text}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    // Auth: Bearer gp_...
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token.startsWith('gp_')) return json({ error: 'Invalid proxy key' }, 401);

    const sb = supabaseAdmin();
    const keyHash = await sha256Hex(token);
    const { data: key } = await sb.from('proxy_keys').select('id, name, mode, revoked').eq('key_hash', keyHash).maybeSingle();
    if (!key || key.revoked) return json({ error: 'Unknown or revoked proxy key' }, 401);

    // Per-key daily cap of 50 requests.
    const keyUsage = await checkAndIncrementUsage(`key:${key.id}`, 50);
    if (!keyUsage.allowed) return json({ error: 'Daily demo limit reached (per-key cap of 50)' }, 429);

    // Global demo cap.
    const limit = await getDailyLimit();
    const usage = await checkAndIncrementUsage('proxy', limit);
    if (!usage.allowed) return json({ error: 'Daily demo limit reached' }, 429);

    const body = await req.json();
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return json({ error: 'messages must include a user message' }, 400);
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    // temperature is stripped before anything is forwarded upstream.
    const { temperature: _stripped, ...forwardBody } = body;

    const policy = await activePolicy();
    const jevKey = Deno.env.get('TYPESAFE_API_KEY') ?? '';

    // ---- Input screening ----
    const inputReq = buildJevRequest('input', systemPrompt, lastUser.content);
    const inputRes = await callJev(inputReq, jevKey);
    const inputAnswers = extractAnswers(inputRes.response) as unknown as InputAnswers;
    const { redacted: inputRedacted, matches: inputMatches } = redact(lastUser.content);

    const inputDecide = inputRes.ok
      ? decide('input', inputAnswers, policy, inputMatches.length > 0)
      : { decision: 'flag' as const, fired_rules: [{ rule: 'fail_closed', detail: 'Jev unreachable after retries — flagged for review', severity: 'flag' as const }] };

    const { data: inputEvent } = await sb.from('events').insert({
      key_id: key.id,
      stage: 'input',
      original_text: lastUser.content,
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
      return openAiResponse(String(body.model ?? OPENAI_MODEL), policyMessage(why), {
        guardrail: { ...inputGuardrail, output_decision: 'blocked' },
      });
    }

    const messageToSend = inputDecide.decision === 'redact' ? inputRedacted : lastUser.content;

    // ---- Upstream (live or mock) ----
    const useMock = key.mode === 'mock' || !Deno.env.get('OPENAI_API_KEY');
    const upstreamStarted = Date.now();
    let assistantContent: string;
    let upstreamModel = String(body.model ?? OPENAI_MODEL);

    if (useMock) {
      assistantContent = mockReply(lastUser.content, inputRedacted, inputDecide.decision);
      upstreamModel = 'mock-upstream';
    } else {
      const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...forwardBody, model: body.model ?? OPENAI_MODEL, messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: messageToSend },
        ] }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return json({ error: `Upstream LLM error ${res.status}: ${errText.slice(0, 300)}` }, 502);
      }
      const data = await res.json();
      assistantContent = data?.choices?.[0]?.message?.content ?? '';
      upstreamModel = String(data?.model ?? upstreamModel);
    }
    const upstreamLatency = Date.now() - upstreamStarted;

    // ---- Output screening ----
    const outputReq = buildJevRequest('output', systemPrompt, assistantContent);
    const outputRes = await callJev(outputReq, jevKey);
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
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
