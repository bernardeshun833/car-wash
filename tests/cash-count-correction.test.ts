import { describe, expect, it } from "vitest";
import {
  pickCashCount,
  reconcile,
  type FlagKind
} from "../supabase/functions/_shared/reconciliation.ts";
import { DATE, cashCount, correctedCashCount, input, txn, washes } from "./helpers.ts";

function kinds(flags: { kind: FlagKind }[]): FlagKind[] {
  return flags.map((f) => f.kind);
}

/**
 * A mistyped cash count used to be permanent, and worse, a second count for the
 * same shift could not sync at all: it carried a new id, so the sync engine's
 * id-based upsert could not absorb it, and it failed forever against a unique
 * constraint on (branch_id, shift_date) while the tablet showed a queue that
 * never drained. Counts now append and the latest one stands.
 */
describe("pickCashCount", () => {
  it("has nothing to pick when the drawer was never counted", () => {
    expect(pickCashCount([])).toEqual({ effective: null, superseded: [] });
  });

  it("takes the only count when there is one", () => {
    const only = cashCount(1240);
    const { effective, superseded } = pickCashCount([only]);

    expect(effective!).toBe(only);
    expect(superseded).toEqual([]);
  });

  it("takes the later count and keeps the earlier one", () => {
    const [first, second] = correctedCashCount(12400, 1240);
    const { effective, superseded } = pickCashCount([first, second]);

    expect(effective!.id).toBe(second.id);
    expect(superseded.map((c) => c.id)).toEqual([first.id]);
  });

  it("does not care what order the rows arrive in", () => {
    const [first, second] = correctedCashCount(12400, 1240);
    const { effective } = pickCashCount([second, first]);

    expect(effective!.id).toBe(second.id);
  });

  it("trusts an explicit supersedes over the clock", () => {
    // A tablet with a wrong clock stamps the correction *earlier* than the
    // count it replaces. The stated intent is what should win.
    const first = cashCount(12400, 200, { created_at_local: `${DATE}T19:40:00.000Z` });
    const fix = cashCount(1240, 200, {
      created_at_local: `${DATE}T19:15:00.000Z`,
      supersedes_id: first.id
    });

    expect(pickCashCount([first, fix]).effective!.id).toBe(fix.id);
  });

  it("handles a correction of a correction", () => {
    const first = cashCount(12400, 200, { created_at_local: `${DATE}T19:10:00.000Z` });
    const second = cashCount(1420, 200, {
      created_at_local: `${DATE}T19:20:00.000Z`,
      supersedes_id: first.id
    });
    const third = cashCount(1240, 200, {
      created_at_local: `${DATE}T19:30:00.000Z`,
      supersedes_id: second.id
    });

    const { effective, superseded } = pickCashCount([first, second, third]);
    expect(effective!.id).toBe(third.id);
    expect(superseded).toHaveLength(2);
  });
});

describe("Check B with a corrected count", () => {
  it("reconciles against the corrected figure, not the mistyped one", () => {
    // 26 cash washes at 40 = 1040, plus a 200 float = 1240 expected.
    const report = reconcile(
      input({
        posTransactions: washes(26),
        cashCounts: correctedCashCount(12400, 1240)
      })
    );

    expect(report.cash_counted).toBe(1240);
    expect(report.cash_variance).toBe(0);
    expect(kinds(report.flags)).not.toContain("cash_variance");
  });

  it("tells the owner the count was revised, and what it was before", () => {
    const report = reconcile(
      input({
        posTransactions: washes(26),
        cashCounts: correctedCashCount(12400, 1240)
      })
    );

    const flag = report.flags.find((f) => f.kind === "cash_count_corrected");
    expect(flag?.severity).toBe("LOW");
    expect(flag?.message).toContain("12400.00");
    expect(flag?.message).toContain("1240.00");
    expect(report.severity).toBe("LOW");
  });

  it("keeps the superseded figures in the stored report", () => {
    const report = reconcile(
      input({
        posTransactions: washes(26),
        cashCounts: correctedCashCount(12400, 1240)
      })
    );

    expect(report.cash_counts_recorded).toBe(2);
    expect(report.superseded_cash_counts).toEqual([
      { id: expect.any(String), actual: 12400, counted_by: "Ama & Kofi" }
    ]);
  });

  it("says nothing about corrections when there were none", () => {
    const report = reconcile(
      input({ posTransactions: [txn({ amount: 40 })], cashCount: cashCount(240) })
    );

    expect(report.cash_counts_recorded).toBe(1);
    expect(report.superseded_cash_counts).toEqual([]);
    expect(kinds(report.flags)).not.toContain("cash_count_corrected");
    expect(report.severity).toBe("NONE");
  });

  it("still flags a genuine variance that survives the correction", () => {
    // Corrected from a typo to a figure that is still GHS 100 short.
    const report = reconcile(
      input({ posTransactions: washes(26), cashCounts: correctedCashCount(12400, 1140) })
    );

    expect(report.cash_variance).toBe(-100);
    expect(kinds(report.flags)).toContain("cash_variance");
    expect(report.severity).toBe("MEDIUM");
  });

  it("still reports a missing count when the shift was never counted", () => {
    const report = reconcile(input({ posTransactions: washes(5), cashCounts: [] }));

    expect(report.cash_counted).toBeNull();
    expect(kinds(report.flags)).toContain("missing_cash_count");
  });
});
