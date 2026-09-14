import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import NumPad from "./NumPad";
import { db } from "../lib/db";
import { verifyPin } from "../lib/pin";
import type { Attendant } from "../types";

/**
 * The lock screen. Nothing in the app is reachable until a PIN is accepted.
 *
 * This replaces asking for a PIN on every single wash. With one attendant on
 * site, a PIN per transaction was pure friction: the same person, typing the
 * same four digits, every car. Unlocking once and then logging a wash in one
 * tap is the difference between a system that gets used during a rush and one
 * that gets filled in later from memory — and "later from memory" is exactly
 * the habit that makes the whole reconciliation worthless.
 *
 * What is kept is the thing the PIN is actually for: every transaction still
 * carries an attendant id and a verified moment in time, which is what the
 * nightly reconciliation windows are built on.
 *
 * The unlock lives in memory only. Closing the app or reloading the page locks
 * it again, so a phone left on a bench is not an open till.
 */
export default function PinLock({
  onUnlock
}: {
  onUnlock: (attendant: Attendant) => void;
}) {
  const attendants = useLiveQuery(() => db.attendants.toArray(), [], [] as Attendant[]);

  // With one attendant there is nobody to choose, so the name step is skipped
  // entirely. Add a second attendant and the picker appears on its own — no
  // code change, which matters because the real headcount is still unsettled.
  const [chosen, setChosen] = useState<Attendant | null>(null);
  const attendant = attendants.length === 1 ? attendants[0]! : chosen;

  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!attendant) return;
    setChecking(true);
    setError(null);

    const ok = await verifyPin(pin, attendant);
    setChecking(false);
    setPin("");

    if (ok) {
      onUnlock(attendant);
    } else {
      setError("Wrong PIN");
    }
  };

  if (attendants.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-gray-400">
        No attendants set up on this device yet. Connect to the internet once to
        finish setup.
      </div>
    );
  }

  if (!attendant) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
        <h1 className="text-center text-xl font-semibold">Who is on shift?</h1>
        {attendants.map((a) => (
          <button
            key={a.id}
            type="button"
            className="tile"
            onClick={() => setChosen(a)}
          >
            {a.name}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">{attendant.name}</h1>
        <p className="mt-1 text-gray-400">Enter your PIN to start</p>
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

      {error && <p className="text-center text-amber-300">{error}</p>}

      <NumPad value={pin} onChange={setPin} />

      <button
        type="button"
        className="btn-primary"
        disabled={pin.length !== 4 || checking}
        onClick={submit}
      >
        {checking ? "Checking…" : "Unlock"}
      </button>

      {attendants.length > 1 && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setChosen(null);
            setPin("");
            setError(null);
          }}
        >
          Someone else
        </button>
      )}
    </div>
  );
}
