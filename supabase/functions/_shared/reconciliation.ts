/**
 * Nightly reconciliation — pure logic.
 *
 * Deliberately free of I/O and Deno APIs so it can be unit-tested directly
 * (see tests/). The edge function handler does the fetching and sending;
 * everything that decides what the numbers mean lives here.
 *
 * Four comparisons, each against a source the person entering data does not
 * control, each severity-tiered rather than binary:
 *
 *   A  POS digital  vs  MoMo feed          (money that did or did not arrive)
 *   B  POS cash     vs  physical count     (the drawer)
 *   C  today        vs  its own history    (volume sanity)
 *   D  vehicles counted vs POS transactions (NEW — the only check that can see
 *                                            a wash that was never logged at
 *                                            all)
 *
 * Check D is the one with no barbershop equivalent, and it is the reason the
 * counting feed exists: an unlogged cash wash leaves no trace in the POS and
 * none in MoMo. The barbershop could only infer it statistically, from volume
 * being lower than usual. Here a car that entered the zone and produced no
 * transaction is a directly observable fact.
 *
 * Behavioural checks (after-hours entries, cash-share spikes, device silence)
 * ride along inside the four above rather than forming a fifth report section.
 */

export type PaymentMethod = "cash" | "momo" | "qr" | "card";
export type Severity = "NONE" | "LOW" | "MEDIUM" | "HIGH";

const SEVERITY_ORDER: Severity[] = ["NONE", "LOW", "MEDIUM", "HIGH"];

export const DIGITAL_METHODS: PaymentMethod[] = ["momo", "qr", "card"];

export interface PosTransaction {
  id: string;
  branch_id: string;
  attendant_id: string;
  service_id: string;
  amount: number;
  payment_method: PaymentMethod;
  corrects_transaction_id: string | null;
  created_at_local: string;
  synced_at: string;
  device_id: string;
}

export interface MomoPayment {
  id: string;
  external_ref: string;
  amount: number;
  timestamp: string;
}

export interface CashCountRow {
  counted_by: string;
  actual: number;
  opening_float: number;
  notes: string | null;
}

/** One vehicle arrival, as stored in vehicle_count_events. */
export interface VehicleCountEvent {
  id: string;
  event_time: string;
  in_zone_count: number;
  device_id: string;
  source: string;
}

export interface DeviceGap {
  device_id: string;
  gap_hours: number;
  started_at: string;
  ended_at: string;
}

export interface Baseline {
  /** Effective transaction counts for the same weekday, most recent 8 weeks. */
  sameWeekdayCounts: number[];
  /** Per-attendant daily transaction counts over the last 30 days. */
  attendantDailyCounts: Record<string, number[]>;
  /** Daily cash share (0..1) over the recent history. */
  cashRatios: number[];
}

export interface ReconciliationSettings {
  opening_float: number;
  open_time: string;
  close_time: string;
  digital_variance_pct_threshold: number;
  cash_variance_threshold: number;
  volume_drop_pct_threshold: number;
  cash_ratio_spike_multiplier: number;
  attendant_volume_drop_multiplier: number;
  offline_gap_hours: number;
  /** False while the wash is cash-only; Check A is skipped rather than faked. */
  momo_enabled: boolean;
  momo_match_amount_tolerance: number;
  momo_match_window_minutes: number;
  vehicle_counting_enabled: boolean;
  vehicle_settle_minutes: number;
  vehicle_count_tolerance: number;
  vehicle_surplus_pct_medium: number;
  vehicle_surplus_pct_high: number;
  vehicle_shortfall_pct_medium: number;
}

export interface ReconciliationInput {
  businessDate: string;
  branchId: string;
  posTransactions: PosTransaction[];
  momoPayments: MomoPayment[];
  cashCount: CashCountRow | null;
  vehicleEvents: VehicleCountEvent[];
  deviceGaps: DeviceGap[];
  baseline: Baseline;
  settings: ReconciliationSettings;
}

