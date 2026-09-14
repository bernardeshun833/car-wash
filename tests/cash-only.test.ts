import { describe, expect, it } from "vitest";
import { reconcile, type FlagKind } from "../supabase/functions/_shared/reconciliation.ts";
import { at, cashCount, cashOnly, input, momo, txn, vehicles, washes } from "./helpers.ts";

function kinds(flags: { kind: FlagKind }[]): FlagKind[] {
  return flags.map((f) => f.kind);
}

/**
 * The wash takes cash only for now; MoMo comes later. These tests pin down
 * that the system is genuinely useful in that state rather than merely not
 * crashing — and that switching MoMo on later is one flag, not a rewrite.
 */
describe("cash-only operation", () => {
  it("runs a clean day end to end with no MoMo at all", () => {
    const report = reconcile(
      input({
        posTransactions: [
          txn({ amount: 40, created_at_local: at("09:00") }),
          txn({ amount: 60, created_at_local: at("11:00") }),
          txn({ amount: 40, created_at_local: at("15:00") })
        ],
        cashCount: cashCount(340),
        settings: cashOnly()
      })
    );

    expect(report.flags).toEqual([]);
    expect(report.severity).toBe("NONE");
    expect(report.revenue_total).toBe(140);
    expect(report.cash_share_pct).toBe(100);
  });

  it("reports that Check A did not run, rather than reporting it as passed", () => {
    const report = reconcile(
      input({ posTransactions: washes(8), cashCount: cashCount(520), settings: cashOnly() })
    );

    expect(report.momo_checked).toBe(false);
    expect(report.digital_total).toBe(0);
    expect(report.matches).toEqual([]);
  });

  it("still catches a cash variance — the drawer check does not depend on MoMo", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ amount: 100 })],
        cashCount: cashCount(240),
        settings: cashOnly()
      })
    );

    expect(report.cash_variance).toBe(-60);
    expect(kinds(report.flags)).toContain("cash_variance");
    expect(report.severity).toBe("MEDIUM");
  });

  it("still catches unlogged washes — the vehicle count does not depend on MoMo either", () => {
    const report = reconcile(
      input({
        posTransactions: washes(12),
        vehicleEvents: vehicles(20),
        cashCount: cashCount(680),
        settings: cashOnly({ vehicle_counting_enabled: true })
      })
    );

    expect(report.flags.find((f) => f.kind === "unlogged_wash_suspected")?.severity).toBe(
      "HIGH"
    );
  });

  it("does not cry wolf about digital money that was never expected", () => {
    // The whole point of the switch: without it, every cash-only night would
    // report a digital variance against an empty feed.
    const report = reconcile(
      input({ posTransactions: washes(10), cashCount: cashCount(600), settings: cashOnly() })
    );

    expect(kinds(report.flags)).not.toContain("unmatched_pos_digital");
    expect(kinds(report.flags)).not.toContain("unmatched_momo");
    expect(report.severity).toBe("NONE");
  });

  it("says so once if a digital wash gets logged while the branch is cash only", () => {
    const report = reconcile(
      input({
        posTransactions: [
          txn({ amount: 40 }),
          txn({ amount: 60, payment_method: "momo", created_at_local: at("12:00") })
        ],
        cashCount: cashCount(240),
        settings: cashOnly()
      })
    );

    const flag = report.flags.find((f) => f.kind === "digital_without_momo_feed");
    expect(flag?.severity).toBe("MEDIUM");
    expect(flag?.message).toContain("cash only");
    // One flag about the mismatch, not one per digital row plus a variance.
    expect(kinds(report.flags)).not.toContain("unmatched_pos_digital");
  });

  it("says so if MoMo money arrives for a branch nobody turned MoMo on for", () => {
    const report = reconcile(
      input({
        posTransactions: washes(5),
        momoPayments: [momo({ amount: 50, timestamp: at("10:00") })],
        cashCount: cashCount(400),
        settings: cashOnly()
      })
    );

    const flag = report.flags.find((f) => f.kind === "digital_without_momo_feed");
    expect(flag?.severity).toBe("MEDIUM");
    expect(kinds(report.flags)).not.toContain("unmatched_momo");
  });

  it("starts reconciling digital money the moment the flag is turned on", () => {
    // Same day, same rows — only the setting differs.
    const day = {
      posTransactions: [
        txn({ amount: 60, payment_method: "momo", created_at_local: at("14:05") })
      ],
      momoPayments: [momo({ amount: 60, timestamp: at("14:08") })],
      cashCount: cashCount(200)
    };

    const off = reconcile(input({ ...day, settings: cashOnly() }));
    const on = reconcile(input({ ...day, settings: cashOnly({ momo_enabled: true }) }));

    expect(off.momo_checked).toBe(false);
    expect(off.matches).toHaveLength(0);

    expect(on.momo_checked).toBe(true);
    expect(on.matches).toHaveLength(1);
    expect(on.severity).toBe("NONE");
  });
});
