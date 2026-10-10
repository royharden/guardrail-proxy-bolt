import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { BarChart3 } from 'lucide-react';
import type { EventRow } from '@/lib/supabase';

const DECISION_COLORS: Record<string, string> = {
  pass: '#34d399',
  redact: '#38bdf8',
  flag: '#fbbf24',
  block: '#f87171',
};

export const JUDGE_INPUT_PER_1M = 2.5;
export const JUDGE_OUTPUT_PER_1M = 10;
export const JUDGE_OUTPUT_TOKENS_PER_CHECK = 150;

export function Stats({ events }: { events: EventRow[] }) {
  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.decision] = (acc[e.decision] ?? 0) + 1;
    return acc;
  }, {});
  const donutData = Object.entries(counts).map(([name, value]) => ({ name, value }));

  const ruleCounts: Record<string, number> = {};
  for (const e of events) {
    for (const r of e.fired_rules ?? []) {
      if (r.severity === 'block') ruleCounts[r.rule] = (ruleCounts[r.rule] ?? 0) + 1;
    }
  }
  const ruleData = Object.entries(ruleCounts)
    .map(([rule, count]) => ({ rule: rule.replace(/:\w+$/, ''), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const latencies = events.map((e) => e.latency_ms ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const upstream = events.map((e) => e.upstream_latency_ms ?? 0).filter((n) => n > 0);
  const avgUpstream = upstream.length ? Math.round(upstream.reduce((a, b) => a + b, 0) / upstream.length) : 0;

  const totalTokens = events.reduce((a, e) => a + (e.input_tokens ?? 0), 0);
  const jevCost = events.reduce((a, e) => a + Number(e.cost_usd ?? 0), 0);
  const judgeCost = (totalTokens / 1_000_000) * JUDGE_INPUT_PER_1M + (events.length * JUDGE_OUTPUT_TOKENS_PER_CHECK * JUDGE_OUTPUT_PER_1M) / 1_000_000;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-5">
      <header className="flex items-center gap-2">
        <BarChart3 size={16} className="text-teal-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Stats</h2>
      </header>

      <div className="grid sm:grid-cols-4 gap-3">
        <Metric label="p50 Jev latency" value={`${p50} ms`} />
        <Metric label="p95 Jev latency" value={`${p95} ms`} />
        <Metric label="Avg upstream" value={avgUpstream ? `${avgUpstream} ms` : '—'} sub="added latency ≈ Jev only" />
        <Metric label="Jev spend" value={`$${jevCost.toFixed(6)}`} />
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Decisions</h3>
          {donutData.length === 0 ? (
            <p className="text-sm text-zinc-500">No data yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={3} stroke="none">
                  {donutData.map((d) => (
                    <Cell key={d.name} fill={DECISION_COLORS[d.name] ?? '#71717a'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div className="flex flex-wrap gap-3 justify-center">
            {donutData.map((d) => (
              <span key={d.name} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: DECISION_COLORS[d.name] }} /> {d.name} ({d.value})
              </span>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Blocks by rule</h3>
          {ruleData.length === 0 ? (
            <p className="text-sm text-zinc-500">No blocked traffic yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={ruleData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" stroke="#71717a" fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="rule" stroke="#71717a" fontSize={11} width={110} />
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }} cursor={{ fill: '#27272a55' }} />
                <Bar dataKey="count" fill="#f87171" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Jev vs LLM-judge cost</h3>
          <div className="space-y-3">
            <CostRow label="Jev (System 1)" value={jevCost} max={Math.max(jevCost, judgeCost, 0.0001)} color="#2dd4bf" />
            <CostRow label="LLM judge (est.)" value={judgeCost} max={Math.max(jevCost, judgeCost, 0.0001)} color="#a1a1aa" />
            {jevCost > 0 && judgeCost > 0 && (
              <p className="text-xs text-zinc-500">
                Jev is about <span className="text-teal-300 font-medium">{(judgeCost / jevCost).toFixed(1)}×</span> cheaper for the same {events.length} screenings
                ({totalTokens.toLocaleString()} input tokens).
              </p>
            )}
            <p className="text-[11px] text-zinc-600">
              Judge estimate: ${JUDGE_INPUT_PER_1M}/M input + ${JUDGE_OUTPUT_PER_1M}/M output, ~{JUDGE_OUTPUT_TOKENS_PER_CHECK} output tokens per check. Jev output is free.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-teal-300 font-mono">{value}</p>
      {sub && <p className="text-[10px] text-zinc-600">{sub}</p>}
    </div>
  );
}

function CostRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400 mb-1">
        <span>{label}</span>
        <span className="font-mono">${value.toFixed(6)}</span>
      </div>
      <div className="h-2.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
      </div>
    </div>
  );
}
