import type { SyncStatus } from "../hooks/useSyncStatus";

/**
 * Shown only when this device is holding washes the server has not got.
 *
 * A bar that is always on screen stops being read within a week, so the day it
 * matters it is not read either — and "Offline" with an empty queue was never
 * that day: nothing is at risk, and saying so out loud only teaches the
 * attendant to distrust a phone working exactly as designed. What is left is
 * the count of washes that exist only here, which is the one thing anyone can
 * act on: keep the phone safe until it syncs.
 */
export default function SyncStatusBar({ status }: { status: SyncStatus }) {
  if (status.pending === 0) return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm bg-sky-900/60 text-sky-100">
      <span className="font-medium">
        {status.pending} {status.pending === 1 ? "wash" : "washes"} saved on this
        phone only
      </span>
      <span>{status.online ? "sending…" : "will send when back online"}</span>
    </div>
  );
}
