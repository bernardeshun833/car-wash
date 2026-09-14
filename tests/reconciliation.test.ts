import { describe, expect, it } from "vitest";
import {
  computeDeviceGaps,
  median,
  reconcile,
  type FlagKind
} from "../supabase/functions/_shared/reconciliation.ts";
import { DATE, at, cashCount, input, momo, txn } from "./helpers.ts";

function kinds(flags: { kind: FlagKind }[]): FlagKind[] {
  return flags.map((f) => f.kind);
}

describe("median", () => {
  it("returns null with no history", () => {
    expect(median([])).toBeNull();
  });

  it("averages the middle pair for an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("Check A — digital declared vs digital received", () => {
  it("matches a MoMo payment to the digital wash at the same amount and time", () => {
    const sale = txn({ amount: 60, payment_method: "momo", created_at_local: at("14:05") });
    const payment = momo({ amount: 60, timestamp: at("14:12") });

    const report = reconcile(
      input({ posTransactions: [sale], momoPayments: [payment], cashCount: cashCount(200) })
    );

    expect(report.matches).toEqual([
      { transaction_id: sale.id, momo_payment_id: payment.id }
    ]);
    expect(report.unmatched_momo).toHaveLength(0);
    expect(report.unmatched_pos_digital).toHaveLength(0);
    expect(report.severity).toBe("NONE");
  });

  it("does not match outside the 15 minute window", () => {
    const sale = txn({ amount: 60, payment_method: "momo", created_at_local: at("14:00") });
    const payment = momo({ amount: 60, timestamp: at("14:20") });

    const report = reconcile(input({ posTransactions: [sale], momoPayments: [payment] }));

    expect(report.matches).toHaveLength(0);
    expect(kinds(report.flags)).toContain("unmatched_momo");
    expect(kinds(report.flags)).toContain("unmatched_pos_digital");
  });

  it("flags money received with no wash logged as HIGH", () => {
    const report = reconcile(input({ momoPayments: [momo({ amount: 50 })] }));

    expect(kinds(report.flags)).toContain("unmatched_momo");
    expect(report.severity).toBe("HIGH");
  });

  it("flags a digital wash whose money never arrived as HIGH", () => {
    const report = reconcile(
      input({ posTransactions: [txn({ amount: 60, payment_method: "momo" })] })
    );

    expect(kinds(report.flags)).toContain("unmatched_pos_digital");
    expect(report.severity).toBe("HIGH");
  });

  it("pairs each MoMo payment with a distinct wash when amounts are identical", () => {
    const first = txn({ amount: 40, payment_method: "momo", created_at_local: at("09:00") });
    const second = txn({ amount: 40, payment_method: "momo", created_at_local: at("09:20") });
    const payments = [
      momo({ amount: 40, timestamp: at("09:02") }),
      momo({ amount: 40, timestamp: at("09:21") })
    ];

    const report = reconcile(
      input({ posTransactions: [first, second], momoPayments: payments })
    );

    expect(report.matches).toHaveLength(2);
    expect(new Set(report.matches.map((m) => m.transaction_id))).toEqual(
      new Set([first.id, second.id])
    );
    // Closest-in-time pairing, not first-found.
    expect(report.matches[0]).toEqual({
      transaction_id: first.id,
      momo_payment_id: payments[0].id
    });
  });

  it("escalates to HIGH when the digital variance exceeds 1%", () => {
    const sale = txn({ amount: 100, payment_method: "momo", created_at_local: at("11:00") });
    const payment = momo({ amount: 90, timestamp: at("11:01") });

    const report = reconcile(input({ posTransactions: [sale], momoPayments: [payment] }));

    expect(report.digital_variance).toBe(10);
    expect(report.digital_variance_pct).toBeCloseTo(11.11, 1);
    expect(report.severity).toBe("HIGH");
  });

  it("treats a QR wash as matchable against MoMo data", () => {
    const sale = txn({ amount: 25, payment_method: "qr", created_at_local: at("12:00") });
    const report = reconcile(
      input({
        posTransactions: [sale],
        momoPayments: [momo({ amount: 25, timestamp: at("12:03") })]
      })
    );

    expect(report.matches).toHaveLength(1);
  });
});

describe("Check B — cash declared vs cash counted", () => {
  it("computes expected cash as cash washes plus the opening float", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ amount: 40 }), txn({ amount: 60 })],
        cashCount: cashCount(300)
      })
    );

    expect(report.expected_cash).toBe(300);
    expect(report.cash_variance).toBe(0);
    expect(report.severity).toBe("NONE");
  });

  it("flags a shortfall over the threshold as MEDIUM", () => {
    const report = reconcile(
      input({ posTransactions: [txn({ amount: 100 })], cashCount: cashCount(240) })
    );

    expect(report.cash_variance).toBe(-60);
    expect(kinds(report.flags)).toContain("cash_variance");
    expect(report.severity).toBe("MEDIUM");
  });

  it("does not flag a variance inside the threshold", () => {
    const report = reconcile(
      input({ posTransactions: [txn({ amount: 100 })], cashCount: cashCount(280) })
    );

    expect(report.cash_variance).toBe(-20);
    expect(kinds(report.flags)).not.toContain("cash_variance");
  });

  it("ignores the expected figure submitted by the device", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ amount: 500 })],
        cashCount: { ...cashCount(250), actual: 250 }
      })
    );

    expect(report.expected_cash).toBe(700);
    expect(report.cash_variance).toBe(-450);
  });

  it("flags a missing cash count rather than passing the day as clean", () => {
    const report = reconcile(input({ posTransactions: [txn({ amount: 40 })] }));

    expect(kinds(report.flags)).toContain("missing_cash_count");
    expect(report.severity).toBe("MEDIUM");
  });
});

