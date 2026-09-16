# Kumasi Car Wash — POS + Reconciliation

Offline-first point of sale for the wash yard, plus a nightly job that
cross-checks what was logged against what actually happened.

The wash is in Kumasi; the owner is not there most days. Attendants log every
wash on a tablet over unreliable connectivity. The system's job is to give the
owner honest daily visibility without being on site.

**This is its own deployment.** Own Supabase project, own database, own
accounts. It is adapted from the barbershop POS, but it is a separate business:
no shared infrastructure, no shared MoMo merchant account, no shared data, and
no code path that reaches across.

## How it fits together

```
Tablet (React PWA)                Supabase                     Owner
┌────────────────────┐     ┌──────────────────────┐      ┌──────────┐
│ PIN → wash entry   │     │ transactions         │      │ Email    │
│        ↓           │push │  (append-only)       │      │ every    │
│ IndexedDB queue    │────▶│ cash_counts          │      │ day      │
│  (durable first)   │ ~2m │ momo_payments   ◀────┼─ MTN │          │
│        ↓           │     │ vehicle_count_events │ (off)│ WhatsApp │
│ sync engine        │     │        ▲             │      │ on       │
└────────────────────┘     │        │             │      │ MEDIUM+  │
                           │        │ ingest fn   │      └──────────┘
Counting unit (yard)       │        │             │
┌────────────────────┐     │        ↓             │
│ zone sampler 2s    │────▶│ nightly job 20:30 ───┼────────▶
│ → arrival events   │     └──────────────────────┘
└────────────────────┘
```

## What this is, relative to the barbershop

Most of this was adaptation, and it is worth being precise about which parts.

| | |
|---|---|
| **Transferred as-is** | Offline-first PWA with an IndexedDB queue and a sync engine; append-only records where corrections are new rows; the severity-tiered reconciliation model and the daily report that arrives clean or not; the cash SOP assumptions (capped float, excess to the safe). |
| **Renamed and reshaped** | `barbers` → `attendants`, `services` → `vehicles_or_services` (`wash_type`), "cuts" → "washes" throughout. `branch_id` added to every table. Settings moved from one global row to per-branch. Append-only enforcement widened from `transactions` alone to every table that records an event. |
| **Changed on contact with the yard** | PIN moved from per-transaction to once at unlock — one attendant typing the same four digits for every car was friction that pushed logging to "later, from memory", which is worth nothing to the reconciliation. The cash count went blind (no expected figure on screen). The count itself is correctable, because append-only should not mean a typo is permanent. |
| **Genuinely new** | `vehicle_count_events` and everything behind it — the counting interface, the zone tracker, the agent, the ingest endpoint — plus the fourth reconciliation check that compares vehicles counted against washes logged. The barbershop has no equivalent and could not have one. |

## Cash only for now

The wash takes **cash only** today, and the system is built for that rather
than merely tolerating it. `branch_settings.momo_enabled` is `false`:

- the tablet offers cash only, and skips the payment step entirely, because a
  one-option choice is a tap that teaches people to tap without reading;
- Check A is **skipped, not passed** — the report says "cash only — not
  checked" rather than showing a tidy zero variance against a feed that does
  not exist;
- if a digital wash does get logged, or money arrives from a feed nobody
  configured, that gets one clear MEDIUM flag saying the settings no longer
  match the business.

Turning MoMo on later is one flag and the MoMo secrets:

```sql
update branch_settings set momo_enabled = true;
```

```bash
supabase secrets set MOMO_BASE_URL=... MOMO_SUBSCRIPTION_KEY=... \
  MOMO_API_USER=... MOMO_API_KEY=...
```

No schema change and no new tablet build: `momo_payments`, the matching logic
and the digital columns are already here and already tested
(`tests/cash-only.test.ts` covers the switch in both positions).

**Worth understanding while it is off.** MoMo is the strongest check in the
system, because that data comes from MTN rather than from staff. Without it the
independent evidence is the physical cash count and the vehicle count — which
is exactly why the vehicle counter matters more here than it would at a
business taking most of its money digitally. An unlogged cash wash is invisible
to every other check by construction.

## The four checks

Runs at 20:30, 90 minutes after close.

- **A — digital declared vs digital received.** Each MoMo payment matched to a
  digital wash on exact amount within 15 minutes; closest in time wins where
  several qualify. Unmatched either way is HIGH. *Skipped while cash-only.*
- **B — cash declared vs cash counted.** `expected_cash` is recomputed
  server-side from POS rows, so the figure shown on the tablet cannot paper
  over a variance. Over threshold is MEDIUM; a missing count is also MEDIUM.
- **C — volume sanity.** Rolling median of the same weekday over 8 weeks, and
  per attendant over 30 days. Skipped entirely until there is history — a
  median over an empty window is worse than no check.
- **D — vehicles counted vs washes logged. (new)** Cars that entered the zone
  against washes rung up over the same window. The surplus direction is the
  leakage case and tiers LOW → MEDIUM → HIGH by percentage above an absolute
  tolerance. The shortfall direction means the feed is missing cars, caps at
  MEDIUM, and says so in those words. A feed that is enabled but silent all day
  is MEDIUM — the counting equivalent of a dead tablet, and the most dangerous
  way for this check to fail is to read as "everything was logged".

Severity is the max across all checks. The report is emailed **every day, clean
or not** — a report that only arrives when something is wrong teaches the reader
that silence means fine, and silence is exactly what a dead device produces.
WhatsApp fires only at MEDIUM or above.

## History, for the owner

Previous months in the app rather than the Supabase dashboard: takings, each
day's washes and voids, vehicles counted, the nightly job's verdict, and a tap
on any day for the individual washes.

Behind the **owner's** PIN, set once in the SQL editor:

