import { describe, expect, it } from "vitest";
import { reconcile, type FlagKind } from "../supabase/functions/_shared/reconciliation.ts";
import { at, cashCount, countingOn, input, vehicle, vehicles, washes } from "./helpers.ts";

function kinds(flags: { kind: FlagKind }[]): FlagKind[] {
  return flags.map((f) => f.kind);
}

describe("Check D — vehicles counted vs washes logged", () => {
  it("is skipped, not passed, when no counting unit is installed", () => {
    const report = reconcile(
      input({ posTransactions: washes(10), cashCount: cashCount(600) })
    );

    expect(report.vehicles.checked).toBe(false);
    expect(report.vehicles.skipped_reason).toMatch(/not enabled/);
    expect(kinds(report.flags)).not.toContain("unlogged_wash_suspected");
    expect(kinds(report.flags)).not.toContain("vehicle_feed_silent");
  });

  it("says nothing when the two counts agree", () => {
    const report = reconcile(
      input({
        posTransactions: washes(12),
        vehicleEvents: vehicles(12),
        cashCount: cashCount(680),
        settings: countingOn()
      })
    );

    expect(report.vehicles.checked).toBe(true);
    expect(report.vehicles.difference).toBe(0);
    expect(report.severity).toBe("NONE");
  });

  it("stays quiet inside the absolute tolerance", () => {
    // Two extra vehicles — a delivery van turning in the yard, or one id
    // reacquired after a long occlusion. Below tolerance, so nothing is said.
    const report = reconcile(
      input({
        posTransactions: washes(20),
        vehicleEvents: vehicles(22),
        cashCount: cashCount(1000),
        settings: countingOn()
      })
    );

    expect(report.vehicles.difference).toBe(2);
    expect(report.flags).toEqual([]);
  });

  it("tiers a small surplus as LOW", () => {
    // 33 vs 30: above the absolute tolerance, but 9% — under the 10% step.
    const report = reconcile(
      input({
        posTransactions: washes(30),
        vehicleEvents: vehicles(33),
        cashCount: cashCount(1400),
        settings: countingOn()
      })
    );

    const flag = report.flags.find((f) => f.kind === "unlogged_wash_suspected");
    expect(flag?.severity).toBe("LOW");
    expect(report.vehicles.difference).toBe(3);
    expect(report.severity).toBe("LOW");
  });

  it("tiers a moderate surplus as MEDIUM", () => {
    const report = reconcile(
      input({
        posTransactions: washes(18),
        vehicleEvents: vehicles(22),
        cashCount: cashCount(920),
        settings: countingOn()
      })
    );

    const flag = report.flags.find((f) => f.kind === "unlogged_wash_suspected");
    expect(flag?.severity).toBe("MEDIUM");
    expect(report.severity).toBe("MEDIUM");
  });

  it("tiers a large surplus as HIGH — the unlogged-cash-wash case", () => {
    // 20 cars in, 12 washes rung up. Nothing else in the system can see this:
    // the drawer balances against what was declared and MoMo never saw it.
    const report = reconcile(
      input({
        posTransactions: washes(12),
        vehicleEvents: vehicles(20),
        cashCount: cashCount(680),
        settings: countingOn()
      })
    );

    const flag = report.flags.find((f) => f.kind === "unlogged_wash_suspected");
    expect(flag?.severity).toBe("HIGH");
    expect(flag?.message).toContain("20 vehicles");
    expect(report.severity).toBe("HIGH");
  });

  it("treats more washes than vehicles as a feed fault, capped at MEDIUM", () => {
    const report = reconcile(
      input({
        posTransactions: washes(20),
        vehicleEvents: vehicles(12),
        cashCount: cashCount(1000),
        settings: countingOn()
      })
    );

    const flag = report.flags.find((f) => f.kind === "vehicle_count_shortfall");
    expect(flag?.severity).toBe("MEDIUM");
    expect(flag?.message).toContain("counting feed is missing cars");
    expect(report.severity).toBe("MEDIUM");
    // Never an accusation in this direction.
    expect(kinds(report.flags)).not.toContain("unlogged_wash_suspected");
  });

  it("flags a silent feed rather than reading zero vehicles as a clean day", () => {
    const report = reconcile(
      input({
        posTransactions: washes(15),
        vehicleEvents: [],
        cashCount: cashCount(800),
        settings: countingOn()
      })
    );

    const flag = report.flags.find((f) => f.kind === "vehicle_feed_silent");
    expect(flag?.severity).toBe("MEDIUM");
    expect(kinds(report.flags)).not.toContain("unlogged_wash_suspected");
  });

  it("says nothing at all on a closed day with no cars and no washes", () => {
    const report = reconcile(
      input({ vehicleEvents: [], cashCount: cashCount(200), settings: countingOn() })
    );

    expect(kinds(report.flags)).not.toContain("vehicle_feed_silent");
    expect(report.vehicles.difference_pct).toBeNull();
    expect(report.severity).toBe("NONE");
  });

  it("gives the last car of the day time to pay before calling it unlogged", () => {
    // Counted at 18:55, paid at 19:10 — after close, inside the settle window.
    const late = washes(9).concat({
      ...washes(1)[0],
      id: "txn-late",
      created_at_local: at("19:10")
    });

    const report = reconcile(
      input({
        posTransactions: late,
        vehicleEvents: vehicles(9).concat(
          vehicle({ event_time: at("18:55"), in_zone_count: 1 })
        ),
        cashCount: cashCount(600),
        settings: countingOn()
      })
    );

    expect(report.vehicles.transactions_counted).toBe(10);
    expect(report.vehicles.difference).toBe(0);
    expect(kinds(report.flags)).not.toContain("unlogged_wash_suspected");
  });

  it("does not count vehicles that entered outside opening hours", () => {
    const report = reconcile(
      input({
        posTransactions: washes(10),
        vehicleEvents: vehicles(10).concat(
          vehicle({ event_time: at("03:00") }),
          vehicle({ event_time: at("23:30") })
        ),
        cashCount: cashCount(600),
        settings: countingOn()
      })
    );

    expect(report.vehicles.vehicles_counted).toBe(10);
    expect(report.vehicles.difference).toBe(0);
  });

  it("excludes voided washes from the comparison", () => {
    // A wash rung up and voided did not happen, so the car that was counted
    // for it is genuinely unaccounted for.
    const original = washes(1)[0];
    const voided = {
      ...original,
      id: "txn-void",
      amount: -original.amount,
      corrects_transaction_id: original.id,
      created_at_local: at("10:05")
    };

    const report = reconcile(
      input({
        posTransactions: [original, voided],
        vehicleEvents: vehicles(6),
        cashCount: cashCount(200),
        settings: countingOn()
      })
    );

    expect(report.vehicles.transactions_counted).toBe(0);
    expect(report.vehicles.vehicles_counted).toBe(6);
    expect(kinds(report.flags)).toContain("unlogged_wash_suspected");
  });

  it("reports peak occupancy alongside the comparison", () => {
    const report = reconcile(
      input({
        posTransactions: washes(6),
        vehicleEvents: vehicles(6),
        cashCount: cashCount(440),
        settings: countingOn()
      })
    );

    expect(report.vehicles.peak_in_zone).toBeGreaterThan(0);
    expect(report.vehicles.window_start).toContain("T07:00");
    expect(report.vehicles.window_end).toContain("T19:00");
  });

  it("carries its own thresholds, so a branch can be tuned without a redeploy", () => {
    const strict = reconcile(
      input({
        posTransactions: washes(20),
        vehicleEvents: vehicles(24),
        cashCount: cashCount(1000),
        settings: countingOn({ vehicle_surplus_pct_high: 5, vehicle_count_tolerance: 1 })
      })
    );

    expect(strict.flags.find((f) => f.kind === "unlogged_wash_suspected")?.severity).toBe(
      "HIGH"
    );
  });
});
