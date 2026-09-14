import type {
  Baseline,
  CashCountRow,
  MomoPayment,
  PosTransaction,
  ReconciliationInput,
  ReconciliationSettings,
  VehicleCountEvent
} from "../supabase/functions/_shared/reconciliation.ts";

export const DATE = "2026-09-10"; // a Thursday
export const BRANCH = "00000000-0000-0000-0000-00000000b1a1";

export const SETTINGS: ReconciliationSettings = {
  opening_float: 200,
  open_time: "07:00",
  close_time: "19:00",
  digital_variance_pct_threshold: 1,
  cash_variance_threshold: 50,
  volume_drop_pct_threshold: 25,
  cash_ratio_spike_multiplier: 1.3,
  attendant_volume_drop_multiplier: 0.7,
  offline_gap_hours: 4,
  // On here, unlike the migration default, because most of these tests exist
  // to exercise Check A. The cash-only path — what the branch actually runs
  // today — is covered explicitly with cashOnly().
  momo_enabled: true,
  momo_match_amount_tolerance: 0.01,
  momo_match_window_minutes: 15,
  // Off by default, matching the migration default and today's reality: no
  // counting unit is installed yet. The Check D tests turn it on explicitly
  // with countingOn(), which also keeps every other test's severity free of
  // "the feed said nothing" noise.
  vehicle_counting_enabled: false,
  vehicle_settle_minutes: 30,
  vehicle_count_tolerance: 2,
  vehicle_surplus_pct_medium: 10,
  vehicle_surplus_pct_high: 25,
  vehicle_shortfall_pct_medium: 20
};

export const EMPTY_BASELINE: Baseline = {
  sameWeekdayCounts: [],
  attendantDailyCounts: {},
  cashRatios: []
};

let counter = 0;

export function txn(overrides: Partial<PosTransaction> = {}): PosTransaction {
  counter++;
  const at = overrides.created_at_local ?? `${DATE}T10:00:00.000Z`;
  return {
    id: `txn-${counter}`,
    branch_id: BRANCH,
    attendant_id: "attendant-1",
    service_id: "service-1",
    amount: 40,
    payment_method: "cash",
    corrects_transaction_id: null,
    created_at_local: at,
    synced_at: at,
    device_id: "tablet-1",
    ...overrides
  };
}

export function momo(overrides: Partial<MomoPayment> = {}): MomoPayment {
  counter++;
  return {
    id: `momo-${counter}`,
    external_ref: `ref-${counter}`,
    amount: 40,
    timestamp: `${DATE}T10:00:00.000Z`,
    ...overrides
  };
}

export function vehicle(overrides: Partial<VehicleCountEvent> = {}): VehicleCountEvent {
  counter++;
  return {
    id: `veh-${counter}`,
    event_time: `${DATE}T10:00:00.000Z`,
    in_zone_count: 1,
    device_id: "counter-main-gate",
    source: "mock:scripted",
    ...overrides
  };
}

/** n arrivals spread through the middle of the day, well inside the window. */
export function vehicles(n: number, startHour = 9): VehicleCountEvent[] {
  return Array.from({ length: n }, (_, i) =>
    vehicle({
      event_time: `${DATE}T${String(startHour + Math.floor(i / 6)).padStart(2, "0")}:${String(
        (i % 6) * 10
      ).padStart(2, "0")}:00.000Z`,
      in_zone_count: (i % 4) + 1
    })
  );
}

/** n cash washes, matching the shape of `vehicles` above. */
export function washes(n: number, startHour = 9): PosTransaction[] {
  return Array.from({ length: n }, (_, i) =>
    txn({
      created_at_local: `${DATE}T${String(startHour + Math.floor(i / 6)).padStart(2, "0")}:${String(
        (i % 6) * 10
      ).padStart(2, "0")}:00.000Z`
    })
  );
}

export function at(time: string): string {
  return `${DATE}T${time}:00.000Z`;
}

/**
 * Most tests care about one cash count, so they pass `cashCount:` and this
 * wraps it into the list reconcile() actually takes. Tests about corrections
 * pass `cashCounts:` directly.
 */
export function input(
  overrides: Partial<ReconciliationInput> & { cashCount?: CashCountRow | null } = {}
): ReconciliationInput {
  const { cashCount, ...rest } = overrides;

  return {
    businessDate: DATE,
    branchId: BRANCH,
    posTransactions: [],
    momoPayments: [],
    cashCounts: cashCount ? [cashCount] : [],
    vehicleEvents: [],
    deviceGaps: [],
    baseline: EMPTY_BASELINE,
    settings: SETTINGS,
    ...rest
  };
}

/** Settings as the branch runs today: cash only, no MoMo feed. */
export function cashOnly(
  overrides: Partial<ReconciliationSettings> = {}
): ReconciliationSettings {
  return { ...SETTINGS, momo_enabled: false, ...overrides };
}

/** Settings with the counting feed live, plus any threshold overrides. */
export function countingOn(
  overrides: Partial<ReconciliationSettings> = {}
): ReconciliationSettings {
  return { ...SETTINGS, vehicle_counting_enabled: true, ...overrides };
}

export function cashCount(
  actual: number,
  openingFloat = 200,
  overrides: Partial<CashCountRow> = {}
): CashCountRow {
  counter++;
  return {
    id: `count-${counter}`,
    counted_by: "Ama & Kofi",
    actual,
    opening_float: openingFloat,
    notes: null,
    created_at_local: `${DATE}T19:15:00.000Z`,
    supersedes_id: null,
    ...overrides
  };
}

/** A first count and the correction that replaces it. */
export function correctedCashCount(
  wrong: number,
  right: number,
  openingFloat = 200
): CashCountRow[] {
  const first = cashCount(wrong, openingFloat, {
    created_at_local: `${DATE}T19:15:00.000Z`
  });
  const second = cashCount(right, openingFloat, {
    created_at_local: `${DATE}T19:40:00.000Z`,
    supersedes_id: first.id,
    notes: "first count mistyped"
  });
  return [first, second];
}
