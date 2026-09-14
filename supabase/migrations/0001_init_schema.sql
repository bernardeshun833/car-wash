-- Kumasi Car Wash — core schema.
--
-- Adapted from the barbershop POS schema. The shape of the system is the same
-- (append-only POS rows, independent MoMo feed, physical cash count, nightly
-- cross-check); what changed is the vocabulary, the multi-branch key, and one
-- genuinely new source of truth — vehicle_count_events — that the barbershop
-- had no equivalent of.
--
-- This runs against its own Supabase project. Nothing here is shared with the
-- barbershop: separate database, separate MoMo merchant account, separate
-- credentials. There is deliberately no cross-project foreign key, view or
-- reference anywhere in this repo.

create extension if not exists pgcrypto;

-- Every table carries branch_id from day one even though one branch exists
-- today. Retrofitting a tenant key onto append-only tables means rewriting
-- history you have promised never to rewrite, so the cheap move is to carry
-- it from the first row.
create table branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Africa/Accra',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- The single branch that exists today. Seeding it here rather than in seed.sql
-- means the default below is valid in production, not only in dev.
insert into branches (id, name)
values ('00000000-0000-0000-0000-00000000b1a1', 'Kumasi — main site');

create table attendants (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  name text not null,
  -- PBKDF2-SHA256 of the attendant's PIN, never the raw PIN. The tablet must
  -- verify PINs while offline, so these necessarily sync down to the device;
  -- a per-attendant salt and a high iteration count raise the cost of brute
  -- forcing a 4-digit PIN off a stolen tablet. See docs/security.md — PIN
  -- gating is an attribution and timestamping mechanism, not a defence
  -- against someone holding the device.
  pin_hash text not null,
  pin_salt text not null,
  pin_iterations integer not null default 200000,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index attendants_branch_idx on attendants (branch_id);

-- Spec calls this `vehicles_or_services`: the price list is keyed by the kind
-- of wash sold, not by any identified vehicle. Nothing in this system stores
-- a plate, a make or an owner.
create table vehicles_or_services (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  wash_type text not null,
  price numeric(10,2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index vehicles_or_services_branch_idx on vehicles_or_services (branch_id);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  attendant_id uuid not null references attendants(id),
  service_id uuid not null references vehicles_or_services(id),
  amount numeric(10,2) not null,
  payment_method text not null check (payment_method in ('cash', 'momo', 'qr', 'card')),

  -- Corrections are new rows referencing the original (append-only, always).
  -- A void is a correction row carrying the negative of the original amount,
  -- so totals net out under a plain SUM while both rows stay visible.
  corrects_transaction_id uuid references transactions(id),

  -- Only a correction row may be negative.
  constraint transactions_amount_sign check (
    amount >= 0 or corrects_transaction_id is not null
  ),

  created_at_local timestamptz not null,        -- set ON THE TABLET at entry time
  synced_at timestamptz not null default now(), -- set SERVER-SIDE on insert
  device_id text not null
);

create index transactions_created_at_local_idx on transactions (created_at_local);
create index transactions_attendant_id_idx on transactions (attendant_id);
create index transactions_device_id_idx on transactions (device_id);
create index transactions_payment_method_idx on transactions (payment_method);
create index transactions_corrects_idx on transactions (corrects_transaction_id);
create index transactions_branch_date_idx on transactions (branch_id, created_at_local);

create table momo_payments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  external_ref text not null unique,  -- MoMo reference; the idempotency key for the feed
  amount numeric(10,2) not null check (amount >= 0),
  timestamp timestamptz not null,

  -- Kept because the spec's data model names it. It is only ever written at
  -- insert time, and in practice the feed never knows a match, so it is
  -- effectively always null. Match state lives in transaction_matches
  -- (migration 0002) because recording a match must not require an UPDATE of
  -- a table this system promises never to update. Read matches through the
  -- momo_payments_matched view rather than this column.
  matched_txn_id uuid references transactions(id),

  fetched_at timestamptz not null default now()
);

create index momo_payments_timestamp_idx on momo_payments (timestamp);
create index momo_payments_branch_idx on momo_payments (branch_id);

create table cash_counts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  shift_date date not null,
  counted_by text not null,      -- both counters, e.g. "Ama & Kofi" — two-person count at close
  expected numeric(10,2) not null,
  actual numeric(10,2) not null,
  variance numeric(10,2) generated always as (actual - expected) stored,
  opening_float numeric(10,2) not null default 0,
  notes text,
  device_id text not null,
  created_at_local timestamptz not null,
  synced_at timestamptz not null default now(),

  -- A later count for the same shift supersedes the earlier one rather than
  -- replacing it. Both rows stay, exactly like a voided transaction.
  --
  -- There is deliberately NO unique constraint on (branch_id, shift_date).
  -- Having one looked right — one count per shift is the SOP — but it made a
  -- mistyped count permanent and unfixable, and worse, it broke the queue: a
  -- second count carries a new id, so the sync engine's id-based upsert could
  -- not absorb it, the insert failed on the date constraint, and the row
  -- retried forever while the tablet showed "1 waiting to sync" that never
  -- cleared. Append-only is about not rewriting history; it is not a reason to
  -- make a typo permanent or to wedge the queue.
  --
  -- Optional and only for a correction: which count this one replaces. Null on
  -- the first count of a shift.
  supersedes_id uuid references cash_counts(id)
);

