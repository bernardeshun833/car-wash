import { db, getMeta, pendingCashCounts, pendingTransactions, setMeta } from "./db";
import { supabase } from "./supabase";
import { getBranchId, getDeviceId, setBranchId } from "./device";
import type { Attendant, BranchSettings, WashService } from "../types";

/** Every few minutes when online, not once a day. */
export const SYNC_INTERVAL_MS = 2 * 60 * 1000;

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 2 * 1000;
const LAST_SYNC_KEY = "last_successful_sync";

export interface SyncResult {
  pushed: number;
  failed: number;
  refreshed: boolean;
  error?: string;
}

let inFlight: Promise<SyncResult> | null = null;
let consecutiveFailures = 0;

export async function getLastSyncedAt(): Promise<Date | null> {
  const raw = await getMeta(LAST_SYNC_KEY);
  return raw ? new Date(raw) : null;
}

/**
 * Push the local queue, then pull down the reference data the app needs to
 * keep working offline. Safe to call concurrently — overlapping calls share
 * the in-flight promise rather than double-sending rows.
 */
export async function sync(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<SyncResult> {
  if (!navigator.onLine) {
    return { pushed: 0, failed: 0, refreshed: false, error: "offline" };
  }

  try {
    const pushed = await pushQueue();
    const refreshed = await pullReferenceData();
    await reportHeartbeat();
    await setMeta(LAST_SYNC_KEY, new Date().toISOString());
    consecutiveFailures = 0;
    return { pushed: pushed.pushed, failed: pushed.failed, refreshed };
  } catch (error) {
    consecutiveFailures++;
    return {
      pushed: 0,
      failed: 0,
      refreshed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function pushQueue(): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;

  const txns = await pendingTransactions();
  for (const txn of txns) {
    const { sync_state, sync_attempts, last_error, ...row } = txn;
    void sync_state;
    void last_error;

    // upsert, not insert: the row id is client-generated, so a retry after a
    // response we never saw lands on the same primary key instead of creating
    // a duplicate wash. ignoreDuplicates keeps the original row — which
    // matters, because transactions can never be updated.
    const { error } = await supabase
      .from("transactions")
      .upsert(row, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      failed++;
      await db.transactions.update(txn.id, {
        sync_attempts: sync_attempts + 1,
        last_error: error.message
      });
    } else {
      pushed++;
      await db.transactions.update(txn.id, {
        sync_state: "synced",
        last_error: undefined
      });
    }
  }

  const counts = await pendingCashCounts();
  for (const count of counts) {
    const { sync_state, sync_attempts, last_error, ...row } = count;
    void sync_state;
    void last_error;

    const { error } = await supabase
      .from("cash_counts")
      .upsert(row, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      failed++;
      await db.cashCounts.update(count.id, {
        sync_attempts: sync_attempts + 1,
        last_error: error.message
      });
    } else {
      pushed++;
      await db.cashCounts.update(count.id, {
        sync_state: "synced",
        last_error: undefined
      });
    }
  }

  return { pushed, failed };
}

async function pullReferenceData(): Promise<boolean> {
  const branchId = getBranchId();

  const [attendants, services, settings] = await Promise.all([
    supabase.from("attendants").select("*").eq("branch_id", branchId).eq("active", true),
    supabase
      .from("vehicles_or_services")
      .select("*")
      .eq("branch_id", branchId)
      .eq("active", true),
    supabase.from("branch_settings").select("*").eq("branch_id", branchId).single()
  ]);

  if (attendants.error || services.error || settings.error) return false;

  const settingsRow = settings.data as BranchSettings;
  setBranchId(settingsRow.branch_id);

  await db.transaction("rw", db.attendants, db.services, db.settings, async () => {
    await db.attendants.clear();
    await db.attendants.bulkPut(attendants.data as Attendant[]);
    await db.services.clear();
    await db.services.bulkPut(services.data as WashService[]);
    await db.settings.put({ id: "current", ...settingsRow });
  });

  return true;
}

async function reportHeartbeat(): Promise<void> {
  await supabase.from("device_heartbeats").upsert(
    {
      device_id: getDeviceId(),
      branch_id: getBranchId(),
      device_kind: "pos",
      last_synced_at: new Date().toISOString()
    },
    { onConflict: "device_id" }
  );
}

/**
 * Delay before the next attempt. Steady state is SYNC_INTERVAL_MS; after a
 * failure it backs off exponentially so a tablet with no signal is not burning
 * battery retrying every two minutes, capped so it still recovers promptly
 * once signal returns.
 */
export function nextSyncDelay(): number {
  if (consecutiveFailures === 0) return SYNC_INTERVAL_MS;
  return Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
}

/**
 * Run the sync loop for the lifetime of the app. Syncs on an interval, and
 * immediately whenever the device regains connectivity or the app is brought
 * back to the foreground — the window of unsynced data is the thing this whole
 * system is trying to keep small.
 */
export function startSyncLoop(onResult?: (result: SyncResult) => void): () => void {
  let timer: number | undefined;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const result = await sync();
    onResult?.(result);
    if (!stopped) {
      timer = window.setTimeout(tick, nextSyncDelay());
    }
  };

  const syncNow = () => {
    window.clearTimeout(timer);
    void tick();
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") syncNow();
  };

  window.addEventListener("online", syncNow);
  document.addEventListener("visibilitychange", onVisible);
  void tick();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener("online", syncNow);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
