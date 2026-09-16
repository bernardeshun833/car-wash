import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import SyncStatusBar from "./components/SyncStatusBar";
import { useSyncStatus } from "./hooks/useSyncStatus";
import CashCount from "./pages/CashCount";
import TodayLog from "./pages/TodayLog";
import TransactionEntry from "./pages/TransactionEntry";
import History from "./pages/History";
import { db } from "./lib/db";
import { supabase } from "./lib/supabase";
import { DEMO_MODE, resetDemoData, seedDemoData } from "./lib/demo";
import PinLock from "./components/PinLock";
import type { Attendant } from "./types";

const TABS = [
  { to: "/", label: "New wash" },
  { to: "/today", label: "Today" },
  { to: "/cash-count", label: "Cash count" },
  // Shown to everyone, opened by nobody without the owner's PIN. Hiding it
  // would be theatre — the lock is in the database (migration 0006).
  { to: "/history", label: "History" }
];

/**
 * Replaces the sync bar in demo mode. It says the one thing someone trying the
 * app needs to know — nothing here leaves the phone — rather than showing a
 * sync status that would be a fiction.
 */
function DemoBar() {
  return (
    <div className="flex items-center justify-between gap-2 bg-sky-900/70 px-4 py-2 text-sm text-sky-100">
      <span className="font-medium">
        Demo · stays on this phone · PIN 1234
      </span>
      <button
        type="button"
        className="rounded-lg border border-sky-300/50 px-3 py-1"
        onClick={() => {
          if (confirm("Clear everything logged in this demo?")) {
            void resetDemoData();
          }
        }}
      >
        Reset
      </button>
    </div>
  );
}

export default function App() {
  const status = useSyncStatus();
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Who is on shift. Held in memory only: a reload or a restart locks the app
  // again, so a phone left on a bench is not an open till.
  const [attendant, setAttendant] = useState<Attendant | null>(null);

  useEffect(() => {
    void (async () => {
      // Demo mode: load the built-in catalogue and skip everything that needs
      // a backend. There is no sign-in because there is nothing to sign in to.
      if (DEMO_MODE) {
        await seedDemoData();
        setReady(true);
        return;
      }

      // Sign-in is best effort. A tablet that cannot reach Supabase must still
      // reach the wash entry screen — that is the entire point of
      // offline-first, and a failed auth call is exactly what happens when the
      // network is down.
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          const email = import.meta.env.VITE_DEVICE_EMAIL;
          const password = import.meta.env.VITE_DEVICE_PASSWORD;
          if (email && password) {
            await supabase.auth.signInWithPassword({ email, password });
          }
        }
      } catch {
        // Falls through to the cached attendant list below.
      }

      const cachedAttendants = await db.attendants.count();
      if (cachedAttendants === 0 && !navigator.onLine) {
        setSetupError(
          "This tablet has no attendant list saved yet. Connect to the internet once to finish setup."
        );
      }
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">Loading…</div>
    );
  }

  // Nothing is reachable until a PIN is accepted — not the price list, not the
  // day's takings, not the cash count.
  if (!attendant) {
    return (
      <div className="flex h-full flex-col">
        {DEMO_MODE ? <DemoBar /> : <SyncStatusBar status={status} />}
        <PinLock onUnlock={setAttendant} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {DEMO_MODE ? <DemoBar /> : <SyncStatusBar status={status} />}

      <nav className="flex gap-1 border-b border-gray-800 px-2">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) =>
              `min-h-touch flex-1 px-4 py-3 text-center text-base font-medium ${
                isActive ? "border-b-2 border-emerald-400 text-emerald-300" : "text-gray-400"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {setupError && (
        <p className="bg-amber-900/60 px-4 py-3 text-amber-100">{setupError}</p>
      )}

      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2 text-sm text-gray-400">
        <span>On shift: {attendant.name}</span>
        <button
          type="button"
          className="rounded-lg border border-gray-700 px-3 py-1"
          onClick={() => setAttendant(null)}
        >
          Lock
        </button>
      </div>

      <main className="flex flex-1 flex-col overflow-y-auto">
        <Routes>
          <Route path="/" element={<TransactionEntry attendant={attendant} />} />
          <Route path="/today" element={<TodayLog />} />
          <Route path="/cash-count" element={<CashCount attendant={attendant} />} />
          <Route path="/history" element={<History />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