describe("Check C — volume sanity", () => {
  it("flags a drop past 25% against the same weekday", () => {
    const report = reconcile(
      input({
        posTransactions: [txn(), txn(), txn()],
        cashCount: cashCount(320),
        baseline: {
          sameWeekdayCounts: [10, 12, 11, 10, 9, 10, 11, 10],
          attendantDailyCounts: {},
          cashRatios: []
        }
      })
    );

    expect(report.expected_txn_count).toBe(10);
    expect(report.volume_drop_pct).toBe(70);
    expect(kinds(report.flags)).toContain("volume_drop");
    expect(report.severity).toBe("MEDIUM");
  });

  it("skips the volume check entirely while there is no history", () => {
    const report = reconcile(input({ posTransactions: [txn()], cashCount: cashCount(240) }));

    expect(report.baseline_available).toBe(false);
    expect(report.volume_drop_pct).toBeNull();
    expect(kinds(report.flags)).not.toContain("volume_drop");
  });

  it("flags an attendant below 70% of their own usual volume", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ attendant_id: "attendant-1" })],
        cashCount: cashCount(240),
        baseline: {
          sameWeekdayCounts: [],
          attendantDailyCounts: { "attendant-1": [8, 9, 10, 8, 9] },
          cashRatios: []
        }
      })
    );

    expect(kinds(report.flags)).toContain("attendant_volume_drop");
    expect(report.severity).toBe("LOW");
  });

  it("does not flag an attendant holding near their usual volume", () => {
    const report = reconcile(
      input({
        posTransactions: [txn(), txn(), txn(), txn(), txn(), txn(), txn(), txn()],
        cashCount: cashCount(520),
        baseline: {
          sameWeekdayCounts: [],
          attendantDailyCounts: { "attendant-1": [8, 9, 10, 8, 9] },
          cashRatios: []
        }
      })
    );

    expect(kinds(report.flags)).not.toContain("attendant_volume_drop");
  });
});

describe("behavioural checks", () => {
  it("flags a cash share well above the usual mix", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ amount: 100, payment_method: "cash" })],
        cashCount: cashCount(300),
        baseline: {
          sameWeekdayCounts: [],
          attendantDailyCounts: {},
          cashRatios: [0.5, 0.5, 0.55, 0.45]
        }
      })
    );

    expect(report.cash_share_pct).toBe(100);
    expect(kinds(report.flags)).toContain("cash_ratio_spike");
    expect(report.severity).toBe("LOW");
  });

  it("flags a wash logged after closing time", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ created_at_local: at("21:30") })],
        cashCount: cashCount(240)
      })
    );

    expect(kinds(report.flags)).toContain("after_hours_transaction");
  });

  it("does not flag washes inside opening hours", () => {
    const report = reconcile(
      input({
        posTransactions: [
          txn({ created_at_local: at("07:00") }),
          txn({ created_at_local: at("18:59") })
        ],
        cashCount: cashCount(280)
      })
    );

    expect(kinds(report.flags)).not.toContain("after_hours_transaction");
  });

  it("flags a device that went quiet for more than four hours", () => {
    const report = reconcile(
      input({
        posTransactions: [txn()],
        cashCount: cashCount(240),
        deviceGaps: [
          {
            device_id: "tablet-1",
            gap_hours: 6.5,
            started_at: at("10:00"),
            ended_at: at("16:30")
          }
        ]
      })
    );

    expect(kinds(report.flags)).toContain("extended_offline_period");
    expect(report.severity).toBe("LOW");
  });
});

