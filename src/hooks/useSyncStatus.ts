import { useEffect, useState } from "react";
import { pendingCount } from "../lib/db";
import { getLastSyncedAt, startSyncLoop, type SyncResult } from "../lib/sync";

export interface SyncStatus {
  online: boolean;
  pending: number;
  lastSyncedAt: Date | null;
  lastError?: string;
}

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({
    online: navigator.onLine,
    pending: 0,
    lastSyncedAt: null
  });

  useEffect(() => {
    let cancelled = false;

    const refresh = async (result?: SyncResult) => {
      const [pending, lastSyncedAt] = await Promise.all([pendingCount(), getLastSyncedAt()]);
      if (cancelled) return;
      setStatus({
        online: navigator.onLine,
        pending,
        lastSyncedAt,
        lastError: result?.error
      });
    };

    const stop = startSyncLoop((result) => void refresh(result));
    void refresh();

    // The queue also changes on every wash, not just on sync ticks.
    const poll = window.setInterval(() => void refresh(), 5000);
    const onConnectivity = () => void refresh();
    window.addEventListener("online", onConnectivity);
    window.addEventListener("offline", onConnectivity);

    return () => {
      cancelled = true;
      stop();
      window.clearInterval(poll);
      window.removeEventListener("online", onConnectivity);
      window.removeEventListener("offline", onConnectivity);
    };
  }, []);

  return status;
}
