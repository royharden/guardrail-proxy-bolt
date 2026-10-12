/*
# Security hardening

1. usage_counters
- RLS stays on; every policy on the table is dropped and all anon/authenticated
  privileges are revoked, so the browser cannot read or write counters.
- New `increment_usage(p_fn text)` SECURITY DEFINER function does an atomic
  INSERT ... ON CONFLICT (day, fn) DO UPDATE ... RETURNING calls for today (UTC).
  EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to service_role,
  so only Edge Functions (service-role client) can increment counters.

2. proxy_keys
- All anon/authenticated policies and privileges are removed (including the column
  grants from the first migration). The table, and `key_hash` with it, is no longer
  readable or writable by the browser.
- New `proxy_keys_public` view exposes only id, name, mode, revoked, created_at.
  It runs with its owner's rights (not security_invoker) so it works without table
  privileges, and anon/authenticated only get SELECT on it.

3. events, policies
- All INSERT/UPDATE/DELETE (and ALL) policies are dropped and the matching
  privileges revoked from anon/authenticated. anon/authenticated keep SELECT so the
  dashboard can read. All writes go through Edge Functions with the service role.
*/

-- Drop every policy on usage_counters and proxy_keys, and every non-SELECT policy on
-- events and policies, including any created outside the first migration.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        tablename IN ('usage_counters', 'proxy_keys')
        OR (tablename IN ('events', 'policies') AND cmd <> 'SELECT')
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxy_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

-- usage_counters: no client access at all.
REVOKE ALL ON public.usage_counters FROM anon, authenticated;

-- proxy_keys: no client access to the table; the view below is the only read path.
REVOKE SELECT (id, name, key_hash, mode, revoked, created_at) ON public.proxy_keys FROM anon, authenticated;
REVOKE UPDATE (key_hash) ON public.proxy_keys FROM anon, authenticated;
REVOKE ALL ON public.proxy_keys FROM anon, authenticated;

-- events / policies: read-only for clients.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.policies FROM anon, authenticated;
GRANT SELECT ON public.events TO anon, authenticated;
GRANT SELECT ON public.policies TO anon, authenticated;

DROP POLICY IF EXISTS "anon can read events" ON public.events;
CREATE POLICY "anon can read events" ON public.events FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon can read policies" ON public.policies;
CREATE POLICY "anon can read policies" ON public.policies FOR SELECT TO anon, authenticated USING (true);

-- Edge Functions use the service role for every write.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_counters TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.proxy_keys TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.policies TO service_role;

-- Browser-safe projection of proxy_keys (no key_hash). Owner-rights view on purpose:
-- clients have no privileges on the base table.
CREATE OR REPLACE VIEW public.proxy_keys_public AS
  SELECT id, name, mode, revoked, created_at
  FROM public.proxy_keys;

-- Supabase default privileges grant ALL on new relations to anon/authenticated, and a
-- single-table view is auto-updatable, so strip everything but SELECT.
REVOKE ALL ON public.proxy_keys_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.proxy_keys_public TO anon, authenticated;
GRANT SELECT ON public.proxy_keys_public TO service_role;

COMMENT ON VIEW public.proxy_keys_public IS
  'Read-only, key_hash-free projection of proxy_keys for the dashboard.';

-- Atomic per-day counter used for the daily caps. Returns the new count.
CREATE OR REPLACE FUNCTION public.increment_usage(p_fn text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.usage_counters (day, fn, calls)
  VALUES ((now() AT TIME ZONE 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn) DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(text) TO service_role;
