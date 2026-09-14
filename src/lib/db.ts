import Dexie, { type Table } from "dexie";
import type {
  Attendant,
  BranchSettings,
  QueuedCashCount,
  QueuedTransaction,
  WashService
} from "../types";

interface SyncMetaRow {
  key: string;
  value: string;
}

class PosDatabase extends Dexie {
  transactions!: Table<QueuedTransaction, string>;
  cashCounts!: Table<QueuedCashCount, string>;
  attendants!: Table<Attendant, string>;
  services!: Table<WashService, string>;
  settings!: Table<BranchSettings & { id: string }, string>;
  meta!: Table<SyncMetaRow, string>;

  constructor() {
    // Named for this deployment. The barbershop PWA uses its own database on
    // its own origin; nothing is shared, including here on the device.
    super("kumasi-carwash-pos");
    this.version(1).stores({
      transactions: "id, sync_state, created_at_local, attendant_id",
      cashCounts: "id, sync_state, shift_date",
      attendants: "id, active",
      services: "id, active",
      settings: "id",
      meta: "key"
    });
  }
}

export const db = new PosDatabase();

export async function getMeta(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

export async function queueTransaction(
  txn: Omit<QueuedTransaction, "sync_state" | "sync_attempts">
): Promise<void> {
  await db.transactions.add({ ...txn, sync_state: "pending", sync_attempts: 0 });
}

export async function queueCashCount(
  count: Omit<QueuedCashCount, "sync_state" | "sync_attempts">
): Promise<void> {
  await db.cashCounts.add({ ...count, sync_state: "pending", sync_attempts: 0 });
}

export async function pendingTransactions(): Promise<QueuedTransaction[]> {
  return db.transactions.where("sync_state").equals("pending").toArray();
}

export async function pendingCashCounts(): Promise<QueuedCashCount[]> {
  return db.cashCounts.where("sync_state").equals("pending").toArray();
}

export async function pendingCount(): Promise<number> {
  const [txns, counts] = await Promise.all([
    db.transactions.where("sync_state").equals("pending").count(),
    db.cashCounts.where("sync_state").equals("pending").count()
  ]);
  return txns + counts;
}

/** Everything this device logged on a given local date, synced or not. */
export async function transactionsForLocalDate(
  isoDate: string
): Promise<QueuedTransaction[]> {
  const all = await db.transactions.toArray();
  return all.filter((t) => t.created_at_local.slice(0, 10) === isoDate);
}
