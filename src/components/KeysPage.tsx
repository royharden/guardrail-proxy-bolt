import { useState } from 'react';
import { KeyRound, Plus, Ban, Check } from 'lucide-react';
import type { ProxyKey } from '@/lib/supabase';
import { callAdmin } from '@/lib/supabase';

export function KeysPage({ keys, usage, onChanged }: { keys: ProxyKey[]; usage: Record<string, number>; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'live' | 'mock'>('mock');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function createKey() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await callAdmin<{ plaintext?: string; error?: string }>('create_key', { name, mode });
      if (res.plaintext) setCreated(res.plaintext);
      setName('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id: string) {
    setBusy(true);
    try {
      await callAdmin('revoke_key', { key_id: id });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <header className="flex items-center gap-2">
        <KeyRound size={16} className="text-teal-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Proxy keys</h2>
      </header>

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex-1 min-w-40">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">Key name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. local-dev"
            className="mt-1 w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-teal-500/60 focus:outline-none"
          />
        </label>
        <label>
          <span className="text-[11px] uppercase tracking-wide text-zinc-500 block">Upstream mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'live' | 'mock')}
            className="mt-1 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-teal-500/60 focus:outline-none"
          >
            <option value="mock">Mock upstream</option>
            <option value="live">Live upstream</option>
          </select>
        </label>
        <button
          onClick={() => void createKey()}
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-500 disabled:opacity-50"
        >
          <Plus size={14} /> Create key
        </button>
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {created && (
        <div className="rounded-xl border border-teal-500/40 bg-teal-500/10 p-4">
          <p className="text-xs text-teal-200 font-medium mb-1">Copy this key now — it is shown only once.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-teal-100 break-all">{created}</code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  setCopied(false);
                }
              }}
              className="px-2 py-1 rounded text-xs border border-teal-500/50 text-teal-200 hover:bg-teal-500/20"
            >
              {copied ? <Check size={12} /> : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800 bg-zinc-900/60">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Mode</th>
              <th className="px-4 py-2 font-medium">Today</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-zinc-500 text-sm">No keys yet — create one to start sending traffic.</td></tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-2.5 text-zinc-200">{k.name}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${k.mode === 'live' ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-zinc-600 text-zinc-400 bg-zinc-800'}`}>
                    {k.mode}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{usage[k.id] ?? 0} / 50</td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-2.5">
                  {k.revoked ? <span className="text-xs text-red-300">revoked</span> : <span className="text-xs text-emerald-300">active</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {!k.revoked && (
                    <button
                      onClick={() => void revokeKey(k.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Ban size={11} /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
