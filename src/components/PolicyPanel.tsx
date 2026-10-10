import { useState } from 'react';
import { ShieldCheck, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { supabase, callAdmin } from '@/lib/supabase';
import { DEFAULT_POLICY, type PolicyConfig } from '@/lib/policy';

type SliderDef = { key: keyof PolicyConfig; label: string; min: number; max: number; step: number; isScore?: boolean };

const SLIDERS: { group: string; items: SliderDef[] }[] = [
  {
    group: 'Input — block / review',
    items: [
      { key: 'injectionBlock', label: 'Injection block', min: 0.5, max: 1, step: 0.05 },
      { key: 'injectionReview', label: 'Injection review', min: 0, max: 1, step: 0.05 },
      { key: 'jailbreakBlock', label: 'Jailbreak block', min: 0.5, max: 1, step: 0.05 },
      { key: 'jailbreakReview', label: 'Jailbreak review', min: 0, max: 1, step: 0.05 },
      { key: 'toxicityBlock', label: 'Toxicity block', min: 1, max: 3, step: 0.1, isScore: true },
      { key: 'toxicityReview', label: 'Toxicity review', min: 0, max: 3, step: 0.1, isScore: true },
      { key: 'exfilConfidence', label: 'Exfiltration min confidence', min: 0.3, max: 1, step: 0.05 },
    ],
  },
  {
    group: 'Output — block / review',
    items: [
      { key: 'piiLeakBlock', label: 'PII leak block', min: 0.5, max: 1, step: 0.05 },
      { key: 'piiLeakReview', label: 'PII leak review', min: 0, max: 1, step: 0.05 },
      { key: 'offPolicyBlock', label: 'Off-policy block', min: 0.5, max: 1, step: 0.05 },
      { key: 'offPolicyReview', label: 'Off-policy review', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    group: 'Redaction',
    items: [{ key: 'piiRedact', label: 'PII redact threshold', min: 0.1, max: 1, step: 0.05 }],
  },
];

const PRESETS: Record<string, PolicyConfig> = {
  Strict: {
    ...DEFAULT_POLICY,
    injectionBlock: 0.6, injectionReview: 0.3, jailbreakBlock: 0.6, jailbreakReview: 0.3,
    toxicityBlock: 2, toxicityReview: 1.2, piiRedact: 0.3,
    piiLeakBlock: 0.6, piiLeakReview: 0.3, offPolicyBlock: 0.5, offPolicyReview: 0.3, exfilConfidence: 0.5,
  },
  Balanced: { ...DEFAULT_POLICY },
  Permissive: {
    ...DEFAULT_POLICY,
    injectionBlock: 0.95, injectionReview: 0.8, jailbreakBlock: 0.95, jailbreakReview: 0.8,
    toxicityBlock: 3, toxicityReview: 2, piiRedact: 0.7,
    piiLeakBlock: 0.95, piiLeakReview: 0.8, offPolicyBlock: 0.9, offPolicyReview: 0.75, exfilConfidence: 0.85,
  },
};

export function PolicyPanel({ config, onChange }: { config: PolicyConfig; onChange: (c: PolicyConfig) => void }) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(activate: boolean) {
    setSaving(true);
    setNotice(null);
    try {
      await callAdmin('set_policy', { name: activate ? 'Active policy' : 'Draft policy', config, activate });
      setNotice(activate ? 'Saved and activated — the proxy uses this now.' : 'Saved as draft.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function loadActive() {
    const { data } = await supabase.from('policies').select('config').eq('active', true).maybeSingle();
    if (data?.config) onChange({ ...DEFAULT_POLICY, ...(data.config as Partial<PolicyConfig>) });
    setNotice('Loaded the active policy from the database.');
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <header className="flex items-center gap-2 flex-wrap">
        <SlidersHorizontal size={16} className="text-teal-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Policy thresholds</h2>
        <div className="ml-auto flex gap-2">
          {Object.keys(PRESETS).map((p) => (
            <button
              key={p}
              onClick={() => onChange(PRESETS[p])}
              className="px-2.5 py-1 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:border-teal-500/50 hover:text-teal-200"
            >
              {p}
            </button>
          ))}
          <button onClick={() => void loadActive()} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border border-zinc-700 text-zinc-400 hover:bg-zinc-800">
            <RotateCcw size={11} /> Load active
          </button>
        </div>
      </header>

      {notice && <p className="text-xs text-teal-300">{notice}</p>}

      <div className="grid md:grid-cols-3 gap-5">
        {SLIDERS.map((g) => (
          <div key={g.group} className="space-y-3">
            <h3 className="text-[11px] uppercase tracking-wide text-zinc-500">{g.group}</h3>
            {g.items.map((s) => (
              <label key={String(s.key)} className="block">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-400">{s.label}</span>
                  <span className="font-mono text-teal-300">{Number(config[s.key]).toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={Number(config[s.key])}
                  onChange={(e) => onChange({ ...config, [s.key]: Number(e.target.value) })}
                  className="w-full accent-teal-500"
                />
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={Boolean(config.intentUncertainFlag)}
            onChange={(e) => onChange({ ...config, intentUncertainFlag: e.target.checked })}
            className="accent-teal-500"
          />
          Flag uncertain intent for review
        </label>
        <button
          onClick={() => void save(true)}
          disabled={saving}
          className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-medium hover:bg-teal-500 disabled:opacity-50"
        >
          <ShieldCheck size={13} /> {saving ? 'Saving…' : 'Save & activate'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">Precedence: block &gt; flag &gt; redact &gt; pass. PII is only redacted when Jev sees PII and the regex redactor finds matches.</p>
    </section>
  );
}
