# What this system actually guarantees

Worth being precise about, because the gap between "tamper-evident" and
"tamper-proof" is where false confidence lives.

## Separation from the barbershop is a deployment fact, not a code fact

This runs on its own Supabase project with its own database, keys, and (when it
exists) its own MoMo merchant account. Nothing in this repo references the
barbershop deployment, and there is no cross-project foreign key, view or
client.

But the separation is only as real as the values in `.env` and
`supabase link`. Pointing this app at the barbershop's project would merge two
businesses' takings and nothing in the code would notice — both schemas have a
`transactions` table. Check the project ref before `db push`.

## The append-only guarantee is real

`transactions`, `cash_counts`, `momo_payments` and `vehicle_count_events` all
reject UPDATE and DELETE at the database level — a trigger that raises on
either, plus revoked grants (`supabase/migrations/0002`). There is no bypass for
the service role or the edge functions. Corrections are new rows carrying the
negative of the original amount and a `corrects_transaction_id` pointing at it,
so a cancelled wash shows up as a cancellation rather than as an absence.

This is wider than the barbershop, which guarded `transactions` alone. The
catalogue tables (`branches`, `attendants`, `vehicles_or_services`) stay
editable on purpose: a price change or a new attendant is configuration, not a
record of an event. Changing a price does not rewrite history, because
transactions store the amount charged rather than a reference to today's price.

Two consequences worth understanding:

**A mistake cannot be erased, only corrected.** This is intended. A system where
the manager can quietly fix a "typo" is a system where the manager can quietly
fix anything.

That cuts both ways, and the cash count is where the distinction matters. A
mistyped count is corrected by recording a second count that supersedes the
first; both rows stay, and the nightly report shows the revision and the figure
it replaced. What append-only forbids is *rewriting* the record — it was never
meant to make a typo permanent, and an earlier version of this schema that
enforced one count per shift did exactly that (and wedged the sync queue while
it was at it).

**Match state needed somewhere to live.** Recording that a transaction matched a
MoMo payment would require an UPDATE of an append-only table, so it lives in
`transaction_matches`, and `momo_payments.matched_txn_id` is read through the
`momo_payments_matched` view instead of being written.

The one thing the triggers do not cover is a superuser connecting directly to
Postgres and dropping them. That is the Supabase dashboard owner — the wash's
owner. If that key leaks, the guarantee is gone, and no application code
changes that.

## PIN verification is attribution and timestamping, not security

Attendants' PIN hashes sync down to the tablet, because PIN entry has to work
offline — that is a hard requirement, not an oversight. The hashes are
PBKDF2-SHA256 with a per-attendant salt at 200,000 iterations, which raises the
cost of a brute force but does not eliminate it: the PIN space is 10,000.
Somebody who steals the tablet, extracts IndexedDB, and is willing to spend
compute will recover every PIN.

So PINs answer "who washed this car?" under normal operation. They do not stop
someone who physically holds the device, and the design does not depend on them
doing so — the reconciliation checks are what catch misattribution, by
cross-referencing sources the person entering data does not control.

The headcount being unconfirmed does not weaken this, because the second job the
PIN does is independent of attribution: it stamps each entry with a verified
moment in time, and every reconciliation window is built on those timestamps.

## What the reconciliation can and cannot see

**Strong — but currently switched off: digital payments.** MoMo data comes from
MTN, not from staff. If a wash is logged as MoMo and no money arrived, or money
arrived with no wash logged, the numbers disagree and the report says so. This
is the check that is hardest to defeat from inside the yard — and while
`momo_enabled` is false it is not running at all. The report says "cash only —
not checked" rather than showing a clean variance, because a skipped check must
never read as a passed one.

**Moderate: cash against the physical count**, recomputed server-side from POS
data so a wrong `expected` typed on the tablet cannot paper over a variance.
Defeated by simply not logging the wash and pocketing the cash — the drawer
still balances against what was declared.

**The counter-check for that, and the reason the vehicle counter exists:
vehicles counted vs washes logged.** A car that entered the zone and produced no
transaction is directly observable, which is what separates this from the
barbershop's purely statistical volume check. Its limits are real and
documented in `docs/vehicle-counting.md`: the tracker over-counts on
reacquisition after a long occlusion, so the check carries an absolute tolerance
and tiers from LOW. It is evidence worth a question, not proof.

Because the wash is cash-only today, this is carrying weight it would not carry
elsewhere: with MoMo off, the only two checks against sources outside staff
control are the physical drawer count and this.

**Weak: volume.** Rolling medians against the same weekday. Kept because it is
free, tiered low because it is genuinely noisy.

**Invisible:** attendant–manager collusion, and anything requiring judgement
about whether a person is trustworthy. No amount of code addresses it.

## Silence is a signal, everywhere

A dead tablet and a dead counting unit both produce clean-looking days. That is
why the daily report is sent whether or not anything is wrong, why extended
device silence is flagged, and why a counting feed that is enabled but reports
nothing all day while washes were sold is a MEDIUM flag rather than a quiet
zero. The most dangerous failure in this system is a check that looks like it
passed when it never ran.
