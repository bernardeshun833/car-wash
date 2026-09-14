# The vehicle counter

The one component with no barbershop equivalent, and the only signal in the
system that can see a wash that was never logged at all.

## Why it exists

An unlogged cash wash leaves no trace anywhere else. The drawer balances
against what was declared. MoMo never saw it — and while the wash is cash only,
MoMo sees nothing at all. The barbershop could only infer this statistically,
from volume being lower than a rolling median, which is a weak signal that
cannot separate a quiet Tuesday from a skimmed one.

A car that entered the yard and produced no transaction is a directly
observable fact. That is the whole point of this component.

## What it is allowed to know

Deliberately almost nothing:

- **One zone**, covering the entire open wash area. There are no fixed bays —
  cars park wherever there is space — so there is one zone per branch and no
  bay identity to record.
- **Presence only.** The tracker assigns a temporary id to a vehicle while it
  is in frame. That id is meaningless the moment the car leaves and is never
  matched against a later visit.
- **No identification.** No plates, no make, no colour, no owner. Two visits by
  the same car are two unrelated arrivals as far as this system is concerned.
- **No images.** The repo never receives, stores or forwards a frame of video.
  A vendor product will see images; nothing downstream of `sample()` does.

The data model reflects that: an event row carries a time, an occupancy count,
which unit reported it, and a track reference kept only for debugging a
disputed count.

## The interface

```ts
interface VehicleCountSource {
  readonly name: string;
  sample(): Promise<ZoneSample>;   // { at, tracks: string[] }
}
```

That is the entire contract: *which track ids are in the zone right now*.
Everything else — arrivals, occupancy, which events are worth storing — is
decided in `counting/src/zone-tracker.ts` against that interface.

No vendor has been chosen or quoted, so nothing names one. Taking occupancy as
the primitive rather than the vendor's own "entry event" is what makes the
interface survive that choice: products that only expose current occupancy work
directly, and a push-based product is wrapped by an adapter that holds the
latest state and answers `sample()` from it.

`sample()` throwing is meaningful and different from returning an empty list.
Throwing means the zone could not be observed; `{ tracks: [] }` means it was
observed and is empty. The agent counts consecutive failures and treats a run of
them as feed silence rather than as an empty yard.

## Sampling: why 2 seconds

The requirement is to reliably catch a five-minute worst-case turnover,
including back-to-back swaps.

**Back-to-back swaps are the case that sets the design, not the rate.** One car
pulls out, another takes the space seconds later. Occupancy never changes — so a
system that differenced counts would record nothing and lose a whole wash.
Because the tracker compares track *ids*, the second car is simply a new id and
is counted. Identity is what makes this work.

**The rate follows from confirmation.** A track must be seen
`confirmSamples + 1` times to be believed (one stray detection is otherwise an
extra car), so a whole visit must span that many samples:

```
interval ≤ turnover / (confirmSamples + 1) / safetyFactor
         = 300s / 3 / 4
         = 25s
```

The safety factor covers what the arithmetic does not: dropped frames, a feed
that stalls for a beat, a swap straddling a sample boundary, clock jitter. Four
is a deliberate over-sample, not a derived constant — sampling a local feed
costs nothing and a missed wash is invisible forever.

The default runs at **2 seconds**, far inside the 25s ceiling. The ceiling is
what the code enforces; `assertSamplingAdequate()` runs at agent startup and
**refuses to start** if the configured interval is too slow. That failure mode
is chosen on purpose: a counting unit running too slowly produces an undercount,
which reads in the nightly report as "every wash was logged" — the one wrong
answer nobody would question.

## The known error mode

If the tracker loses a stationary car for longer than the release window — a
long occlusion, a dropped connection, a tracker restart — it reacquires it under
a fresh id and counts it as a second arrival. Nothing in a presence-based,
identity-free design can distinguish that from a genuinely new vehicle.

So the count runs slightly **high** rather than slightly low. That is the right
direction for a check whose surplus side means "a wash may not have been
logged": it produces occasional soft flags instead of silent misses. It is also
why Check D has an absolute tolerance before it says anything, and why the first
tier is LOW. A check that cries wolf nightly is ignored within a week, and this
is the one check nothing else can substitute for.

The same reasoning drives `ZoneTracker.reset()` after a feed outage: every id is
treated as new, because whatever happened in the blind window is unknowable.
That over-counts across an outage by design.

## How it reaches the database

```
counting agent  ──POST X-Counting-Secret──▶  vehicle-count-ingest  ──▶  Postgres
```

The agent runs on a box at the yard, on a network nobody controls, and holds no
Supabase key. The shared secret buys exactly one capability: appending vehicle
count rows. It cannot read transactions or reports. The worst a stolen secret
does is inject fake arrivals — which surfaces in the nightly report as a
discrepancy, loudly, rather than hiding one.

Delivery is at-least-once and idempotent: each arrival carries a key of
`device:track:first-seen`, unique per branch, so a retry after a lost response
lands once. The local buffer is bounded — unlike the POS queue, which must never
drop a sale, a counting feed that has been offline for days is better off
keeping its most recent events. Anything dropped is counted and reported.

## Choosing a vendor

The quote should be judged against what this design actually needs:

1. **Can it report current occupancy, or entry events, at 0.5 Hz or faster?**
   That is the whole requirement. Anything at or under 25s between reads works;
   2s is comfortable.
2. **Does it hold a track id across brief occlusion?** This is the single
   biggest driver of over-counting. Ask how long it holds a lost track.
3. **Can it be fenced to one zone** covering the open yard, with no bay model
   imposed?
4. **Can it run without sending video off site?** Nothing here needs images, and
   not receiving them is a feature.
5. **Is there a local API?** A cloud-only product adds a second network
   dependency to a component whose failure mode is silent undercounting.

Plate reading, vehicle classification and re-identification are all things to
decline, not features to pay for. They add privacy obligations and buy nothing
the reconciliation uses.

Adopting the chosen product means: one new file implementing
`VehicleCountSource`, one case in `createSource()` in `counting/src/run.ts`, and
setting `source` so the swap is auditable in the data. Nothing else changes.
