import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, queueCashCount, transactionsForLocalDate } from "../lib/db";
import { getBranchId, getDeviceId } from "../lib/device";
import { newId } from "../lib/ids";
import { sync } from "../lib/sync";
import type { Attendant } from "../types";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CashCount({ attendant }: { attendant: Attendant }) {
  const shiftDate = todayIso();

  const settings = useLiveQuery(() => db.settings.get("current"), []);
  const todaysTxns = useLiveQuery(
    () => transactionsForLocalDate(shiftDate),
    [shiftDate],
    []
  );
  // All of today's counts, newest last. Normally one; more when the first was
  // wrong and had to be corrected.
  const countsToday = useLiveQuery(
    async () => {
      const rows = await db.cashCounts.where("shift_date").equals(shiftDate).toArray();
      return rows.sort((a, b) => a.created_at_local.localeCompare(b.created_at_local));
    },
    [shiftDate],
    []
  );
  const latestCount = countsToday[countsToday.length - 1] ?? null;

  const [countedBy, setCountedBy] = useState(attendant.name);
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openingFloat = settings?.opening_float ?? 0;

  const cashTaken = useMemo(
    () =>
      todaysTxns
        .filter((t) => t.payment_method === "cash")
        .reduce((sum, t) => sum + t.amount, 0),
    [todaysTxns]
  );

  // Still recorded on the row — the server recomputes it independently during
  // reconciliation, so what is stored here can never hide a variance — but it
  // is never shown on this screen. See the note by the form below.
  const expected = cashTaken + openingFloat;
  const actualNumber = Number.parseFloat(actual);

  const submit = async () => {
    if (!Number.isFinite(actualNumber) || countedBy.trim().length === 0) return;
    if (correcting && notes.trim().length === 0) return;

    setSaving(true);
    setError(null);

    // A silent failure here is worse than elsewhere: the drawer has already
    // been counted, the person walks away believing it is recorded, and the
    // nightly report says no count was taken at all.
    try {
      await queueCashCount({
        id: newId(),
        branch_id: getBranchId(),
        shift_date: shiftDate,
        counted_by: countedBy.trim(),
        expected,
        actual: actualNumber,
        opening_float: openingFloat,
        notes: notes.trim() || null,
        // A correction points at the count it replaces. Both rows are kept;
        // the nightly report uses this one and shows the earlier figure.
        supersedes_id: correcting ? (latestCount?.id ?? null) : null,
        device_id: getDeviceId(),
        created_at_local: new Date().toISOString()
      });

      setCorrecting(false);
      setCountedBy(attendant.name);
      setActual("");
      setNotes("");
      void sync();
    } catch (e) {
      setError(
        `Could not save this count: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setSaving(false);
    }
  };

  if (latestCount && !correcting) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-5xl">✓</p>
        <p className="text-2xl font-semibold">Cash count recorded for {shiftDate}</p>
        <p className="text-gray-400">
          Counted GHS {latestCount.actual.toFixed(2)} · counted by{" "}
          {latestCount.counted_by}
        </p>

        {countsToday.length > 1 && (
          <p className="text-sm text-amber-300">
            Corrected {countsToday.length - 1}{" "}
            {countsToday.length === 2 ? "time" : "times"} — earlier figures:{" "}
            {countsToday
              .slice(0, -1)
              .map((c) => `GHS ${c.actual.toFixed(2)}`)
              .join(", ")}
          </p>
        )}

        <p className="max-w-md text-sm text-gray-500">
          A count is never edited or deleted. If this figure is wrong, record a
          corrected count — the original stays in the record, and tonight's report
          shows both so the owner can see what changed.
        </p>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setCorrecting(true);
            setCountedBy(latestCount.counted_by);
            setActual("");
            setNotes("");
          }}
        >
          Record a corrected count
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-5 p-4">
      <div>
        <h1 className="text-xl font-semibold">
          {correcting ? "Corrected cash count" : "End of shift cash count"}
        </h1>
        <p className="text-sm text-gray-400">
          {correcting
            ? `${shiftDate} · replaces the count of GHS ${latestCount?.actual.toFixed(2)}`
            : `${shiftDate} · count the drawer, then move anything above the float to the safe`}
        </p>
      </div>

      {correcting && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-900/40 p-3 text-sm text-amber-100">
          <span>
            The earlier count stays in the record. Say why it changed so the owner is
            not left guessing.
          </span>
          <button
            type="button"
            className="btn-secondary min-h-0 px-3 py-2"
            onClick={() => setCorrecting(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* The expected figure is deliberately NOT shown.
          Counting the drawer and then being told what it "should" be invites
          typing the expected number instead of the counted one, and a count
          that agrees with the POS by construction checks nothing. The server
          recomputes expected during reconciliation and reports the variance
          there, where the person counting cannot influence it.
          The opening float stays: the counter needs it to know how much to
          leave in the drawer. */}
      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-gray-800 p-4 text-sm">
        <dt className="text-gray-400">Opening float (leave this in the drawer)</dt>
        <dd className="text-right">GHS {openingFloat.toFixed(2)}</dd>
      </dl>

      {error && (
        <p className="rounded-xl bg-red-900/60 p-3 text-red-100">{error}</p>
      )}

      <label className="flex flex-col gap-2">
        <span className="text-sm text-gray-400">Counted by</span>
        <input
          className="min-h-touch rounded-xl border border-gray-700 bg-gray-800 px-4 text-lg"
          value={countedBy}
          onChange={(e) => setCountedBy(e.target.value)}
          placeholder="Who counted the drawer"
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm text-gray-400">Actual counted (GHS)</span>
        <input
          className="min-h-touch rounded-xl border border-gray-700 bg-gray-800 px-4 text-2xl"
          inputMode="decimal"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          placeholder="0.00"
        />
      </label>


      <label className="flex flex-col gap-2">
        <span className="text-sm text-gray-400">
          {correcting ? "Why is this being corrected? (required)" : "Notes (optional)"}
        </span>
        <textarea
          className="rounded-xl border border-gray-700 bg-gray-800 p-4 text-base"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            correcting
              ? "e.g. first count typed 12400 instead of 1240"
              : "Anything that explains a difference — a refund, a float top-up…"
          }
        />
      </label>

      <button
        type="button"
        className="btn-primary"
        disabled={
          saving ||
          !Number.isFinite(actualNumber) ||
          countedBy.trim().length === 0 ||
          (correcting && notes.trim().length === 0)
        }
        onClick={submit}
      >
        {saving
          ? "Saving…"
          : correcting
            ? "Record corrected count"
            : "Record count"}
      </button>
    </div>
  );
}
