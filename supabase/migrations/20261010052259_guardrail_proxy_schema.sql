/*
# Guardrail Proxy demo schema

1. New Tables
- `proxy_keys` — API keys for the OpenAI-compatible proxy endpoint.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `name` (text, human-readable key name)
  - `key_hash` (text, unique, SHA-256 hex of the `gp_...` plaintext key — never sent to the browser)
  - `mode` (text, 'live' or 'mock' upstream behavior)
  - `revoked` (boolean, soft revoke flag)
  - `created_at` (timestamptz, default now())
- `events` — one row per Jev screening (input or output stage).
  - `id` (uuid pk), `key_id` (uuid, nullable fk -> proxy_keys)
  - `stage` (text, 'input' or 'output')
  - `original_text`, `redacted_text` (text)
  - `jev_request`, `jev_response` (jsonb), `model` (text), `latency_ms` (int)
  - `input_tokens` (int), `cost_usd` (numeric)
  - `decision` (text, 'pass'|'redact'|'flag'|'block'), `fired_rules` (jsonb)
  - `review_status` (text, 'none'|'pending'|'approved'|'rejected')
  - `upstream_response` (text), `upstream_latency_ms` (int), `created_at` (timestamptz)
- `policies` — saved threshold configurations.
  - `id` (uuid pk), `name` (text), `config` (jsonb), `active` (bool), `created_at`
- `usage_counters` — per-day, per-function call counters for the demo rate limit.
  - `day` (date, pk part), `fn` (text, pk part), `calls` (int)

2. Security
- RLS enabled on all four tables.
- Permissive anon + authenticated policies (single public demo workspace, no sign-in).
- Column-level privileges: `proxy_keys.key_hash` is revoked from anon/authenticated
  so the browser client can never read or modify key hashes.
- Indexes on events(created_at desc), events(review_status), events(key_id).

3. Notes
- Edge functions use the service role key and bypass RLS entirely.
*/

CREATE TABLE IF NOT EXISTS proxy_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text UNIQUE NOT NULL,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'mock')),
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid REFERENCES proxy_keys(id) ON DELETE SET NULL,
  stage text NOT NULL CHECK (stage IN ('input', 'output')),
  original_text text,
  redacted_text text,
  jev_request jsonb,
  jev_response jsonb,
  model text,
  latency_ms int,
  input_tokens int,
  cost_usd numeric,
  decision text NOT NULL CHECK (decision IN ('pass', 'redact', 'flag', 'block')),
  fired_rules jsonb,
  review_status text NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'pending', 'approved', 'rejected')),
  upstream_response text,
  upstream_latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  config jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_review_status_idx ON events (review_status) WHERE review_status = 'pending';
CREATE INDEX IF NOT EXISTS events_key_id_idx ON events (key_id);

ALTER TABLE proxy_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read proxy keys" ON proxy_keys;
CREATE POLICY "anon can read proxy keys" ON proxy_keys FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon can insert proxy keys" ON proxy_keys;
CREATE POLICY "anon can insert proxy keys" ON proxy_keys FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon can update proxy keys" ON proxy_keys;
CREATE POLICY "anon can update proxy keys" ON proxy_keys FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete proxy keys" ON proxy_keys;
CREATE POLICY "anon can delete proxy keys" ON proxy_keys FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon can read events" ON events;
CREATE POLICY "anon can read events" ON events FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon can insert events" ON events;
CREATE POLICY "anon can insert events" ON events FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon can update events" ON events;
CREATE POLICY "anon can update events" ON events FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete events" ON events;
CREATE POLICY "anon can delete events" ON events FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon can read policies" ON policies;
CREATE POLICY "anon can read policies" ON policies FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon can insert policies" ON policies;
CREATE POLICY "anon can insert policies" ON policies FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon can update policies" ON policies;
CREATE POLICY "anon can update policies" ON policies FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete policies" ON policies;
CREATE POLICY "anon can delete policies" ON policies FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon can read usage counters" ON usage_counters;
CREATE POLICY "anon can read usage counters" ON usage_counters FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon can insert usage counters" ON usage_counters;
CREATE POLICY "anon can insert usage counters" ON usage_counters FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon can update usage counters" ON usage_counters;
CREATE POLICY "anon can update usage counters" ON usage_counters FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete usage counters" ON usage_counters;
CREATE POLICY "anon can delete usage counters" ON usage_counters FOR DELETE TO anon, authenticated USING (true);

-- Never let the browser client read or write key hashes.
REVOKE UPDATE (key_hash) ON proxy_keys FROM anon, authenticated;
GRANT SELECT (id, name, mode, revoked, created_at) ON proxy_keys TO anon, authenticated;
REVOKE SELECT (key_hash) ON proxy_keys FROM anon, authenticated;
