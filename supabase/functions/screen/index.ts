// screen — the shared Jev screening function, callable directly from the dashboard.
import { buildJevRequest, callJev, extractAnswers } from '../_shared/jev.ts';
import { checkAndIncrementUsage, corsHeaders, getDailyLimit, json, supabaseAdmin } from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const stage: 'input' | 'output' = body.stage === 'output' ? 'output' : 'input';
    const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message) return json({ error: 'message is required' }, 400);

    const limit = await getDailyLimit();
    const usage = await checkAndIncrementUsage('screen', limit);
    if (!usage.allowed) return json({ error: 'Daily demo limit reached' }, 429);

    const apiKey = Deno.env.get('TYPESAFE_API_KEY') ?? '';
    const request = buildJevRequest(stage, systemPrompt, message);
    const result = await callJev(request, apiKey);

    const answers = extractAnswers(result.response);
    const failClosed = !result.ok;

    // Log the screening to events (stage only, no decision — the caller decides).
    const sb = supabaseAdmin();
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
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