```sql
select set_owner_pin('<your PIN>');
```

Not the shift PIN, and not merely a hidden tab. The PIN is checked in the
database and never on the device; the device's own read of `transactions`
narrows to two days; and synced rows older than that are dropped from the phone
on every sync. See `docs/history.md` for why each of those three is needed for
the other two to mean anything.

## The vehicle counter

The piece with no barbershop equivalent. See `docs/vehicle-counting.md` for the
design and the vendor-selection checklist; in short:

- **One zone** covering the whole open wash area. There are no fixed bays — cars
  park wherever there is space — so there is one zone and no bay identity.
- **Presence only.** A temporary track id while a vehicle is in frame. No plate
  reading, no vehicle identification, no images stored anywhere. A track id is
  meaningless once the car leaves and is never linked to a later visit.
- **One row per arrival.** Every increment in the zone count is one event row.
- **Sampled every 2 seconds**, against a ceiling of 25s that the agent enforces
  at startup — it refuses to run too slowly rather than under-count quietly.
  The arithmetic is in `counting/src/sampling.ts`. Identity tracking, not count
  differencing, is what catches a back-to-back swap: when one car leaves and
  another takes its space between samples the occupancy never changes, so
  differencing counts would lose a whole wash.
- **No vendor is hardcoded.** Nothing is chosen or quoted yet, so everything is
  built against `VehicleCountSource` — an interface whose entire contract is
  "which track ids are in the zone right now". The mock implementations in
  `counting/src/mock-source.ts` are what the agent and the tests run against.
  Adopting a vendor is one new file implementing that interface.

```bash
npm run count-agent      # runs against the simulated feed
```

## Trying it without setting anything up

```bash
npm install
npm test          # the reconciliation logic — 93 tests, no backend needed
npm run dev:demo  # the whole tablet app, no Supabase, no account, no keys
```

Demo mode builds the attendant and price lists into the app and keeps
everything on the device. It is for judging the screens on a real phone before
committing to any infrastructure; it cannot show the nightly report, which runs
server-side.

The deployed site is built by Cloudflare from `main` and served on its own
domain. HTTPS is not optional here: browsers withhold `crypto.subtle` outside a
secure context, so PIN verification cannot run over a plain LAN address.

Full instructions, including the phone and the local Supabase stack, are in
`docs/testing.md`.

## Running it locally

```bash
npm install
cp .env.example .env.local      # fill in VITE_SUPABASE_URL and the anon key
npm run dev
```

```bash
npm test        # reconciliation + counting logic — 71 tests, no backend needed
npm run lint    # typecheck
npm run build   # production PWA bundle + service worker
```

The reconciliation logic and the zone tracker are both pure, with no Supabase
or Deno dependencies, so the checks and the counting behaviour can be developed
and tested without a backend or a camera.

## Deploying

```bash
supabase link --project-ref <car-wash-project-ref>   # NOT the barbershop's
supabase db push                                     # migrations 0001–0006
supabase db execute --file supabase/seed.sql         # dev/demo data only

supabase secrets set \
  COUNTING_INGEST_SECRET=... \
  RESEND_API_KEY=... REPORT_FROM_EMAIL=... \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM=...

supabase functions deploy vehicle-count-ingest
supabase functions deploy nightly-reconciliation
supabase functions deploy momo-sync      # only once MoMo is live
```

Migration 0005 schedules the jobs with pg_cron. Before it runs, store the two
secrets it reads in Vault:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```

(Not `alter database postgres set app.settings.*` — that needs superuser, which
hosted Supabase does not grant, and the nightly job would fire on time with
nothing to read. A reconciliation that never runs looks exactly like a night
with nothing to report.)

Check it actually fired:

```sql
select * from cron.job_run_details order by start_time desc limit 5;
```

Then set the owner's contact details and any threshold you want to tune:

```sql
update branch_settings set owner_email = '...', owner_whatsapp = '+44...';
```

Add real attendants with `npm run hash-pin -- 4821`, which prints the
`pin_hash`/`pin_salt`/`pin_iterations` to insert. Never store a raw PIN.

### Tablet setup

Serve the built app over HTTPS and add it to the home screen — it installs as a
standalone PWA. Provision the device once with `VITE_DEVICE_EMAIL` /
`VITE_DEVICE_PASSWORD` (a single Supabase account representing the site
device), and let it sync once while online so the attendant and price lists are
cached. After that it works with no connection.

### Counting unit setup

The agent runs on a small box at the yard. It holds **no Supabase key** — only
the ingest URL and a shared secret, so the worst a stolen counting-unit secret
does is inject fake arrivals, which shows up in the nightly report loudly
rather than hiding anything. Set `COUNTING_*` from `.env.example` and run
`npm run count-agent`. Until a counting unit is installed, leave
`vehicle_counting_enabled` false so Check D reports as skipped rather than
clean.

Re-run a missed night by hand:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/nightly-reconciliation?date=2026-09-13" \
  -H "Authorization: Bearer <service-role-key>"
```

## Open questions this build does not assume away

- **Attendant headcount is unconfirmed.** PIN-per-transaction is built
  regardless. Even if it turns out one person works every shift, making
  attribution moot, the PIN step is what stamps an entry with a verified
  moment in time, and the reconciliation windows are built on those timestamps.
  It is cheap to keep and expensive to add back later.
- **No counting vendor is chosen or priced.** Hence the mock interface, and
  hence `vehicle_counting_enabled` defaulting to false.
- **MoMo is not live.** Hence `momo_enabled` defaulting to false, as above.

## Out of scope

CCTV, the cash safe and till hardware (source locally); the written
cash-handling SOP (a procedure, not a feature); and anything addressing
attendant–manager collusion, which software does not solve.

Read `docs/security.md` for what these checks actually guarantee — and what
they don't.