describe("severity", () => {
  it("is NONE on a clean day", () => {
    const sale = txn({ amount: 60, payment_method: "momo", created_at_local: at("13:00") });
    const report = reconcile(
      input({
        posTransactions: [sale, txn({ amount: 40, created_at_local: at("13:30") })],
        momoPayments: [momo({ amount: 60, timestamp: at("13:01") })],
        cashCount: cashCount(240),
        baseline: {
          sameWeekdayCounts: [2, 2, 3, 2],
          attendantDailyCounts: { "attendant-1": [2, 2, 3] },
          cashRatios: [0.4, 0.4, 0.4]
        }
      })
    );

    expect(report.flags).toEqual([]);
    expect(report.severity).toBe("NONE");
  });

  it("takes the highest severity present, not the most recent", () => {
    const report = reconcile(
      input({
        posTransactions: [txn({ amount: 100, created_at_local: at("22:00") })],
        momoPayments: [momo({ amount: 80, timestamp: at("11:00") })],
        cashCount: cashCount(300)
      })
    );

    // after_hours is LOW, unmatched_momo is HIGH.
    expect(kinds(report.flags)).toEqual(
      expect.arrayContaining(["after_hours_transaction", "unmatched_momo"])
    );
    expect(report.severity).toBe("HIGH");
  });
});

describe("corrections", () => {
  it("nets a void out of revenue and out of the wash count", () => {
    const original = txn({ amount: 40, created_at_local: at("10:00") });
    const voided = txn({
      amount: -40,
      corrects_transaction_id: original.id,
      created_at_local: at("10:05")
    });

    const report = reconcile(
      input({ posTransactions: [original, voided], cashCount: cashCount(200) })
    );

    expect(report.revenue_total).toBe(0);
    expect(report.txn_count).toBe(0);
    expect(report.expected_cash).toBe(200);
    expect(report.cash_variance).toBe(0);
    expect(report.corrections).toHaveLength(1);
  });

  it("surfaces MoMo money that arrived for a wash that was later voided", () => {
    const original = txn({
      amount: 60,
      payment_method: "momo",
      created_at_local: at("15:00")
    });
    const voided = txn({
      amount: -60,
      payment_method: "momo",
      corrects_transaction_id: original.id,
      created_at_local: at("15:10")
    });

    const report = reconcile(
      input({
        posTransactions: [original, voided],
        momoPayments: [momo({ amount: 60, timestamp: at("15:01") })],
        cashCount: cashCount(200)
      })
    );

    expect(kinds(report.flags)).toContain("unmatched_momo");
    expect(report.severity).toBe("HIGH");
  });
});

describe("per-attendant breakdown", () => {
  it("splits revenue by attendant and payment type", () => {
    const report = reconcile(
      input({
        posTransactions: [
          txn({ attendant_id: "attendant-1", amount: 40, payment_method: "cash" }),
          txn({
            attendant_id: "attendant-1",
            amount: 60,
            payment_method: "momo",
            created_at_local: at("11:00")
          }),
          txn({ attendant_id: "attendant-2", amount: 25, payment_method: "cash" })
        ],
        momoPayments: [momo({ amount: 60, timestamp: at("11:02") })],
        cashCount: cashCount(265)
      })
    );

    const first = report.per_attendant.find((a) => a.attendant_id === "attendant-1")!;
    expect(first.txn_count).toBe(2);
    expect(first.revenue).toBe(100);
    expect(first.cash_revenue).toBe(40);
    expect(first.digital_revenue).toBe(60);
    expect(report.per_attendant[0].attendant_id).toBe("attendant-1"); // sorted by revenue
  });
});

describe("computeDeviceGaps", () => {
  it("measures silence from opening time to the first sync", () => {
    const gaps = computeDeviceGaps(
      [txn({ device_id: "tablet-1", synced_at: at("13:00") })],
      [],
      DATE,
      "07:00",
      "19:00"
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].gap_hours).toBe(6);
  });

  it("measures silence from the last sync to closing time", () => {
    const gaps = computeDeviceGaps(
      [
        txn({ device_id: "tablet-1", synced_at: at("07:30") }),
        txn({ device_id: "tablet-1", synced_at: at("08:00") })
      ],
      [],
      DATE,
      "07:00",
      "19:00"
    );

    expect(gaps[0].gap_hours).toBe(11);
  });

  it("counts heartbeats as proof of life even with no washes to push", () => {
    const gaps = computeDeviceGaps(
      [],
      [
        { device_id: "tablet-1", last_synced_at: at("11:00") },
        { device_id: "tablet-1", last_synced_at: at("15:00") }
      ],
      DATE,
      "07:00",
      "19:00"
    );

    expect(gaps[0].gap_hours).toBe(4);
  });

  it("reports a full day of silence for a device that never synced", () => {
    const gaps = computeDeviceGaps(
      [],
      [{ device_id: "counter-main-gate", last_synced_at: `${DATE}T23:00:00.000Z` }],
      DATE,
      "07:00",
      "19:00"
    );

    expect(gaps[0].gap_hours).toBe(12);
  });
});
