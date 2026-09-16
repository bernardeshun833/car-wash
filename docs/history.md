# The owner's history

Previous months in the app instead of the Supabase dashboard: takings for the
month, each day's washes and voids, what the counting unit saw, the nightly
job's verdict, and a tap on any day for the individual washes.

Behind the **owner's** PIN — not the shift PIN.

## Setting the owner PIN

Once, in the Supabase SQL editor:

```sql
select set_owner_pin('<your PIN>');
```

Then clear the editor: the statement stays in your query history otherwise.

The function is deliberately **not** granted to the app. Changing the owner's
PIN is a dashboard job, not something reachable with the key that ships inside
the phone.

To change it later, run the same statement again.

## Why it is a separate PIN

The attendant runs the till; the owner reads the record. Those are different
people with different interests, which is the premise this whole system is
built on. Someone weighing up whether to pocket tonight's cash should not be
able to study which nights the reconciliation flagged and which slipped
through — that is a map of where the gaps are.

Same reasoning as taking the expected-cash figure off the count screen.

## Why hiding the tab would not have been enough

The tab is visible to everyone and opens for nobody without the PIN, because
hiding it is theatre while the row-level policy still says "this device may
select every transaction ever" — devtools is one tap away on any browser, and
the anon key is inside the app bundle by design.

Three things enforce it instead, all in migration `0006`:

**1. The PIN is checked in the database, never on the device.**
`attendants.pin_hash` syncs to the phone on purpose, because a shift PIN has to
work with no signal. But a hash on the device can be brute-forced off the
device in minutes — ten thousand candidates is nothing. So `owner_credentials`
has RLS enabled and **no policy at all**: the site device cannot read a row from
it. Only the security-definer functions can, and they return a boolean, never
the hash.

**2. The history is unreadable without the PIN.** The device's own read of
`transactions` narrows to the last two days — enough for the Today screen and
for a void, and nothing beyond. History comes only through
`owner_daily_totals` and `owner_day_washes`, which check the PIN before
returning a row. A locked door in an open wall is not a lock.

**3. The phone stops hoarding it.** Every successful sync drops synced washes
older than two days from IndexedDB (`pruneSyncedHistory` in `src/lib/db.ts`),
so there is no local copy to read either. Only synced rows go: a row that has
not reached the server is the one thing the device holds that nothing else
does, and it stays until it has.

That is what makes four digits enough here when it would not be on the device.

## The lockout

Ten wrong PINs locks the function for fifteen minutes. The RPC is reachable by
anyone holding the anon key, so without a limit the PIN is a four-digit lock
with an unlimited guessing budget — minutes of scripted work.

The trade is real and worth stating: someone at the yard can lock the owner out
for a quarter of an hour by guessing badly on purpose. Fifteen minutes of
nuisance beats an unlimited budget.

The app tells the two apart — "that PIN is not right" versus "try again after
14:30" — because a person who has simply mistyped should not be left wondering
whether the system is broken.

## What the owner sees

- **Month by month**, with arrows to step back and forward.
- **Each day**: washes, voids, takings, vehicles counted, and the nightly job's
  verdict (clear / worth a look / needs attention).
- **Tap a day** for every wash on it: time, wash type, attendant, method,
  amount, and whether it was a void.

Vehicles shows as absent rather than zero on days with no counting unit. A zero
there would read as "no cars came", which is a completely different claim.

## Notes

The PIN is passed on every call and held only in React state while the screen
is open. It is never written to storage — a PIN cached on the phone is a PIN
available to whoever is holding the phone — so switching tabs and coming back
asks again. That is deliberate.

History needs the live system. In demo mode the screen says so rather than
offering an unlock that could never succeed.
