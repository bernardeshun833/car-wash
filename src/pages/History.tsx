import { useEffect, useState } from "react";
import NumPad from "../components/NumPad";
import { DEMO_MODE } from "../lib/demo";
import {
  dailyTotals,
  dayWashes,
  monthRange,
  unlockHistory,
  type DayTotal,
  type DayWash
} from "../lib/owner";

/**
 * Previous months, in the app instead of the Supabase dashboard.
 *
 * Behind the owner's own PIN, not the shift PIN — see migration 0006 for why
 * that distinction is enforced in the database rather than by hiding this tab.
 * The PIN entered here lives in React state and nowhere else: closing the tab
 * forgets it, because a PIN cached on the phone is a PIN available to whoever
 * is holding the phone.
 */

const SEVERITY_TONE: Record<string, string> = {
  NONE: "text-emerald-300",
  LOW: "text-sky-300",
  MEDIUM: "text-amber-300",
  HIGH: "text-red-300"
};

const SEVERITY_LABEL: Record<string, string> = {
  NONE: "clear",
  LOW: "worth a look",
  MEDIUM: "needs attention",
  HIGH: "needs attention"
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const ghs = (n: number) => `GHS ${n.toFixed(2)}`;

export default function History() {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());

  const [days, setDays] = useState<DayTotal[]>([]);
  const [loading, setLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [washes, setWashes] = useState<DayWash[]>([]);

  // The demo has no server, and every function here is a server function.
  // Saying so is better than an unlock screen that can never succeed.
  if (DEMO_MODE) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium">History needs the live system</p>
        <p className="text-gray-400">
          Past months are read from the database, behind the owner's PIN — none
          of which exists in the demo. The demo keeps today's washes on this
          phone and nothing else.
        </p>
      </div>
    );
  }

  const onDigits = (next: string) => {
    if (checking) return;
    setError(null);
    setPin(next);
    if (next.length !== 4) return;

    void (async () => {
      setChecking(true);
      try {
        await unlockHistory(next);
        setUnlocked(next);
      } catch (e) {
        setPin("");
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
      }
    })();
  };

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      setOpenDay(null);
      try {
        const { from, to } = monthRange(year, month);
        const rows = await dailyTotals(unlocked, from, to);
        if (!cancelled) setDays(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unlocked, year, month]);

  const openDayDetail = async (day: string) => {
    if (!unlocked) return;
    if (openDay === day) {
      setOpenDay(null);
      return;
    }

    setOpenDay(day);
    setWashes([]);
    try {
      setWashes(await dayWashes(unlocked, day));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!unlocked) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Owner PIN</h1>
          <p className="mt-1 text-gray-400">
            Past months are for the owner, not the shift
          </p>
        </div>

        <div className="flex justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full ${
                i < pin.length ? "bg-emerald-400" : "bg-gray-700"
              }`}
            />
          ))}
        </div>

        <p
          className="min-h-[1.5rem] text-center text-amber-300"
          role="status"
          aria-live="polite"
        >
          {checking ? "Checking…" : error}
        </p>

        <NumPad value={pin} onChange={onDigits} />
      </div>
    );
  }

  const monthTotal = days.reduce((sum, d) => sum + d.revenue, 0);
  const monthWashes = days.reduce((sum, d) => sum + d.washes, 0);

  const step = (by: number) => {
    const next = new Date(Date.UTC(year, month + by, 1));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth());
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" className="btn-secondary px-4" onClick={() => step(-1)}>
          ←
        </button>
        <div className="text-center">
          <h1 className="text-xl font-semibold">
            {MONTHS[month]} {year}
          </h1>
          <p className="text-sm text-gray-400">
            {loading ? "Loading…" : `${ghs(monthTotal)} · ${monthWashes} washes`}
          </p>
        </div>
        <button type="button" className="btn-secondary px-4" onClick={() => step(1)}>
          →
        </button>
      </div>

      {error && <p className="rounded-xl bg-red-900/60 p-3 text-red-100">{error}</p>}

      {!loading && days.length === 0 && (
        <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-400">
          Nothing logged in this month.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {days.map((d) => (
          <li key={d.day} className="rounded-xl border border-gray-700 bg-gray-800">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 p-3 text-left"
              onClick={() => void openDayDetail(d.day)}
            >
              <div>
                <p className="font-medium">
                  {new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC"
                  })}
                </p>
                <p className="text-sm text-gray-400">
                  {d.washes} washes
                  {d.voids > 0 && ` · ${d.voids} voided`}
                  {d.vehicles !== null && ` · ${d.vehicles} vehicles counted`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg">{ghs(d.revenue)}</p>
                {d.severity && (
                  <p className={`text-sm ${SEVERITY_TONE[d.severity] ?? "text-gray-400"}`}>
                    {SEVERITY_LABEL[d.severity] ?? d.severity}
                  </p>
                )}
              </div>
            </button>

            {openDay === d.day && (
              <div className="border-t border-gray-700 p-3">
                {washes.length === 0 ? (
                  <p className="text-sm text-gray-400">Loading…</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {washes.map((w, i) => (
                      <li
                        key={`${w.at}-${i}`}
                        className={`flex justify-between gap-3 ${
                          w.is_correction ? "text-amber-300" : ""
                        }`}
                      >
                        <span>
                          {new Date(w.at).toLocaleTimeString("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "UTC"
                          })}{" "}
                          · {w.wash_type}
                          {w.is_correction && " (void)"}
                        </span>
                        <span className="text-gray-400">
                          {w.attendant} · {w.method}
                        </span>
                        <span>{ghs(w.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="pb-4 text-center text-xs text-gray-500">
        Read from the server, behind your PIN. Nothing here is stored on this
        phone.
      </p>
    </div>
  );
}
