-- Per-branch settings. The barbershop had a single-row `shop_settings` table;
-- with branch_id on everything from day one, settings are per branch too —
-- opening hours and float differ by site, and a threshold tuned for a busy
-- site should not silence a quiet one.
--
-- The reconciliation job reads its thresholds from here rather than
-- hard-coding them, so sensitivity can be tuned without a redeploy.
create table branch_settings (
  branch_id uuid primary key references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',

  opening_float numeric(10,2) not null default 200.00,
  open_time time not null default '07:00',
  close_time time not null default '19:00',
  timezone text not null default 'Africa/Accra',

  -- Severity thresholds
  digital_variance_pct_threshold numeric(6,2) not null default 1.0,
  cash_variance_threshold numeric(10,2) not null default 50.00,
  volume_drop_pct_threshold numeric(6,2) not null default 25.0,
  cash_ratio_spike_multiplier numeric(6,2) not null default 1.3,
  attendant_volume_drop_multiplier numeric(6,2) not null default 0.7,
  offline_gap_hours integer not null default 4,

  -- ---------------------------------------------------------------------
  -- Mobile money.
  --
  -- Off to start with: the wash takes cash only, and the MoMo merchant
  -- account (its own, separate from the barbershop's) is not registered yet.
  -- While this is false the POS offers cash only and Check A is skipped
  -- rather than run against a feed that does not exist — otherwise every
  -- night would report digital money that never arrived, and a report that
  -- cries wolf nightly stops being read.
  --
  -- Turning it on later is this one flag plus the MoMo secrets. No schema
  -- change, no redeploy of the tablet: momo_payments, the matching logic and
  -- the digital columns are all already here and already tested.
  --
  -- Worth knowing while it is off: MoMo is the strongest check in the system,
  -- because the data comes from MTN rather than from staff. Without it the
  -- independent evidence is the physical cash count and the vehicle count —
  -- which is exactly why the vehicle counter matters more here than it would
  -- in a business that takes most of its money digitally.
  -- ---------------------------------------------------------------------
  momo_enabled boolean not null default false,

  -- MoMo matching tolerances (exact amount, within a time window)
  momo_match_amount_tolerance numeric(10,2) not null default 0.01,
  momo_match_window_minutes integer not null default 15,

  -- ---------------------------------------------------------------------
  -- Vehicle count vs POS (the 4th comparison). Tiered like the other three.
  --
  -- vehicle_counting_enabled  false until a counting unit is installed at
  --     this branch. While false the check is skipped rather than reporting
  --     a clean zero — an absent feed must never read as "nothing unlogged".
  -- vehicle_settle_minutes  a car counted at the gate is paid for a little
  --     later; transactions are gathered with this much extra tail so the
  --     last wash of the day is not counted as unlogged.
  -- vehicle_count_tolerance  absolute slack before anything is said at all.
  --     Covers a delivery van turning around in the yard and the tracker's
  --     own id churn.
  -- The two pct thresholds are the LOW→MEDIUM and MEDIUM→HIGH steps on the
  -- surplus side (vehicles counted but no sale logged).
  -- ---------------------------------------------------------------------
  vehicle_counting_enabled boolean not null default false,
  vehicle_settle_minutes integer not null default 30,
  vehicle_count_tolerance integer not null default 2,
  vehicle_surplus_pct_medium numeric(6,2) not null default 10.0,
  vehicle_surplus_pct_high numeric(6,2) not null default 25.0,
  -- The shortfall side (more sales logged than vehicles seen) is a feed
  -- fault, not a theft signal, so it gets its own gentler threshold.
  vehicle_shortfall_pct_medium numeric(6,2) not null default 20.0,

  owner_email text,
  owner_whatsapp text
);

insert into branch_settings (branch_id)
values ('00000000-0000-0000-0000-00000000b1a1');
