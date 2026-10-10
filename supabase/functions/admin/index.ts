// admin — dashboard actions: create_key, revoke_key, review, replay.
import { decide, DEFAULT_POLICY, PRESETS, type PolicyConfig } from '../_shared/decide.ts';
import { checkAndIncrementUsage, corsHeaders, generateProxyKey, getDailyLimit, json, sha256Hex, supabaseAdmin } from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await req.json();
    const action = body?.action;
    const sb = supabaseAdmin();

    if (action === 'create_key') {
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'unnamed key';
      const mode = body.mode === 'mock' ? 'mock' : 'live';
      const plaintext = generateProxyKey();
      const key_hash = await sha256Hex(plaintext);
      const { data, error } = await sb.from('proxy_keys').insert({ name, key_hash, mode }).select('id, name, mode, revoked, created_at').maybeSingle();
      if (error) return json({ error: error.message }, 500);
      // The plaintext key is returned ONCE; only its hash is stored.
      return json({ key: data, plaintext });
    }

    if (action === 'revoke_key') {
      if (typeof body.key_id !== 'string') return json({ error: 'key_id required' }, 400);
      const { error } = await sb.from('proxy_keys').update({ revoked: true }).eq('id', body.key_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'review') {
      if (typeof body.event_id !== 'string') return json({ error: 'event_id required' }, 400);
      const approve = body.approve === true;
      const { data: ev } = await sb.from('events').select('*').eq('id', body.event_id).maybeSingle();
      if (!ev) return json({ error: 'event not found' }, 404);
      if (ev.review_status !== 'pending') return json({ error: 'event is not pending review' }, 409);

      if (!approve) {
        await sb.from('events').update({ review_status: 'rejected' }).eq('id', ev.id);
        return json({ ok: true, review_status: 'rejected' });
      }

      await sb.from('events').update({ review_status: 'approved' }).eq('id', ev.id);

      // Approving a flagged INPUT re-runs it through the proxy path and stores the reply.
      if (ev.stage === 'input') {
        const upstreamStarted = Date.now();
        const useMock = !Deno.env.get('OPENAI_API_KEY');
        let reply: string;
        if (useMock) {
          reply = `[Approved by human reviewer] Mock upstream reply for: ${String(ev.original_text ?? '').slice(0, 200)}`;
        } else {
          const base = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
          const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini',
              messages: [{ role: 'user', content: ev.redacted_text ?? ev.original_text ?? '' }],
            }),
          });
          if (!res.ok) return json({ error: `Upstream error ${res.status}` }, 502);
          const data = await res.json();
          reply = data?.choices?.[0]?.message?.content ?? '';
        }
        const { data: outputEvent } = await sb.from('events').insert({
          key_id: ev.key_id,
          stage: 'output',
          original_text: reply,
          redacted_text: reply,
          decision: 'pass',
          fired_rules: [{ rule: 'human_approved', detail: 'Forwarded after human approval of the flagged input', severity: 'flag' }],
          review_status: 'none',
          upstream_response: reply,
          upstream_latency_ms: Date.now() - upstreamStarted,
          model: 'human-approved-forward',
        }).select('id').maybeSingle();
        return json({ ok: true, review_status: 'approved', output_event_id: outputEvent?.id ?? null, reply });
      }

      // Approving a flagged OUTPUT releases the original response.
      if (ev.stage === 'output') {
        await sb.from('events').update({ redacted_text: ev.original_text }).eq('id', ev.id);
        return json({ ok: true, review_status: 'approved', released: ev.original_text });
      }
      return json({ ok: true, review_status: 'approved' });
    }

    if (action === 'replay') {
      // Re-run decide() on stored Jev answers with the current policy — no Jev call.
      if (typeof body.event_id !== 'string') return json({ error: 'event_id required' }, 400);
      const { data: ev } = await sb.from('events').select('*').eq('id', body.event_id).maybeSingle();
      if (!ev) return json({ error: 'event not found' }, 404);

      let policy = { ...DEFAULT_POLICY, ...PRESETS[body.preset ?? ''] };
      if (typeof body.policy === 'object' && body.policy) policy = { ...policy, ...(body.policy as Partial<PolicyConfig>) };
      if (!body.policy && !body.preset) {
        const { data: active } = await sb.from('policies').select('config').eq('active', true).maybeSingle();
        policy = { ...policy, ...((active?.config as Partial<PolicyConfig>) ?? {}) };
      }

      const answers = (ev.jev_response ?? {}) as Record<string, Record<string, unknown>>;
      const result = decide(ev.stage as 'input' | 'output', answers as never, policy, (ev.fired_rules as unknown[])?.some?.((r) => String((r as { rule?: string }).rule ?? '').includes('pii_leak:credential')) ?? false);
      return json({ event_id: ev.id, stage: ev.stage, decision: result.decision, fired_rules: result.fired_rules, policy });
    }

    if (action === 'set_policy') {
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Custom';
      const config = typeof body.config === 'object' && body.config ? body.config : DEFAULT_POLICY;
      if (body.activate) await sb.from('policies').update({ active: false }).eq('active', true);
      const { data, error } = await sb.from('policies').insert({ name, config, active: body.activate === true }).select().maybeSingle();
      if (error) return json({ error: error.message }, 500);
      return json({ policy: data });
    }

    if (action === 'usage') {
      const limit = await getDailyLimit();
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await sb.from('usage_counters').select('fn, calls').eq('day', today);
      return json({ limit, counters: data ?? [] });
    }

    return json({ error: `Unknown action: ${String(action)}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
