import { useState } from 'react';
import { Send, Copy, Check, FlaskConical, RotateCcw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ATTACK_LIBRARY, SYSTEM_PROMPT_DEFAULT } from '@/lib/attacks';
import { DECISION_STYLES, type Decision } from '@/lib/policy';

type ScreenResponse = {
  stage: 'input' | 'output';
  fail_closed?: boolean;
  error?: string;
  model?: string;
  latency_ms?: number;
  input_tokens?: number;
  cost_usd?: number;
  answers: Record<string, { noul?: number; score?: number; confidence?: number; choice?: string }>;
  raw?: unknown;
};

type SendResult = {
  mode: 'live' | 'replay';
  guardrail?: { input_decision?: Decision; output_decision?: Decision; fired_rules?: { rule: string; detail: string }[] };
  content?: string;
  error?: string;
};

export function Playground({ onSent, limitReached }: { onSent: () => void; limitReached: boolean }) {
  const [system, setSystem] = useState(SYSTEM_PROMPT_DEFAULT);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [screening, setScreening] = useState<ScreenResponse | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [replayMode, setReplayMode] = useState(limitReached);

  async function send() {
    if (!message.trim() || sending) return;
    setSending(true);
    setScreening(null);
    setResult(null);
    try {
      const { data: screenData, error: screenErr } = await supabase.functions.invoke('screen', {
        body: { stage: 'input', system_prompt: system, message },
      });
      if (screenErr) throw new Error(screenErr.message);
      const screen = screenData as ScreenResponse;
      setScreening(screen);

      if (replayMode) {
        setResult({ mode: 'replay', content: '[Replay demo mode] Daily limit reached — this would be forwarded upstream only if screening passed.' });
      } else {
        const { data: proxyData, error: proxyErr } = await supabase.functions.invoke('proxy/v1/chat/completions', {
          body: { model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: message }] },
        });
        if (proxyErr) throw new Error(proxyErr.message);
        const proxy = proxyData as SendResult & { choices?: { message?: { content?: string } }[]; error?: string };
        if (proxy.error) throw new Error(proxy.error);
        // Output screening for what came back.
        if (proxy.choices?.[0]?.message?.content) {
          const { data: outScreen } = await supabase.functions.invoke('screen', {
            body: { stage: 'output', system_prompt: system, message: proxy.choices[0].message.content },
          });
          setScreening(outScreen as ScreenResponse);
        }
        setResult({ mode: 'live', guardrail: proxy.guardrail, content: proxy.choices?.[0]?.message?.content });
      }
      onSent();
    } catch (err) {
      setResult({ mode: replayMode ? 'replay' : 'live', error: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <header className="flex items-center gap-2">
        <FlaskConical size={16} className="text-teal-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Playground</h2>
        <button
          onClick={() => setReplayMode((m) => !m)}
          className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
            replayMode ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          <RotateCcw size={12} /> {replayMode ? 'Replay demo mode' : 'Live proxy mode'}
        </button>
      </header>

      <div>
        <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Attack library</p>
        <div className="flex flex-wrap gap-2">
          {ATTACK_LIBRARY.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                setSystem(a.system);
                setMessage(a.message);
              }}
              title={`Expected: ${a.expect}`}
              className="px-2.5 py-1 rounded-lg text-xs bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:border-teal-500/50 hover:text-teal-200 transition-colors"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">System prompt</span>
          <textarea
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={5}
            className="mt-1 w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-300 font-mono focus:border-teal-500/60 focus:outline-none resize-y"
          />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">User message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            placeholder="Type a message or pick an attack above…"
            className="mt-1 w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-300 font-mono focus:border-teal-500/60 focus:outline-none resize-y"
          />
        </label>
      </div>

      <button
        onClick={() => void send()}
        disabled={sending || !message.trim()}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-500 disabled:opacity-50 transition-colors"
      >
        <Send size={14} /> {sending ? 'Screening…' : 'Send through proxy'}
      </button>

      {screening && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="uppercase tracking-wide">Jev {screening.stage} screen</span>
            {screening.model && <span className="font-mono text-zinc-600">{screening.model}</span>}
            {screening.latency_ms != null && <span className="text-teal-400">{screening.latency_ms} ms</span>}
            {screening.fail_closed && <span className="text-amber-300">fail-closed</span>}
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {Object.entries(screening.answers ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-xs bg-zinc-900 rounded-lg px-3 py-1.5 border border-zinc-800">
                <span className="font-mono text-zinc-400">{k}</span>
                <span className="text-zinc-200 font-mono">
                  {v.noul != null ? (v.noul * 100).toFixed(0) + '%' : v.score != null ? `score ${v.score}` : String(v.choice ?? '—')}
                  {v.confidence != null && <span className="text-zinc-600 ml-1">c={(v.confidence * 100).toFixed(0)}%</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
          {result.error ? (
            <p className="text-xs text-red-300">{result.error}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                {result.guardrail?.input_decision && (
                  <span className={`px-2 py-0.5 rounded-full border ${DECISION_STYLES[result.guardrail.input_decision]}`}>
                    input: {result.guardrail.input_decision}
                  </span>
                )}
                {result.guardrail?.output_decision && (
                  <span className={`px-2 py-0.5 rounded-full border ${DECISION_STYLES[result.guardrail.output_decision]}`}>
                    output: {result.guardrail.output_decision}
                  </span>
                )}
                {(result.guardrail?.fired_rules ?? []).map((r, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400 font-mono text-[11px]">{r.rule}</span>
                ))}
              </div>
              <pre className="text-xs whitespace-pre-wrap text-zinc-300 font-mono">{result.content}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />} {copied ? 'Copied' : label}
    </button>
  );
}
