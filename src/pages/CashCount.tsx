import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, queueCashCount, transactionsForLocalDate } from "../lib/db";
import { getBranchId, getDeviceId } from "../lib/device";
import { sync } from "../lib/sync";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CashCount() {
  const shiftDate = todayIso();

  const settings = useLiveQuery(() => db.settings.get("current"), []);
  const todaysTxns = useLiveQuery(
    () => transactionsForLocalDate(shiftDate),
    [shiftDate],
    []
  );
  const alreadyCounted = useLiveQuery(
    () => db.cashCounts.where("shift_date").equals(shiftDate).first(),
    [shiftDate]
  );

  const [countedBy, setCountedBy] = useState("");
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);

  const openingFloat = settings?.opening_float ?? 0;

  const cashTaken = useMemo(
    () =>
      todaysTxns
        .filter((t) => t.payment_method === "cash")
        .reduce((sum, t) => sum + t.amount, 0),
    [todaysTxns]
  );

  // Shown to the manager so the count is a real comparison rather than a
  // number typed into a void. The server recomputes this independently during
  // reconciliation, so a wrong `expected` here cannot hide a cash variance.
  const expected = cashTaken + openingFloat;
  const actualNumber = Number.parseFloat(actual);
  const variance = Number.isFinite(actualNumber) ? actualNumber - expected : null;

  const submit = async () => {
    if (!Number.isFinite(actualNumber) || countedBy.trim().length === 0) return;
    await queueCashCount({
      id: crypto.randomUUID(),
      branch_id: getBranchId(),
      shift_date: shiftDate,
      counted_by: countedBy.trim(),
      expected,
      actual: actualNumber,
      opening_float: openingFloat,
      notes: notes.trim() || null,
      device_id: getDeviceId(),
      created_at_local: new Date().toISOString()
    });
    setSaved(true);
    void sync();
  };

  if (saved || alreadyCounted) {
    const count = alreadyCounted;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-5xl">✓</p>
        <p className="text-2xl font-semibold">Cash count recorded for {shiftDate}</p>
        {count && (
          <p className="text-gray-400">
            Counted GHS {count.actual.toFixed(2)} against GHS {count.expected.toFixed(2)}{" "}
            expected · counted by {count.counted_by}
          </p>
        )}
        <p className="max-w-md text-sm text-gray-500">
          Counts cannot be edited. If this one was wrong, record the correction in
          tonight's notes and tell the owner — the numbers are meant to be a record of
          what was counted, not what should have been counted.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-5 p-4">
      <div>
        <h1 className="text-xl font-semibold">End of shift cash count</h1>
        <p className="text-sm text-gray-400">
          {shiftDate} · count the drawer with a second person present, and move anything
          above the float to the safe
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-gray-800 p-4 text-sm">
        <dt className="text-gray-400">Opening float</dt>
        <dd className="text-right">GHS {openingFloat.toFixed(2)}</dd>
        <dt className="text-gray-400">Cash washes logged today</dt>
        <dd className="text-right">GHS {cashTaken.toFixed(2)}</dd>
        <dt className="font-medium">Expected in drawer</dt>
        <dd className="text-right font-medium">GHS {expected.toFixed(2)}</dd>
      </dl>

      <label className="flex flex-col gap-2">
        <span className="text-sm text-gray-400">Counted by (both names)</span>
        <input
          className="min-h-touch rounded-xl border border-gray-700 bg-gray-800 px-4 text-lg"
          value={countedBy}
          onChange={(e) => setCountedBy(e.target.value)}
          placeholder="e.g. Ama & Kofi"
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

      {variance !== null && (
        <p
          className={`rounded-xl p-3 text-center text-lg ${
            Math.abs(variance) < 0.005
              ? "bg-emerald-900/40 text-emerald-200"
              : "bg-amber-900/40 text-amber-100"
          }`}
        >
          {Math.abs(variance) < 0.005
            ? "Drawer balances"
            : `${variance > 0 ? "Over" : "Short"} by GHS ${Math.abs(variance).toFixed(2)}`}
        </p>
      )}

      <label className="flex flex-col gap-2">
        <span className="text-sm text-gray-400">Notes (optional)</span>
        <textarea
          className="rounded-xl border border-gray-700 bg-gray-800 p-4 text-base"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything that explains a difference — a refund, a float top-up…"
        />
      </label>

      <button
        type="button"
        className="btn-primary"
        disabled={!Number.isFinite(actualNumber) || countedBy.trim().length === 0}
        onClick={submit}
      >
        Record count
      </button>
    </div>
  );
}
