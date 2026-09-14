# How to test this

Three ways, in increasing order of setup. Start at the top.

| | Needs | Tests |
|---|---|---|
| 1. Logic tests | nothing | the reconciliation rules |
| 2. Demo on your phone | nothing (GitHub Pages) or a laptop | the screens, on a real device |
| 3. Full local stack | Docker + Supabase CLI | everything, end to end |

---

## 1. Logic tests — 2 seconds, no setup

```bash
npm install
npm test
```

83 tests. No database, no camera, no network, no accounts. This is what proves
the parts nobody can eyeball: MoMo matching, cash variance, the vehicle-count
tiers, the cash-count correction rules.

```bash
npm run test:watch                              # re-runs as you edit
npx vitest run tests/cash-count-correction.test.ts   # one file
```

---

## 2. Demo mode — the app on a real phone, no backend

Demo mode runs the whole tablet app with **no Supabase, no account, no keys**.
The attendant list and price list are built in; everything logged lives in the
phone's own storage.

It tests the half you can only judge by touching: are the buttons big enough
with wet hands, is the PIN step quick enough with a queue of cars, is the cash
count screen readable in the sun. It **cannot** show the nightly report or the
reconciliation — those run server-side. That half is covered by `npm test`.

PINs: **Kofi 1234 · Ama 2345 · Yaw 3456**

### The easy way — GitHub Pages (no laptop needed after setup)

One-time: on GitHub, go to the repo → **Settings → Pages → Source: GitHub
Actions**. That's it.

Every push then builds the demo and publishes it to:

```
https://<your-username>.github.io/car-wash/
```

Open that on the phone → browser menu → **Add to Home screen**. It installs as
a proper app: full screen, no address bar, works with the phone in aeroplane
mode.

To publish without pushing: repo → **Actions → Deploy demo to GitHub Pages →
Run workflow**.

### The laptop way — for fast iteration

```bash
npm run dev:demo
```

Vite prints two addresses. The **Network** one (e.g. `http://192.168.1.42:5173`)
is reachable from your phone on the same Wi-Fi.

**Two things that will bite you on Windows:**

1. **Windows Firewall** pops up the first time — allow Node on *Private*
   networks, or the phone cannot reach the laptop.
2. **The phone will hit errors over `http://192.168.x.x`.** Browsers only give
   `crypto.subtle` and `crypto.randomUUID` to a "secure context" — HTTPS or
   localhost. A LAN IP is neither, so PIN checking breaks. This is why the
   GitHub Pages route exists; use the laptop browser for iteration and Pages
   for anything you actually tap through on the phone.

On the laptop itself, `http://localhost:5173` counts as secure and works fully
— Chrome DevTools (F12) → the device toolbar gives you a phone-sized view.

### Worth trying in demo mode

- **Log a few washes.** Attendant → wash type → PIN. Note there is no payment
  step: the wash is cash-only, so a single-option screen is skipped.
- **Void one** from the Today tab. The original stays, struck through, with a
  correction beside it. Nothing is ever deleted.
- **Cash count**, then **Record a corrected count** — the flow that used to be
  impossible. The earlier figure stays visible.
- **Aeroplane mode.** Everything keeps working. That is the whole design.
- **Reset** in the top bar clears the demo and starts over.

---

## 3. Full local stack — everything, end to end

Needs Docker Desktop and the Supabase CLI
(`npm i -g supabase`, or `scoop install supabase`).

```bash
supabase start        # prints API URL, anon key, service_role key
supabase db reset     # applies migrations 0001–0005 and seed.sql
```

Create `.env.local`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase start>
VITE_DEVICE_EMAIL=device@yourwash.example
VITE_DEVICE_PASSWORD=<any password>
```

**The step everyone misses:** the tablet signs in as a device account, and RLS
only lets `authenticated` read the attendant list. Create that user first —
Studio at `http://127.0.0.1:54323` → Authentication → Add user, matching the
email and password above. Skip it and you get "This tablet has no attendant
list saved yet."

```bash
npm run dev
```

### Run a night of reconciliation

```bash
supabase functions serve nightly-reconciliation --no-verify-jwt
# another terminal:
curl -X POST "http://127.0.0.1:54321/functions/v1/nightly-reconciliation?date=$(date +%F)"
```

Then in Studio's SQL editor:

```sql
select severity, report from reconciliation_reports order by business_date desc limit 1;
```

Without `RESEND_API_KEY` set, the report is stored but not emailed — the job
says so in its response rather than failing. That is deliberate: a mail outage
must never cost you a day of history.

### The cash-count regression, specifically

This is the sequence that used to wedge the sync queue:

1. Log a few cash washes.
2. Cash count → enter a deliberately wrong figure, e.g. `12400`. Record.
3. **Record a corrected count** → `1240`, with a reason. Record.
4. **Watch the sync bar go back to zero pending.** That is the actual test —
   before the fix, the second count stuck at "1 waiting to sync" forever,
   retrying against a unique constraint that could never be satisfied.

```sql
select actual, supersedes_id, notes from cash_counts order by created_at_local;
```

Two rows, the second pointing at the first, nothing overwritten. Re-run the
nightly job and the variance is computed against 1240, with a LOW
`cash_count_corrected` flag carrying the old figure.

### The counting agent

```bash
supabase functions serve vehicle-count-ingest --no-verify-jwt
COUNTING_INGEST_URL=http://127.0.0.1:54321/functions/v1/vehicle-count-ingest \
COUNTING_INGEST_SECRET=test npm run count-agent
```

`select count(*) from vehicle_count_events;` climbs as the simulated feed runs.

---

## What none of this tests

Wet hands, glare on the screen, a 2G connection, and whether an attendant with
a queue of cars actually bothers to log the wash. Run it alongside your current
method for a few days and compare the nightly report against what you would
have written down. That comparison is the real test.
