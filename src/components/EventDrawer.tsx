import { X, ShieldAlert, Clock, Coins } from 'lucide-react';
import type { EventRow } from '@/lib/supabase';
import { DECISION_STYLES } from '@/lib/policy';

type JevAnswer = { noul?: number; score?: number; confidence?: number; legend?: string[]; probabilities?: number[] | Record<string, number>; choice?: string };

function AnswerBars({ answers }: { answers: Record<string, JevAnswer> }) {
  const entries = Object.entries(answers);
  if (entries.length === 0) return <p className="text-sm text-zinc-500">No Jev answers stored.</p>;
  return (
    <div className="space-y-4">
      {entries.map(([name, a]) => {
        const probs = Array.isArray(a.probabilities) ? a.probabilities : a.probabilities ? Object.values(a.probabilities) : [];
        return (
          <div key={name}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-zinc-200">{name}</span>
              {typeof a.confidence === 'number' && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                  confidence {(a.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {typeof a.noul === 'number' && (
              <Bar value={a.noul} label={`${(a.noul * 100).toFixed(1)}%`} color="bg-teal-400" />
            )}
            {typeof a.score === 'number' && (
              <>
                <Bar value={a.score / 3} label={`score ${a.score} / 3`} color="bg-amber-400" />
                {a.legend && probs.length === a.legend.length && (
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    {a.legend.map((l, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className="w-10 text-right font-mono">{(probs[i] * 100).toFixed(0)}%</span>
                        <span className="truncate">{l}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {typeof a.choice === 'string' && (
              <>
                <div className="text-sm text-teal-300 font-mono">{a.choice}</div>
                {probs.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {(Object.entries(a.probabilities as Record<string, number>) ?? []).map(([k, v]) => (
                      <Bar key={k} value={v} label={k} color={k === a.choice ? 'bg-teal-400' : 'bg-zinc-600'} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bar({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </div>
      <span className="text-[11px] text-zinc-400 w-32 truncate font-mono">{label}</span>
    </div>
  );
}

export function EventDrawer({ event, onClose }: { event: EventRow; onClose: () => void }) {
  const answers = (event.jev_response ?? {}) as Record<string, JevAnswer>;
  const original = event.original_text ?? '';
  const redacted = event.redacted_text ?? '';
  const changed = original !== redacted;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <aside className="relative w-full max-w-2xl h-full overflow-y-auto bg-zinc-950 border-l border-zinc-800 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-zinc-950/95 border-b border-zinc-800 backdrop-blur">
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${DECISION_STYLES[event.decision]}`}>
              {event.decision}
            </span>
            <span className="text-xs text-zinc-500 uppercase tracking-wide">{event.stage} stage</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-6">
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat icon={<Clock size={14} />} label="Jev latency" value={`${event.latency_ms ?? 0} ms`} />
            <Stat icon={<Coins size={14} />} label="Jev cost" value={`$${Number(event.cost_usd ?? 0).toFixed(6)}`} />
            <Stat icon={<ShieldAlert size={14} />} label="Model" value={event.model ?? '—'} small />
          </div>

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">Original vs redacted</h3>
            <div className="grid md:grid-cols-2 gap-3">
              <TextPanel title="Original" text={original} tone="default" />
              <TextPanel title="After redaction" text={redacted} tone={changed ? 'redacted' : 'default'} />
            </div>
          </section>

          {event.stage === 'output' && event.upstream_response && (
            <section>
              <h3 className="text-sm font-semibold text-zinc-300 mb-2">Upstream response (final)</h3>
              <pre className="text-xs whitespace-pre-wrap bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-zinc-300 font-mono">
                {event.upstream_response}
              </pre>
              {event.upstream_latency_ms != null && (
                <p className="text-[11px] text-zinc-500 mt-1">Upstream latency: {event.upstream_latency_ms} ms</p>
              )}
            </section>
          )}

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">Jev answers</h3>
            <AnswerBars answers={answers} />
          </section>

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">Fired rules</h3>
            {(event.fired_rules ?? []).length === 0 ? (
              <p className="text-sm text-zinc-500">No rules fired.</p>
            ) : (
              <ul className="space-y-2">
                {(event.fired_rules ?? []).map((r, i) => (
                  <li key={i} className={`text-xs rounded-lg border px-3 py-2 ${r.severity === 'block' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}>
                    <span className="font-mono font-semibold">{r.rule}</span>
                    <span className="block text-zinc-400 mt-0.5">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">Raw Jev request</h3>
            <pre className="text-[11px] overflow-x-auto bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-zinc-400 font-mono max-h-56">
              {JSON.stringify(event.jev_request, null, 2)}
            </pre>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-2">Raw Jev response</h3>
            <pre className="text-[11px] overflow-x-auto bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-zinc-400 font-mono max-h-56">
              {JSON.stringify(event.jev_response, null, 2)}
            </pre>
          </section>
        </div>
      </aside>
    </div>
  );
}

function Stat({ icon, label, value, small }: { icon: React.ReactNode; label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex items-center justify-center gap-1 text-[11px] text-zinc-500">
        {icon} {label}
      </div>
      <div className={`mt-1 font-mono text-teal-300 ${small ? 'text-xs truncate' : 'text-sm'}`}>{value}</div>
    </div>
  );
}

function TextPanel({ title, text, tone }: { title: string; text: string; tone: 'default' | 'redacted' }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{title}</p>
      <pre className={`text-xs whitespace-pre-wrap rounded-lg border p-3 min-h-20 font-mono ${
        tone === 'redacted' ? 'bg-sky-500/10 border-sky-500/30 text-sky-200' : 'bg-zinc-900 border-zinc-800 text-zinc-300'
      }`}>
        {text || '—'}
      </pre>
    </div>
  );
}
