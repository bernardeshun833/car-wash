export type PaymentMethod = "cash" | "momo" | "qr" | "card";

export const DIGITAL_METHODS: PaymentMethod[] = ["momo", "qr", "card"];

export interface Attendant {
  id: string;
  branch_id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  pin_iterations: number;
  active: boolean;
}

/** A row of the price list. `wash_type` is what is sold, not a vehicle. */
export interface WashService {
  id: string;
  branch_id: string;
  wash_type: string;
  price: number;
  active: boolean;
}

export interface BranchSettings {
  branch_id: string;
  opening_float: number;
  open_time: string;
  close_time: string;
  timezone: string;
  /** While false the POS offers cash only. Flip it in the database, not here. */
  momo_enabled: boolean;
}

/** A transaction as it lives in the local queue before it reaches Postgres. */
export interface QueuedTransaction {
  /** Client-generated UUID. Doubles as the Postgres primary key, which makes
   *  retries idempotent — a re-sent row collides instead of duplicating. */
  id: string;
  branch_id: string;
  attendant_id: string;
  service_id: string;
  amount: number;
  payment_method: PaymentMethod;
  corrects_transaction_id: string | null;
  created_at_local: string;
  device_id: string;
  /** Local-only bookkeeping, stripped before the row is sent. */
  sync_state: "pending" | "synced";
  sync_attempts: number;
  last_error?: string;
}

export interface QueuedCashCount {
  id: string;
  branch_id: string;
  shift_date: string;
  counted_by: string;
  expected: number;
  actual: number;
  opening_float: number;
  notes: string | null;
  device_id: string;
  created_at_local: string;
  sync_state: "pending" | "synced";
  sync_attempts: number;
  last_error?: string;
}