export type FlagKind =
  | "unmatched_momo"
  | "unmatched_pos_digital"
  | "cash_variance"
  | "missing_cash_count"
  | "volume_drop"
  | "attendant_volume_drop"
  | "cash_ratio_spike"
  | "after_hours_transaction"
  | "extended_offline_period"
  | "digital_without_momo_feed"
  | "unlogged_wash_suspected"
  | "vehicle_count_shortfall"
  | "vehicle_feed_silent";

export interface Flag {
  kind: FlagKind;
  severity: Severity;
  /** One line the owner can read without decoding it. */
  message: string;
  details?: Record<string, unknown>;
}

export interface AttendantBreakdown {
  attendant_id: string;
  txn_count: number;
  revenue: number;
  cash_revenue: number;
  digital_revenue: number;
}

export interface VehicleComparison {
  /** False when no counting unit is installed, or the check was skipped. */
  checked: boolean;
  vehicles_counted: number;
  transactions_counted: number;
  /** vehicles - transactions. Positive means washes may not have been logged. */
  difference: number;
  difference_pct: number | null;
  window_start: string;
  window_end: string;
  peak_in_zone: number;
  skipped_reason?: string;
}

export interface BusinessDateReport {
  business_date: string;
  branch_id: string;
  severity: Severity;
  revenue_total: number;
  txn_count: number;
  cash_total: number;
  digital_total: number;
  cash_share_pct: number;
  momo_actual_total: number;
  digital_variance: number;
  digital_variance_pct: number;
  /** False on a cash-only day: Check A did not run, it did not pass. */
  momo_checked: boolean;
  expected_cash: number;
  cash_counted: number | null;
  cash_variance: number | null;
  expected_txn_count: number | null;
  volume_drop_pct: number | null;
  vehicles: VehicleComparison;
  per_attendant: AttendantBreakdown[];
  matches: { transaction_id: string; momo_payment_id: string }[];
  unmatched_momo: MomoPayment[];
  unmatched_pos_digital: PosTransaction[];
  corrections: { correction_id: string; corrects: string; amount: number }[];
  flags: Flag[];
  baseline_available: boolean;
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isDigital(method: PaymentMethod): boolean {
  return DIGITAL_METHODS.includes(method);
}

/** Minutes as a number, from "HH:MM" or "HH:MM:SS". */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Ghana is UTC+0 year round, so the device's ISO timestamp is already local
 * time. If this system is ever deployed somewhere with an offset, this is the
 * single place that needs to learn about it.
 */
function localMinutesOfDay(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function padTime(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

export function reconcile(input: ReconciliationInput): BusinessDateReport {
  // vehicleEvents is read by compareVehicleCount, which takes the whole input.
  const { posTransactions, momoPayments, cashCount, deviceGaps, baseline, settings } =
    input;

  const flags: Flag[] = [];
  let severity: Severity = "NONE";
  const flag = (f: Flag) => {
    flags.push(f);
    severity = maxSeverity(severity, f.severity);
  };

  // ---- Corrections -------------------------------------------------------
  // A void is a negative correction row pointing at the original. Money-wise
  // the pair nets to zero under a plain SUM. Count-wise both rows must drop
  // out, or a busy day of corrections would look like a busy day of washes.
  const corrections = posTransactions.filter((t) => t.corrects_transaction_id !== null);
  const correctedIds = new Set(corrections.map((t) => t.corrects_transaction_id!));

  const effectiveSales = posTransactions.filter(
    (t) => t.corrects_transaction_id === null && !correctedIds.has(t.id)
  );

  // ---- Split POS by declared payment method ------------------------------
  // Sums run over ALL rows including corrections, so a void genuinely removes
  // its revenue. Counts run over effective sales only.
  const posCashTotal = round2(
    posTransactions
      .filter((t) => t.payment_method === "cash")
      .reduce((sum, t) => sum + t.amount, 0)
  );
  const posDigitalTotal = round2(
    posTransactions
      .filter((t) => isDigital(t.payment_method))
      .reduce((sum, t) => sum + t.amount, 0)
  );
  const momoActualTotal = round2(momoPayments.reduce((sum, p) => sum + p.amount, 0));
  const revenueTotal = round2(posCashTotal + posDigitalTotal);
  const txnCount = effectiveSales.length;

  // ---- Check A — digital declared vs digital actually received -----------
  const digitalVariance = round2(posDigitalTotal - momoActualTotal);
  const digitalVariancePct = round2((digitalVariance / Math.max(momoActualTotal, 1)) * 100);

  // Candidates are digital sales that were not voided. A voided sale whose
  // MoMo money did arrive should surface as unmatched_momo — that pairing is
  // exactly the case worth a question.
  const candidates = effectiveSales.filter((t) => isDigital(t.payment_method));
  const matchedPosIds = new Set<string>();
  const matches: { transaction_id: string; momo_payment_id: string }[] = [];
  const unmatchedMomo: MomoPayment[] = [];

  const windowMs = settings.momo_match_window_minutes * 60 * 1000;

  // While the wash is cash-only there is no MoMo feed to compare against, so
  // Check A is skipped outright. Running it anyway would flag every digital
  // row as money that never arrived — technically true, useless nightly, and
  // the fastest way to teach the owner to ignore the report.
  //
  // Skipping is not silence: if a digital wash gets logged, or money turns up
  // from a feed nobody configured, the settings no longer describe the
  // business and that is worth one clear flag.
  if (!settings.momo_enabled) {
    if (candidates.length > 0 || momoPayments.length > 0) {
      const total = round2(candidates.reduce((s, t) => s + t.amount, 0));
      flag({
        kind: "digital_without_momo_feed",
        severity: "MEDIUM",
        message:
          candidates.length > 0
            ? `${candidates.length} wash(es) totalling GHS ${total.toFixed(
                2
              )} were logged as digital, but this branch is set to cash only — nothing can check whether that money arrived`
            : `MoMo money arrived for a branch set to cash only — turn on momo_enabled so it can be reconciled`,
        details: {
          digital_transactions: candidates.length,
          digital_total: total,
          momo_payments: momoPayments.length
        }
      });
    }
  }

  for (const payment of settings.momo_enabled ? momoPayments : []) {
    const paymentTime = new Date(payment.timestamp).getTime();

    const eligible = candidates
      .filter((t) => !matchedPosIds.has(t.id))
      .filter((t) => Math.abs(t.amount - payment.amount) < settings.momo_match_amount_tolerance)
      .map((t) => ({
        txn: t,
        distance: Math.abs(new Date(t.created_at_local).getTime() - paymentTime)
      }))
      .filter((c) => c.distance < windowMs)
      // Several sales often qualify — a wash yard sells the same package at
      // the same price all day. Closest in time is deterministic and is the
      // pairing a human would make.
      .sort((a, b) => a.distance - b.distance);

    const best = eligible[0];
    if (best) {
      matchedPosIds.add(best.txn.id);
      matches.push({ transaction_id: best.txn.id, momo_payment_id: payment.id });
    } else {
      unmatchedMomo.push(payment);
      flag({
        kind: "unmatched_momo",
        severity: "HIGH",
        message: `GHS ${payment.amount.toFixed(2)} received on MoMo at ${new Date(
          payment.timestamp
        )
          .toISOString()
          .slice(11, 16)} with no matching wash logged`,
        details: { external_ref: payment.external_ref, amount: payment.amount }
      });
    }
  }

  const unmatchedPosDigital = settings.momo_enabled
    ? candidates.filter((t) => !matchedPosIds.has(t.id))
    : [];

  if (unmatchedPosDigital.length > 0) {
    const total = round2(unmatchedPosDigital.reduce((s, t) => s + t.amount, 0));
    flag({
      kind: "unmatched_pos_digital",
      severity: "HIGH",
      message: `${unmatchedPosDigital.length} digital wash(es) totalling GHS ${total.toFixed(
        2
      )} logged, but no matching money arrived`,
      details: { transaction_ids: unmatchedPosDigital.map((t) => t.id), total }
    });
  }

  if (
    settings.momo_enabled &&
    Math.abs(digitalVariancePct) > settings.digital_variance_pct_threshold
  ) {
    severity = maxSeverity(severity, "HIGH");
  }

  // ---- Check B — cash declared vs cash counted ---------------------------
  // expected_cash is recomputed here from POS data rather than trusting the
  // `expected` the tablet submitted, so a wrong number on the device cannot
  // paper over a real variance.
  const openingFloat = cashCount?.opening_float ?? settings.opening_float;
  const expectedCash = round2(posCashTotal + openingFloat);
  const cashVariance = cashCount ? round2(cashCount.actual - expectedCash) : null;

  if (!cashCount) {
    flag({
      kind: "missing_cash_count",
      severity: "MEDIUM",
      message: "No end-of-shift cash count was recorded",
      details: {}
    });
  } else if (Math.abs(cashVariance!) > settings.cash_variance_threshold) {
    flag({
      kind: "cash_variance",
      severity: "MEDIUM",
      message: `Drawer is ${cashVariance! > 0 ? "over" : "short"} by GHS ${Math.abs(
        cashVariance!
      ).toFixed(2)} (counted ${cashCount.actual.toFixed(
        2
      )}, expected ${expectedCash.toFixed(2)})`,
      details: { counted_by: cashCount.counted_by, notes: cashCount.notes }
    });
  }

  // ---- Check C — volume sanity ------------------------------------------
  // Skipped entirely until there is history to compare against: during the
  // first weeks a median over an empty window would either fire constantly or
  // read as "fine" for reasons that have nothing to do with the day's trade.
  const expectedCount = median(baseline.sameWeekdayCounts);
  const baselineAvailable = expectedCount !== null;

  let volumeDropPct: number | null = null;
  if (expectedCount !== null) {
    volumeDropPct = round2(((expectedCount - txnCount) / Math.max(expectedCount, 1)) * 100);
    if (volumeDropPct > settings.volume_drop_pct_threshold) {
      flag({
        kind: "volume_drop",
        severity: "MEDIUM",
        message: `${volumeDropPct.toFixed(0)}% fewer washes than a typical ${new Date(
          input.businessDate
        ).toLocaleDateString("en-GB", {
          weekday: "long",
          timeZone: "UTC"
        })} (${txnCount} vs ${expectedCount} typical)`,
        details: { txn_count: txnCount, expected_count: expectedCount }
      });
    }
  }

  const perAttendant = buildAttendantBreakdown(effectiveSales, posTransactions);

  for (const attendant of perAttendant) {
    const history = baseline.attendantDailyCounts[attendant.attendant_id] ?? [];
    const attendantMedian = median(history);
    if (attendantMedian === null || attendantMedian === 0) continue;
    if (attendant.txn_count < attendantMedian * settings.attendant_volume_drop_multiplier) {
      flag({
        kind: "attendant_volume_drop",
        severity: "LOW",
        message: `${attendant.attendant_id} logged ${attendant.txn_count} washes against a usual ${attendantMedian}`,
        details: {
          attendant_id: attendant.attendant_id,
          txn_count: attendant.txn_count,
          usual: attendantMedian
        }
      });
    }
  }

  // ---- Check D — vehicles counted vs washes logged (NEW) ----------------
  const vehicles = compareVehicleCount(input, effectiveSales, flag);

  // ---- Behavioural -------------------------------------------------------
  const cashShare = revenueTotal > 0 ? posCashTotal / (posCashTotal + posDigitalTotal) : 0;
  const cashRatioMedian = median(baseline.cashRatios);

  if (
    cashRatioMedian !== null &&
    cashRatioMedian > 0 &&
    revenueTotal > 0 &&
    cashShare > cashRatioMedian * settings.cash_ratio_spike_multiplier
  ) {
    flag({
      kind: "cash_ratio_spike",
      severity: "LOW",
      message: `Cash was ${(cashShare * 100).toFixed(0)}% of takings, against a usual ${(
        cashRatioMedian * 100
      ).toFixed(0)}%`,
      details: { cash_share: round2(cashShare), usual: round2(cashRatioMedian) }
    });
  }

  const openMinutes = timeToMinutes(settings.open_time);
  const closeMinutes = timeToMinutes(settings.close_time);
  const afterHours = posTransactions.filter((t) => {
    const minutes = localMinutesOfDay(t.created_at_local);
    return minutes < openMinutes || minutes >= closeMinutes;
  });

  if (afterHours.length > 0) {
    flag({
      kind: "after_hours_transaction",
      severity: "LOW",
      message: `${afterHours.length} wash(es) logged outside ${settings.open_time}–${settings.close_time}`,
      details: {
        transaction_ids: afterHours.map((t) => t.id),
        times: afterHours.map((t) => t.created_at_local)
      }
    });
  }

  const longGaps = deviceGaps.filter((g) => g.gap_hours > settings.offline_gap_hours);
  for (const gap of longGaps) {
    flag({
      kind: "extended_offline_period",
      severity: "LOW",
      message: `Device ${gap.device_id} did not sync for ${gap.gap_hours.toFixed(
        1
      )} hours during opening hours`,
      details: gap as unknown as Record<string, unknown>
    });
  }

  return {
    business_date: input.businessDate,
    branch_id: input.branchId,
    severity,
    revenue_total: revenueTotal,
    txn_count: txnCount,
    cash_total: posCashTotal,
    digital_total: posDigitalTotal,
    cash_share_pct: round2(cashShare * 100),
    momo_actual_total: momoActualTotal,
    digital_variance: digitalVariance,
    digital_variance_pct: digitalVariancePct,
    momo_checked: settings.momo_enabled,
    expected_cash: expectedCash,
    cash_counted: cashCount?.actual ?? null,
    cash_variance: cashVariance,
    expected_txn_count: expectedCount,
    volume_drop_pct: volumeDropPct,
    vehicles,
    per_attendant: perAttendant,
    matches,
    unmatched_momo: unmatchedMomo,
    unmatched_pos_digital: unmatchedPosDigital,
    corrections: corrections.map((c) => ({
      correction_id: c.id,
      corrects: c.corrects_transaction_id!,
      amount: c.amount
    })),
    flags,
    baseline_available: baselineAvailable
  };
}

/**
 * Check D — vehicles that entered the wash zone vs washes logged on the POS.
 *
 * The comparison is a count against a count over one window, tiered by how far
 * apart they are, exactly like the other three checks. Two details make it
 * honest rather than noisy:
 *
 * The window is asymmetric on purpose. Vehicles are counted between opening
 * and closing; transactions are gathered over the same window plus a settle
 * tail, because a car counted at the gate at 18:55 is paid for at 19:05 and is
 * not an unlogged wash. Nothing extends the vehicle side: a car that entered
 * after close is a different question, and the after-hours check already asks
 * it.
 *
 * The two directions mean opposite things and are tiered separately:
 *
 *   more vehicles than washes — the leakage case, and the only signal in the
 *     system that can see a cash wash that was simply never rung up. Tiered
 *     LOW → MEDIUM → HIGH by percentage, above an absolute tolerance.
 *   more washes than vehicles — the feed is missing cars, or was down for part
 *     of the day. That is a data-quality problem, never an accusation, so it
 *     tops out at MEDIUM and says so in those words.
 *
 * The absolute tolerance before anything is said at all covers the tracker's
 * own error modes (a delivery van turning around in the yard, an id reacquired
 * after a long occlusion and counted twice) — see counting/src/zone-tracker.ts.
 * Without it this check would cry wolf nightly and be ignored within a week,
 * which is the failure mode that matters most for the one check nothing else
 * can substitute for.
 */
function compareVehicleCount(
  input: ReconciliationInput,
  effectiveSales: PosTransaction[],
  flag: (f: Flag) => void
): VehicleComparison {
  const { businessDate, vehicleEvents, settings } = input;

  const windowStartMs = Date.parse(`${businessDate}T${padTime(settings.open_time)}Z`);
  const windowEndMs = Date.parse(`${businessDate}T${padTime(settings.close_time)}Z`);
  const settleMs = settings.vehicle_settle_minutes * 60 * 1000;

  const base: VehicleComparison = {
    checked: false,
    vehicles_counted: 0,
    transactions_counted: 0,
    difference: 0,
    difference_pct: null,
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(windowEndMs).toISOString(),
    peak_in_zone: 0
  };

  if (!settings.vehicle_counting_enabled) {
    // No counting unit at this branch yet. Reporting a clean zero here would
    // be worse than reporting nothing: it would read as "every wash was
    // logged" on the strength of a feed that does not exist.
    return { ...base, skipped_reason: "vehicle counting not enabled for this branch" };
  }

  const inWindow = vehicleEvents.filter((event) => {
    const ms = Date.parse(event.event_time);
    return ms >= windowStartMs && ms <= windowEndMs;
  });

  const transactionsInWindow = effectiveSales.filter((txn) => {
    const ms = Date.parse(txn.created_at_local);
    return ms >= windowStartMs && ms <= windowEndMs + settleMs;
  });

  const vehiclesCounted = inWindow.length;
  const transactionsCounted = transactionsInWindow.length;
  const difference = vehiclesCounted - transactionsCounted;
  const peakInZone = inWindow.reduce((peak, e) => Math.max(peak, e.in_zone_count), 0);

  const comparison: VehicleComparison = {
    ...base,
    checked: true,
    vehicles_counted: vehiclesCounted,
    transactions_counted: transactionsCounted,
    difference,
    difference_pct:
      vehiclesCounted === 0 && transactionsCounted === 0
        ? null
        : round2((difference / Math.max(vehiclesCounted, transactionsCounted, 1)) * 100),
    peak_in_zone: peakInZone
  };

  // The feed is enabled but said nothing all day, while the POS did. Silence
  // from a check is not the same as the check passing — this is the counting
  // equivalent of a dead tablet, and it has to be louder than a small
  // discrepancy, not quieter.
  if (vehiclesCounted === 0) {
    if (transactionsCounted > 0) {
      flag({
        kind: "vehicle_feed_silent",
        severity: "MEDIUM",
        message: `The vehicle counter logged nothing today while ${transactionsCounted} wash(es) were sold — the counting unit is probably down`,
        details: { transactions_counted: transactionsCounted }
      });
    }
    return comparison;
  }

  if (Math.abs(difference) <= settings.vehicle_count_tolerance) {
    return comparison;
  }

  const pct = Math.abs(comparison.difference_pct ?? 0);

  if (difference > 0) {
    const severity: Severity =
      pct >= settings.vehicle_surplus_pct_high
        ? "HIGH"
        : pct >= settings.vehicle_surplus_pct_medium
          ? "MEDIUM"
          : "LOW";

    flag({
      kind: "unlogged_wash_suspected",
      severity,
      message: `${vehiclesCounted} vehicles entered the wash but only ${transactionsCounted} washes were logged — ${difference} unaccounted for (${pct.toFixed(
        0
      )}%)`,
      details: {
        vehicles_counted: vehiclesCounted,
        transactions_counted: transactionsCounted,
        difference,
        difference_pct: comparison.difference_pct
      }
    });
  } else {
    const severity: Severity =
      pct >= settings.vehicle_shortfall_pct_medium ? "MEDIUM" : "LOW";

    flag({
      kind: "vehicle_count_shortfall",
      severity,
      message: `${transactionsCounted} washes were logged but only ${vehiclesCounted} vehicles were counted — the counting feed is missing cars, not the POS`,
      details: {
        vehicles_counted: vehiclesCounted,
        transactions_counted: transactionsCounted,
        difference,
        difference_pct: comparison.difference_pct
      }
    });
  }

  return comparison;
}

/**
 * Longest stretch during opening hours in which a device sent nothing.
 *
 * Every sync leaves a trace — a `synced_at` on the rows it pushed, or a
 * heartbeat row when it had nothing to push. The window is bounded by opening
 * and closing time at both ends, so a device that goes quiet at 14:00 and
 * stays quiet counts its silence up to close rather than reporting no gap at
 * all. "No data" is not "no problem".
 */
export function computeDeviceGaps(
  transactions: PosTransaction[],
  heartbeats: { device_id: string; last_synced_at: string }[],
  businessDate: string,
  openTime: string,
  closeTime: string
): DeviceGap[] {
  const openMs = Date.parse(`${businessDate}T${padTime(openTime)}Z`);
  const closeMs = Date.parse(`${businessDate}T${padTime(closeTime)}Z`);

  const syncTimesByDevice = new Map<string, number[]>();
  const record = (deviceId: string, iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms) || ms < openMs || ms > closeMs) return;
    const times = syncTimesByDevice.get(deviceId) ?? [];
    times.push(ms);
    syncTimesByDevice.set(deviceId, times);
  };

  for (const txn of transactions) {
    if (!syncTimesByDevice.has(txn.device_id)) syncTimesByDevice.set(txn.device_id, []);
    record(txn.device_id, txn.synced_at);
  }
  for (const beat of heartbeats) {
    if (!syncTimesByDevice.has(beat.device_id)) syncTimesByDevice.set(beat.device_id, []);
    record(beat.device_id, beat.last_synced_at);
  }

  const gaps: DeviceGap[] = [];

  for (const [deviceId, times] of syncTimesByDevice) {
    const points = [openMs, ...times.sort((a, b) => a - b), closeMs];
    let longest = 0;
    let start = openMs;

    for (let i = 1; i < points.length; i++) {
      const gap = points[i] - points[i - 1];
      if (gap > longest) {
        longest = gap;
        start = points[i - 1];
      }
    }

    gaps.push({
      device_id: deviceId,
      gap_hours: longest / (60 * 60 * 1000),
      started_at: new Date(start).toISOString(),
      ended_at: new Date(start + longest).toISOString()
    });
  }

  return gaps;
}

function buildAttendantBreakdown(
  effectiveSales: PosTransaction[],
  allTransactions: PosTransaction[]
): AttendantBreakdown[] {
  const byAttendant = new Map<string, AttendantBreakdown>();

  const ensure = (attendantId: string): AttendantBreakdown => {
    let row = byAttendant.get(attendantId);
    if (!row) {
      row = {
        attendant_id: attendantId,
        txn_count: 0,
        revenue: 0,
        cash_revenue: 0,
        digital_revenue: 0
      };
      byAttendant.set(attendantId, row);
    }
    return row;
  };

  for (const txn of effectiveSales) {
    ensure(txn.attendant_id).txn_count += 1;
  }

  // Revenue nets corrections in, so an attendant's total reflects what
  // actually stood at the end of the day.
  for (const txn of allTransactions) {
    const row = ensure(txn.attendant_id);
    row.revenue = round2(row.revenue + txn.amount);
    if (txn.payment_method === "cash") {
      row.cash_revenue = round2(row.cash_revenue + txn.amount);
    } else {
      row.digital_revenue = round2(row.digital_revenue + txn.amount);
    }
  }

  return [...byAttendant.values()].sort((a, b) => b.revenue - a.revenue);
}
