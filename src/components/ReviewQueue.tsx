import { useEffect, useState } from 'react';
import { Check, X, RefreshCw, Inbox } from 'lucide-react';
import type { EventRow } from '@/lib/supabase';
import { callAdmin } from '@/lib/supabase';
import { DECISION_STYLES } from '@/lib/policy';

export function ReviewQueue({ events, onReviewed }: { events: EventRow[]; onReviewed: () => void }) {
  const pending = events.filter((e) => e.review_status === 'pending');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selected || busy) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === 'a') void review(selected, true);
      if (e.key.toLowerCase() === 'r') void review(selected, false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  async function review(eventId: string, approve: boolean) {
    setBusy(eventId);
    setNotice(null);
    try {
      const res = await callAdmin<{ ok?: boolean; reply?: string; error?: string }>('review', { event_id: eventId, approve });
      setNotice(approve ? 'Approved and forwarded upstream.' : 'Rejected. The message stays blocked.');
      if (approve && res.reply) setNotice((n) => `${n} Reply stored.`);
      setSelected(null);
      onReviewed();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setBusy(null);
    }
  }

  async function replay(eventId: string) {
    setBusy(eventId);
    setNotice(null);
    try {
      const res = await callAdmin<{ decision?: string; error?: string }>('replay', { event_id: eventId });
      setNotice(`Replay with current policy: ${res.decision ?? '?'}`);
      onReviewed();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <header className="flex items-center gap-2 px-5 py-4 border-b border-zinc-800">
        <Inbox size={16} className="text-amber-300" />
        <h2 className="text-sm font-semibold text-zinc-200">Review queue</h2>
        <span className="ml-auto text-xs text-zinc-500">{pending.length} pending · select one, then press A to approve / R to reject</span>
      </header>
      {notice && <p className="px-5 py-2 text-xs text-teal-300 border-b border-zinc-800">{notice}</p>}
      {pending.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">Nothing waiting for review. Flagged events land here.</p>
      ) : (
        <ul>
          {pending.map((ev) => (
            <li
              key={ev.id}
              onClick={() => setSelected(ev.id)}
              className={`px-5 py-3 border-b border-zinc-800/60 cursor-pointer transition-colors ${
                selected === ev.id ? 'bg-teal-500/10' : 'hover:bg-zinc-800/40'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${DECISION_STYLES[ev.decision]}`}>{ev.decision}</span>
                <span className="text-[11px] uppercase text-zinc-500">{ev.stage}</span>
                <span className="text-sm text-zinc-300 truncate flex-1">{(ev.original_text ?? '').slice(0, 90)}</span>
                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => void replay(ev.id)}
                    disabled={busy === ev.id}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <RefreshCw size={12} /> Replay
                  </button>
                  <button
                    onClick={() => void review(ev.id, true)}
                    disabled={busy === ev.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-emerald-600/80 text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    <Check size={12} /> Approve
                  </button>
                  <button
                    onClick={() => void review(ev.id, false)}
                    disabled={busy === ev.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-red-600/80 text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    <X size={12} /> Reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
