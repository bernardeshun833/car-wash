-- Row Level Security.
--
-- Auth model: the tablet signs in as ONE Supabase account (the site device).
-- Attendants do not have Supabase accounts — they are identified per
-- transaction by PIN. So `authenticated` here means "the POS tablet", and the
-- owner reads reports out of band (email) or via the service role.
--
-- The counting unit is NOT `authenticated`. It posts to an edge function with
-- its own shared secret (migration 0006 / functions/vehicle-count-ingest) so
-- an on-site box never holds a Supabase key at all.

alter table branches enable row level security;
alter table attendants enable row level security;
alter table vehicles_or_services enable row level security;
alter table transactions enable row level security;
alter table momo_payments enable row level security;
alter table cash_counts enable row level security;
alter table vehicle_count_events enable row level security;
alter table device_heartbeats enable row level security;
alter table reconciliation_reports enable row level security;
alter table transaction_matches enable row level security;
alter table branch_settings enable row level security;

-- The tablet reads the attendant and price lists so it can work offline, and
-- can never modify either catalogue.
create policy device_reads_branches on branches
  for select to authenticated using (true);

create policy device_reads_attendants on attendants
  for select to authenticated using (true);

create policy device_reads_services on vehicles_or_services
  for select to authenticated using (true);

-- Transactions: insert-only for the tablet. UPDATE/DELETE are already revoked
-- and trigger-blocked in 0002; no policy for them exists here either.
create policy device_inserts_transactions on transactions
  for insert to authenticated with check (true);

create policy device_reads_transactions on transactions
  for select to authenticated using (true);

-- Cash counts: the manager enters them, they are not revisable by the device.
create policy device_inserts_cash_counts on cash_counts
  for insert to authenticated with check (true);

create policy device_reads_cash_counts on cash_counts
  for select to authenticated using (true);

-- Heartbeats: a device reports its own liveness and nothing else.
create policy device_inserts_heartbeat on device_heartbeats
  for insert to authenticated with check (true);

create policy device_updates_heartbeat on device_heartbeats
  for update to authenticated using (true) with check (true);

create policy device_reads_heartbeats on device_heartbeats
  for select to authenticated using (true);

-- The tablet reads settings (opening float, business hours) to render the
-- cash count screen. It cannot change thresholds.
create policy device_reads_settings on branch_settings
  for select to authenticated using (true);

-- momo_payments, vehicle_count_events, transaction_matches and
-- reconciliation_reports are written exclusively by edge functions running as
-- the service role, which bypasses RLS. Deliberately no `authenticated`
-- policies: the tablet has no business reading MoMo data, vehicle counts or
-- reconciliation output — that would let whoever holds the device see exactly
-- which checks are about to fire, and the vehicle count is only useful as a
-- check precisely because the person logging sales cannot see it.
