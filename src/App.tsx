import { useCallback, useEffect, useState } from 'react';
import { supabase, type EventRow, type ProxyKey } from '@/lib/supabase';
import { fetchActivePolicy, refreshEvents } from '@/lib/data';
import { DEFAULT_POLICY, type PolicyConfig } from '@/lib/policy';
import { Hero, QuickStart, TrafficTable, UsageBanner, StatPills } from '@/components/Dashboard';
import { EventDrawer } from '@/components/EventDrawer';
import { ReviewQueue } from '@/components/ReviewQueue';
import { Playground } from '@/components/Playground';
import { KeysPage } from '@/components/KeysPage';
import { Stats } from '@/components/Stats';
import { PolicyPanel } from '@/components/PolicyPanel';

export default function App() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [keys, setKeys] = useState<ProxyKey[]>([]);
  const [keyUsage, setKeyUsage] = useState<Record<string, number>>({});
  const [policy, setPolicy] = useState<PolicyConfig>(DEFAULT_POLICY);
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [limitReached, setLimitReached] = useState(false);

  const reload = useCallback(async () => {
    const [evts, keyRows, usageRes] = await Promise.all([
      refreshEvents(60),
      supabase.from('proxy_keys').select('id, name, mode, revoked, created_at').order('created_at', { ascending: false }).returns<ProxyKey[]>(),
      supabase.from('usage_counters').select('fn, calls').eq('day', new Date().toISOString().slice(0, 10)),
    ]);
    setEvents(evts);
    setKeys(keyRows.data ?? []);
    const usage: Record<string, number> = {};
    let total = 0;
    for (const row of (usageRes.data ?? []) as { fn: string; calls: number }[]) {
      total += row.calls;
      if (row.fn.startsWith('key:')) usage[row.fn.slice(4)] = row.calls;
    }
    setKeyUsage(usage);
    setLimitReached(total >= 200);
  }, []);

  useEffect(() => {
    (async () => {
      await reload();
      setPolicy(await fetchActivePolicy());
      setLoading(false);
    })();
  }, [reload]);

  const upstreamMode: 'live' | 'mock' | 'unknown' =
    keys.length === 0 ? 'unknown' : keys.some((k) => k.mode === 'live') ? 'live' : 'mock';

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 pb-16">
        <Hero mode={upstreamMode} />
        <UsageBanner />

        {loading ? (
          <p className="py-16 text-center text-zinc-500">Loading console…</p>
        ) : (
          <div className="space-y-6">
            <StatPills events={events} />
            <QuickStart keys={keys} />
            <div className="grid lg:grid-cols-2 gap-6 items-start">
              <TrafficTable events={events} onSelect={setSelected} />
              <ReviewQueue events={events} onReviewed={reload} />
            </div>
            <Playground onSent={reload} limitReached={limitReached} />
            <Stats events={events} />
            <PolicyPanel config={policy} onChange={setPolicy} />
            <KeysPage keys={keys} usage={keyUsage} onChanged={reload} />
          </div>
        )}
      </div>
      {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
