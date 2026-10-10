import { ShieldCheck, Clock, Coins, TerminalSquare } from 'lucide-react';
import type { EventRow, ProxyKey } from '@/lib/supabase';
import { PROXY_URL, callAdmin } from '@/lib/supabase';
import { DECISION_STYLES } from '@/lib/policy';
import { CopyButton } from '@/components/Playground';
import { useEffect, useState } from 'react';

export function QuickStart({ keys }: { keys: ProxyKey[] }) {
  const activeKey = keys.find((k) => !k.revoked);
  const keyPlaceholder = activeKey ? 'gp_<your key>' : 'gp_<create a key first>';
  const curl = `curl ${PROXY_URL} \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
  const sdk = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${PROXY_URL.replace(/\/v1\/chat\/completions$/, '')}",
  apiKey: "${keyPlaceholder}",
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});`;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <header className="flex items-center gap-2">
        <TerminalSquare size={16} className="text-teal-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Quick start</h2>
        <span className="ml-auto text-[11px] text-zinc-500">Point any OpenAI-compatible client here — the guardrail sits in the middle.</span>
      </header>
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 flex items-center gap-3">
        <code className="flex-1 text-xs font-mono text-teal-200 truncate">{PROXY_URL}</code>
        <CopyButton text={PROXY_URL} label="Copy URL" />
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <CodeBlock title="curl" code={curl} />
        <CodeBlock title="OpenAI SDK" code={sdk} />
      </div>
    </section>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">{title}</span>
        <CopyButton text={code} label="Copy" />
      </div>
      <pre className="text-[11px] p-3 overflow-x-auto text-zinc-400 font-mono whitespace-pre">{code}</pre>
    </div>
  );
}

export function Hero({ mode }: { mode: 'live' | 'mock' | 'unknown' }) {
  return (
    <header className="pt-10 pb-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-xl bg-teal-500/15 border border-teal-500/40 flex items-center justify-center">
          <ShieldCheck size={22} className="text-teal-300" />
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium border ${
          mode === 'live' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-600 bg-zinc-800 text-zinc-400'
        }`}>
          {mode === 'live' ? 'Live upstream' : 'Mock upstream'}
        </span>
      </div>
      <h1 className="text-3xl md:text-4xl font-semibold text-zinc-100 leading-tight max-w-3xl">
        Guardrail Proxy: Jev screens every prompt and response before it reaches your users.
      </h1>
      <p className="mt-3 text-zinc-400 max-w-2xl leading-relaxed">
        A drop-in, OpenAI-compatible proxy. One batched screening per message — PII, injection, jailbreak, toxicity, and exfiltration — then pass, redact, flag, or block before the upstream model is ever called.
      </p>
    </header>
  );
}

export function TrafficTable({ events, onSelect }: { events: EventRow[]; onSelect: (e: EventRow) => void }) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <header className="px-5 py-4 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">Live traffic</h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800 bg-zinc-900/60">
              <Th>Time</Th>
              <Th>Key</Th>
              <Th>Stage</Th>
              <Th>Decision</Th>
              <Th>Top rule</Th>
              <Th>Jev</Th>
              <Th>Cost</Th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-zinc-500">No traffic yet — send something from the Playground below.</td></tr>
            )}
            {events.map((e) => {
              const topRule = (e.fired_rules ?? [])[0];
              return (
                <tr key={e.id} onClick={() => onSelect(e)} className="border-b border-zinc-800/60 last:border-0 cursor-pointer hover:bg-zinc-800/40 transition-colors">
                  <td className="px-5 py-2.5 text-xs text-zinc-400 whitespace-nowrap">{new Date(e.created_at).toLocaleTimeString()}</td>
                  <td className="px-5 py-2.5 text-xs text-zinc-400">{keyName(e.key_id)}</td>
                  <td className="px-5 py-2.5"><span className="text-xs uppercase text-zinc-500">{e.stage}</span></td>
                  <td className="px-5 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${DECISION_STYLES[e.decision]}`}>{e.decision}</span>
                  </td>
                  <td className="px-5 py-2.5 text-xs font-mono text-zinc-400">{topRule ? topRule.rule : '—'}</td>
                  <td className="px-5 py-2.5 text-xs font-mono text-zinc-400">{e.latency_ms ?? 0} ms</td>
                  <td className="px-5 py-2.5 text-xs font-mono text-zinc-500">${Number(e.cost_usd ?? 0).toFixed(6)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-5 py-2 font-medium">{children}</th>;
}

function keyName(keyId: string | null): string {
  return keyId ? keyId.slice(0, 8) + '…' : '—';
}

export function UsageBanner() {
  const [usage, setUsage] = useState<{ limit: number; calls: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callAdmin<{ limit: number; counters: { fn: string; calls: number }[] }>('usage');
        if (cancelled) return;
        const calls = (res.counters ?? []).reduce((a, c) => a + c.calls, 0);
        setUsage({ limit: res.limit, calls });
      } catch {
        /* banner is informational */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!usage || usage.calls < usage.limit) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      Daily demo limit reached ({usage.calls}/{usage.limit} calls). The Playground has switched to Replay demo mode using stored events.
    </div>
  );
}

export function StatPills({ events }: { events: EventRow[] }) {
  const latency = events.map((e) => e.latency_ms ?? 0).filter((n) => n > 0);
  const avg = latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : 0;
  const cost = events.reduce((a, e) => a + Number(e.cost_usd ?? 0), 0);
  return (
    <div className="grid grid-cols-3 gap-3">
      <Pill icon={<ShieldCheck size={14} />} label="Screenings" value={String(events.length)} />
      <Pill icon={<Clock size={14} />} label="Avg Jev latency" value={avg ? `${avg} ms` : '—'} />
      <Pill icon={<Coins size={14} />} label="Total Jev cost" value={`$${cost.toFixed(6)}`} />
    </div>
  );
}

function Pill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">{icon} {label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-100 font-mono">{value}</p>
    </div>
  );
}
