import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { EventRow, PolicyRow } from '@/lib/supabase';
import { DEFAULT_POLICY, type PolicyConfig } from '@/lib/policy';

export function useEvents(limit = 50) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await selectEvents(limit);
      if (cancelled) return;
      if (error) setError(error.message);
      else setEvents(data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  return { events, loading, error, setEvents };
}

async function selectEvents(limit: number) {
  return supabase
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<EventRow[]>();
}

export async function fetchActivePolicy(): Promise<PolicyConfig> {
  const { data } = await supabase.from('policies').select('config').eq('active', true).maybeSingle<PolicyRow>();
  return { ...DEFAULT_POLICY, ...((data?.config as Partial<PolicyConfig>) ?? {}) };
}

export async function refreshEvents(limit = 50): Promise<EventRow[]> {
  const { data } = await selectEvents(limit);
  return data ?? [];
}

export async function fetchPendingCount(): Promise<number> {
  const { count } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('review_status', 'pending');
  return count ?? 0;
}
