-- Append-only, everywhere. No UPDATE, no DELETE — ever, for anyone, including
-- the service role. Corrections are new rows.
--
-- The barbershop guarded `transactions` alone. This spec says append-only
-- everywhere, so the guard covers every table that records something that
-- happened: transactions, cash_counts, momo_payments and vehicle_count_events.
-- The catalogue tables (branches, attendants, vehicles_or_services) are
-- editable on purpose — a price change or a new attendant is configuration,
-- not a record of an event, and versioning the price list is not what the
-- append-only rule is for. A price change does not rewrite history because
-- transactions store the amount charged, not a reference to today's price.
--
-- Enforced two ways, deliberately redundant:
--   1. A trigger that raises on any UPDATE/DELETE, so the failure message is
--      explicit and actionable instead of a bare permission error.
--   2. Revoked table privileges, so the statement is rejected before the
--      trigger runs for any role that is not the table owner (which Postgres
--      and Supabase cannot restrict — the trigger is what covers that gap).

create or replace function reject_row_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only: % is not permitted. Insert a new row instead (a correction row for transactions).',
    TG_TABLE_NAME, TG_OP
    using errcode = '42501';
  return null;
end;
$$;

create trigger transactions_no_update
  before update on transactions
  for each row execute function reject_row_mutation();

create trigger transactions_no_delete
  before delete on transactions
  for each row execute function reject_row_mutation();

create trigger cash_counts_no_update
  before update on cash_counts
  for each row execute function reject_row_mutation();

create trigger cash_counts_no_delete
  before delete on cash_counts
  for each row execute function reject_row_mutation();

create trigger momo_payments_no_update
  before update on momo_payments
  for each row execute function reject_row_mutation();

create trigger momo_payments_no_delete
  before delete on momo_payments
  for each row execute function reject_row_mutation();

create trigger vehicle_count_events_no_update
  before update on vehicle_count_events
  for each row execute function reject_row_mutation();

create trigger vehicle_count_events_no_delete
  before delete on vehicle_count_events
  for each row execute function reject_row_mutation();

-- The reconciliation job needs somewhere to record that a transaction was
-- matched to a MoMo payment. That state deliberately does NOT live as a column
-- update on either side: a `matched` flag would require an UPDATE and force an
-- exception into the guard above, weakening the guarantee for every other
-- caller. It lives in its own table, which is mutable because it holds a
-- derived opinion — recomputed from scratch on every run — rather than a
-- record of something that happened.
create table transaction_matches (
  transaction_id uuid primary key references transactions(id),
  momo_payment_id uuid not null references momo_payments(id),
  branch_id uuid not null references branches(id)
    default '00000000-0000-0000-0000-00000000b1a1',
  matched_at timestamptz not null default now()
);

create index transaction_matches_momo_idx on transaction_matches (momo_payment_id);

-- What momo_payments.matched_txn_id was meant to express, without the UPDATE.
create view momo_payments_matched as
  select
    p.*,
    m.transaction_id as matched_transaction_id,
    m.matched_at
  from momo_payments p
  left join transaction_matches m on m.momo_payment_id = p.id;

revoke update, delete on transactions, cash_counts, momo_payments, vehicle_count_events
  from public, authenticated, anon, service_role;

grant select, insert on transactions, cash_counts to authenticated, service_role;
grant select, insert on momo_payments, vehicle_count_events to service_role;
