-- Scheduling. Requires pg_cron and pg_net (both available on Supabase).
--
-- Before applying, set the two settings the jobs need — these hold the project
-- URL and the service role key used to invoke the edge functions. Note these
-- are THIS project's values; the car wash runs on its own Supabase project and
-- shares nothing with the barbershop deployment:
--
--   alter database postgres set app.settings.project_url = 'https://<ref>.supabase.co';
--   alter database postgres set app.settings.service_role_key = '<service-role-key>';
--
-- Times are UTC. Ghana is UTC+0 year-round, so these are also local times.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- MoMo payments are pulled every 15 minutes through the day rather than once
-- at night: a single nightly pull would lose anything the MoMo API ages out,
-- and incremental pulls keep the reconciliation job fast.
select cron.schedule(
  'momo-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.project_url') || '/functions/v1/momo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Nightly reconciliation at 20:30 local — 90 minutes after the 19:00 close,
-- which gives the manager time to finish the two-person cash count and both
-- the tablet and the counting unit time to drain their queues.
select cron.schedule(
  'nightly-reconciliation',
  '30 20 * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.project_url') || '/functions/v1/nightly-reconciliation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