create index cash_counts_branch_date_idx on cash_counts (branch_id, shift_date);
create index cash_counts_supersedes_idx on cash_counts (supersedes_id);

-- ---------------------------------------------------------------------------
-- NEW — no barbershop equivalent.
--
-- One row per vehicle that entered the wash zone. The zone is the whole open
-- wash area: there are no fixed bays, cars park wherever there is space, so
-- there is exactly one zone per branch and no bay identity to record.
--
-- Presence-based only. The tracker assigns a temporary id to a vehicle while
-- it is in frame; that id is meaningless once the vehicle leaves and is never
-- matched to any later visit. No plate reading, no vehicle identification, no
-- image is stored here or anywhere else.
--
-- Every increment in the in-zone count — one new vehicle entering — is one
-- row. Departures are not rows: the count field carries the occupancy the
-- tracker observed at that moment, and arrivals are what the reconciliation
-- compares against transactions.
-- ---------------------------------------------------------------------------
create table vehicle_count_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  event_time timestamptz not null,      -- when the vehicle entered the zone, per the feed
  in_zone_count integer not null check (in_zone_count >= 0),
  device_id text not null,              -- the counting unit, not the POS tablet

  -- Additive to the spec's column list, and load-bearing:
  --
  -- track_ref     the tracker's temporary id for this vehicle. Kept for
  --               debugging a disputed count and for spotting id churn; it
  --               identifies a track, never a vehicle.
  -- source        which adapter produced the row ("mock", or a vendor name
  --               once one is chosen). Lets a vendor swap be audited rather
  --               than silently changing what the numbers mean.
  -- idempotency_key  the counting agent retries over a bad link; this is what
  --               makes a retry land once. Unique per branch.
  track_ref text,
  source text not null default 'unknown',
  idempotency_key text not null,
  recorded_at timestamptz not null default now(),

  unique (branch_id, idempotency_key)
);

create index vehicle_count_events_time_idx on vehicle_count_events (event_time);
create index vehicle_count_events_branch_time_idx on vehicle_count_events (branch_id, event_time);
create index vehicle_count_events_device_idx on vehicle_count_events (device_id);

-- Device liveness, for POS tablets and counting units alike. Silence from
-- either is a signal, not an absence of one: a counting unit that dies makes
-- the vehicle-vs-POS check read as "nothing unlogged today", which is the
-- most dangerous way for it to fail.
create table device_heartbeats (
  device_id text primary key,
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  device_kind text not null default 'pos' check (device_kind in ('pos', 'counter')),
  last_synced_at timestamptz not null default now(),
  last_seen_ip inet
);

-- Output of the nightly reconciliation job, stored to build the historical
-- baseline the rolling-median checks depend on.
create table reconciliation_reports (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  business_date date not null,
  severity text not null check (severity in ('NONE', 'LOW', 'MEDIUM', 'HIGH')),
  revenue_total numeric(10,2) not null,
  txn_count integer not null,
  vehicle_count integer not null default 0,
  report jsonb not null,          -- full structured report (see reconciliation.ts BusinessDateReport)
  created_at timestamptz not null default now(),

  unique (branch_id, business_date)
);

create index reconciliation_reports_date_idx on reconciliation_reports (branch_id, business_date);
