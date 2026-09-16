-- Scheduling. Requires pg_cron and pg_net (both available on Supabase).
--
-- The project URL and service role key come from Supabase Vault.
--
-- The obvious alternative — `alter database postgres set app.settings.*`, read
-- back with current_setting() — does not work on hosted Supabase. Setting a
-- database parameter needs superuser, which the platform does not grant:
--
--   ERROR: 42501: permission denied to set parameter "app.settings.project_url"
--
-- A job scheduled that way fires on time and then fails with nothing to read,
-- which is the worst shape of failure this system has: a reconciliation that
-- never runs looks exactly like a night with nothing to report, and that
-- silence is precisely what the whole design exists to make impossible.
--
-- Before applying, store the two secrets (SQL editor, or Studio → Vault). Note
-- these are THIS project's values; the car wash runs on its own Supabase
-- project and shares nothing with the barbershop deployment:
--
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>', 'service_role_key');
--
-- To rotate the key later, update the secret — the jobs below need no edit:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'),
--     '<new-service-role-key>'
--   );
--
-- Times are UTC. Ghana is UTC+0 year-round, so these are also local times.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- MoMo payments are pulled every 15 minutes through the day rather than once
-- at night: a single nightly pull would lose anything the MoMo API ages out,
-- and incremental pulls keep the reconciliation job fast.
--
-- This one is harmless while the wash is cash-only: momo-sync returns early
-- when no MoMo credentials are configured.
select cron.schedule(
  'momo-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/momo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Nightly reconciliation at 20:30 local — 90 minutes after the 19:00 close,
-- which gives the manager time to finish the cash count and both the tablet
-- and the counting unit time to drain their queues.
select cron.schedule(
  'nightly-reconciliation',
  '30 20 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/nightly-reconciliation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Check the jobs are scheduled, and that a run actually fired:
--
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 5;
