// admin — dashboard actions: create_key, revoke_key, review, replay, set_policy, usage.
// Every action requires the ADMIN_TOKEN secret in the x-admin-token header.
import { decide, DEFAULT_POLICY, PRESETS, sanitizePolicy } from '../_shared/decide.ts';
import {
  capFailure, corsHeaders, generateProxyKey, getDailyLimit, isUuid, json, LIMITS, readJsonBody, requireAdmin,
  SCREEN_COUNTER, serviceUnavailable, sha256Hex, supabaseAdmin, UPSTREAM_COUNTER, upstreamQuota,
} from '../_shared/db.ts';
import { callOpenAIChat, MAX_UPSTREAM_TOKENS, upstreamConfig } from '../_shared/openai.ts';

function internalError(where: string, message: string) {
  console.error(`admin ${where} failed:`, message);
  return json({ error: 'internal_error' }, 500);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const denied = await requireAdmin(req);
    if (denied) return denied;

    const parsed = await readJsonBody(req, LIMITS.adminBodyBytes);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const action = body.action;
    const sb = supabaseAdmin();
    if (!sb) return serviceUnavailable();

    if (action === 'create_key') {
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'unnamed key';
      const mode = body.mode === 'mock' ? 'mock' : 'live';
      const plaintext = generateProxyKey();
      const key_hash = await sha256Hex(plaintext);
      const { data, error } = await sb.from('proxy_keys').insert({ name, key_hash, mode }).select('id, name, mode, revoked, created_at').maybeSingle();
      if (error) return internalError('create_key', error.message);
      // The plaintext key is returned ONCE; only its hash is stored.
      return json({ key: data, plaintext });
    }

    if (action === 'revoke_key') {
      if (!isUuid(body.key_id)) return json({ error: 'key_id required' }, 400);
      const { error } = await sb.from('proxy_keys').update({ revoked: true }).eq('id', body.key_id);
      if (error) return internalError('revoke_key', error.message);
      return json({ ok: true });
    }

    if (action === 'review') {
      if (!isUuid(body.event_id)) return json({ error: 'event_id required' }, 400);
      const approve = body.approve === true;
      const { data: ev, error: evErr } = await sb
        .from('events')
        .select('id, key_id, stage, original_text, redacted_text, review_status')
        .eq('id', body.event_id)
        .maybeSingle();
      if (evErr) return internalError('review', evErr.message);
      if (!ev) return json({ error: 'event not found' }, 404);
      if (ev.review_status !== 'pending') return json({ error: 'event is not pending review' }, 409);

      // Claim the event atomically so concurrent approvals can't each trigger an upstream call.
      const { data: claimed, error: claimErr } = await sb
        .from('events')
        .update({ review_status: approve ? 'approved' : 'rejected' })
        .eq('id', ev.id)
        .eq('review_status', 'pending')
        .select('id');
      if (claimErr) return internalError('review', claimErr.message);
      if (!claimed?.length) return json({ error: 'event is not pending review' }, 409);
      if (!approve) return json({ ok: true, review_status: 'rejected' });

      // Approving a flagged INPUT re-runs it through the proxy path and stores the reply.
      if (ev.stage === 'input') {
        const upstreamStarted = Date.now();
        let reply: string;
        if (!upstreamConfig().apiKey) {
          reply = `[Approved by human reviewer] Mock upstream reply for: ${String(ev.original_text ?? '').slice(0, 200)}`;
        } else {
          const text = String(ev.redacted_text ?? ev.original_text ?? '').slice(0, LIMITS.maxMessageChars);
          const res = await callOpenAIChat([{ role: 'user', content: text }], MAX_UPSTREAM_TOKENS, upstreamQuota(sb));
          if (!res.ok) {
            // Put it back in the queue so it can be approved again later.
            await sb.from('events').update({ review_status: 'pending' }).eq('id', ev.id);
            return res.error === 'upstream_error' ? json({ error: 'upstream_error' }, 502) : capFailure(res.error);
          }
          reply = res.content;
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
      if (!isUuid(body.event_id)) return json({ error: 'event_id required' }, 400);
      const { data: ev, error: evErr } = await sb.from('events').select('id, stage, jev_response, fired_rules').eq('id', body.event_id).maybeSingle();
      if (evErr) return internalError('replay', evErr.message);
      if (!ev) return json({ error: 'event not found' }, 404);

      const preset = typeof body.preset === 'string' && Object.hasOwn(PRESETS, body.preset) ? PRESETS[body.preset] : {};
      let policy = { ...DEFAULT_POLICY, ...preset };
      if (typeof body.policy === 'object' && body.policy) policy = { ...policy, ...sanitizePolicy(body.policy) };
      if (!body.policy && !body.preset) {
        const { data: active } = await sb.from('policies').select('config').eq('active', true).maybeSingle();
        policy = { ...policy, ...sanitizePolicy(active?.config) };
      }

      const answers = (ev.jev_response ?? {}) as Record<string, Record<string, unknown>>;
      const result = decide(ev.stage as 'input' | 'output', answers as never, policy, (ev.fired_rules as unknown[])?.some?.((r) => String((r as { rule?: string }).rule ?? '').includes('pii_leak:credential')) ?? false);
      return json({ event_id: ev.id, stage: ev.stage, decision: result.decision, fired_rules: result.fired_rules, policy });
    }

    if (action === 'set_policy') {
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Custom';
      // Only known threshold keys with in-range values are stored.
      const config = { ...DEFAULT_POLICY, ...sanitizePolicy(body.config) };
      const activate = body.activate === true;
      if (activate) await sb.from('policies').update({ active: false }).eq('active', true);
      const { data, error } = await sb.from('policies').insert({ name, config, active: activate }).select().maybeSingle();
      if (error) return internalError('set_policy', error.message);
      return json({ policy: data });
    }

    if (action === 'usage') {
      const limit = getDailyLimit();
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await sb.from('usage_counters').select('fn, calls').eq('day', today);
      if (error) return internalError('usage', error.message);
      const counters = (data ?? []) as { fn: string; calls: number }[];
      const count = (fn: string) => counters.find((c) => c.fn === fn)?.calls ?? 0;
      // Paid upstream calls and screen requests share the daily limit; report whichever is closer to it.
      const calls = Math.max(count(UPSTREAM_COUNTER), count(SCREEN_COUNTER));
      return json({ limit, calls, counters });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('admin error:', err instanceof Error ? err.stack ?? err.message : String(err));
    return json({ error: 'internal_error' }, 500);
  }
});
