// screen — the shared Jev screening function, callable directly from the dashboard.
import { buildJevRequest, callJev, extractAnswers } from '../_shared/jev.ts';
import {
  capFailure, consumeQuota, corsHeaders, getDailyLimit, json, LIMITS, readJsonBody, SCREEN_COUNTER,
  serviceUnavailable, supabaseAdmin, upstreamQuota,
} from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    const parsed = await readJsonBody(req, LIMITS.screenBodyBytes);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const stage: 'input' | 'output' = body.stage === 'output' ? 'output' : 'input';
    const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message) return json({ error: 'message is required' }, 400);
    if (message.length > LIMITS.maxMessageChars || systemPrompt.length > LIMITS.maxMessageChars) {
      return json({ error: `message and system_prompt are limited to ${LIMITS.maxMessageChars} characters` }, 422);
    }

    const sb = supabaseAdmin();
    if (!sb) return serviceUnavailable();

    // Per-request cap bounds event writes even when Jev is not configured (atomic, fails closed).
    const usage = await consumeQuota(sb, SCREEN_COUNTER, getDailyLimit());
    if (!usage.ok) return capFailure(usage.reason);

    // Global paid-call cap is counted inside callJev before every fetch, retries included.
    const apiKey = Deno.env.get('TYPESAFE_API_KEY') ?? '';
    const request = buildJevRequest(stage, systemPrompt, message);
    const result = await callJev(request, apiKey, upstreamQuota(sb));
    if (result.capped) return capFailure(result.capped);

    const answers = extractAnswers(result.response);
    const failClosed = !result.ok;

    // Log the screening to events (stage only, no decision — the caller decides).
    const { data: ev } = await sb
      .from('events')
      .insert({
        stage,
        original_text: message,
        redacted_text: message,
        jev_request: request,
        jev_response: result.raw as object,
        model: result.model,
        latency_ms: result.latency_ms,
        input_tokens: result.input_tokens,
        cost_usd: result.cost_usd,
        decision: failClosed ? 'flag' : 'pass',
        fired_rules: failClosed ? [{ rule: 'fail_closed', detail: 'Jev unreachable after retries', severity: 'flag' }] : [],
        review_status: 'none',
      })
      .select('id')
      .maybeSingle();

    return json({
      event_id: ev?.id ?? null,
      stage,
      fail_closed: failClosed,
      error: result.error,
      model: result.model,
      latency_ms: result.latency_ms,
      input_tokens: result.input_tokens,
      cost_usd: result.cost_usd,
      answers,
      raw: result.raw,
    });
  } catch (err) {
    console.error('screen error:', err instanceof Error ? err.stack ?? err.message : String(err));
    return json({ error: 'internal_error' }, 500);
  }
});
