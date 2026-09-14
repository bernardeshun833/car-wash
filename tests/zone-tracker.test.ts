import { describe, expect, it } from "vitest";
import { ZoneTracker } from "../counting/src/zone-tracker.ts";
import { ScriptedSource, SimulatedSource, scriptSamples } from "../counting/src/mock-source.ts";
import {
  DEFAULT_SAMPLING,
  WORST_CASE_TURNOVER_MS,
  checkSampling,
  assertSamplingAdequate,
  maxSafeIntervalMs
} from "../counting/src/sampling.ts";
import type { VehicleArrivalEvent } from "../counting/src/source.ts";

const POLICY = { intervalMs: 2_000, confirmSamples: 2, releaseSamples: 3 };

function tracker() {
  return new ZoneTracker({
    deviceId: "counter-main-gate",
    sourceName: "mock:scripted",
    policy: POLICY
  });
}

/** Runs a scripted sequence of zone states through a fresh tracker. */
function run(states: string[][]): { events: VehicleArrivalEvent[]; zone: ZoneTracker } {
  const zone = tracker();
  const events = scriptSamples(states, { intervalMs: POLICY.intervalMs }).flatMap((s) =>
    zone.observe(s)
  );
  return { events, zone };
}

describe("ZoneTracker", () => {
  it("counts a vehicle once, after it has been seen enough times to be believed", () => {
    const { events } = run([[], ["a"], ["a"], ["a"], ["a"]]);

    expect(events).toHaveLength(1);
    expect(events[0].track_ref).toBe("a");
    expect(events[0].in_zone_count).toBe(1);
  });

  it("stamps the arrival with the first sighting, not the confirmation", () => {
    const samples = scriptSamples([["a"], ["a"], ["a"]], { intervalMs: POLICY.intervalMs });
    const zone = tracker();
    const events = samples.flatMap((s) => zone.observe(s));

    expect(events[0].event_time).toBe(samples[0].at);
  });

  it("ignores a one-sample blip", () => {
    // A reflection off wet tarmac, a person walking through frame.
    const { events, zone } = run([[], ["ghost"], [], [], [], []]);

    expect(events).toHaveLength(0);
    expect(zone.getStats().discardedAsNoise).toBe(1);
  });

  it("counts a back-to-back swap as two vehicles though occupancy never moved", () => {
    // This is the case the sampling rate exists for. A design that differenced
    // occupancy counts would see 1, 1, 1, 1 and record a single arrival.
    const { events } = run([["a"], ["a"], ["a"], ["b"], ["b"], ["b"]]);

    expect(events.map((e) => e.track_ref)).toEqual(["a", "b"]);
  });

  it("does not re-count a vehicle that flickers out for a sample or two", () => {
    const { events } = run([["a"], ["a"], [], ["a"], ["a"], ["a"]]);

    expect(events).toHaveLength(1);
  });

  it("counts a reacquired id as a new vehicle once the track is released", () => {
    // The known over-count: a long occlusion releases the id, and a
    // presence-based tracker cannot tell reacquisition from a new car. The
    // reconciliation tolerance exists for exactly this.
    const { events } = run([
      ["a"],
      ["a"],
      [],
      [],
      [],
      [],
      ["a2"],
      ["a2"],
      ["a2"]
    ]);

    expect(events).toHaveLength(2);
  });

  it("reports occupancy as vehicles accumulate and leave", () => {
    const { events, zone } = run([
      ["a"],
      ["a"],
      ["a", "b"],
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c"]
    ]);

    expect(events.map((e) => e.in_zone_count)).toEqual([1, 2, 3]);
    expect(zone.inZoneCount).toBe(3);
  });

  it("numbers two simultaneous arrivals in sequence rather than identically", () => {
    const { events } = run([["x", "y"], ["x", "y"], ["x", "y"]]);

    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.in_zone_count))).toEqual(new Set([1, 2]));
  });

  it("drops occupancy when a vehicle leaves for good", () => {
    const { zone } = run([["a"], ["a"], [], [], [], []]);

    expect(zone.inZoneCount).toBe(0);
  });

  it("gives every arrival a distinct, retry-stable idempotency key", () => {
    const { events } = run([["a"], ["a"], ["b"], ["b"], ["b"]]);
    const keys = events.map((e) => e.idempotency_key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain("counter-main-gate");

    // Replaying the same samples on a fresh tracker produces the same keys, so
    // a re-sent batch lands on the same unique constraint.
    const { events: replay } = run([["a"], ["a"], ["b"], ["b"], ["b"]]);
    expect(replay.map((e) => e.idempotency_key)).toEqual(keys);
  });

  it("treats everything as new after a reset, rather than under-counting", () => {
    const zone = tracker();
    const samples = scriptSamples([["a"], ["a"], ["a"]], { intervalMs: POLICY.intervalMs });
    samples.forEach((s) => zone.observe(s));

    zone.reset();
    expect(zone.inZoneCount).toBe(0);

    const after = scriptSamples([["a"], ["a"]], { intervalMs: POLICY.intervalMs }).flatMap(
      (s) => zone.observe(s)
    );
    expect(after).toHaveLength(1);
  });

  it("counts every car of a five-minute-turnover day at the default rate", async () => {
    // Twelve cars, each present for exactly the worst-case turnover, one
    // leaving as the next arrives — 5 hours of yard, sampled at 2s.
    const samplesPerVisit = WORST_CASE_TURNOVER_MS / POLICY.intervalMs;
    const states: string[][] = [];
    for (let car = 0; car < 12; car++) {
      for (let i = 0; i < samplesPerVisit; i++) states.push([`car-${car}`]);
    }

    const { events } = run(states);
    expect(events).toHaveLength(12);
  });

  it("drives off any VehicleCountSource, not just the scripted one", async () => {
    const source = new ScriptedSource(
      scriptSamples([["a"], ["a"], ["a"]], { intervalMs: POLICY.intervalMs })
    );
    const zone = tracker();
    const events: VehicleArrivalEvent[] = [];

    while (!source.exhausted) {
      events.push(...zone.observe(await source.sample()));
    }

    expect(events).toHaveLength(1);
    expect(source.name).toBe("mock:scripted");
  });

  it("produces a plausible day from the simulated feed, repeatably", async () => {
    const day = async () => {
      const source = new SimulatedSource({
        seed: 7,
        intervalMs: POLICY.intervalMs,
        startAt: new Date("2026-09-10T07:00:00.000Z")
      });
      const zone = new ZoneTracker({
        deviceId: "counter-main-gate",
        sourceName: source.name,
        policy: POLICY
      });
      const events: VehicleArrivalEvent[] = [];
      // 12 hours of yard at 2s per sample.
      for (let i = 0; i < (12 * 60 * 60 * 1000) / POLICY.intervalMs; i++) {
        events.push(...zone.observe(await source.sample()));
      }
      return events;
    };

    const first = await day();
    const second = await day();

    expect(first.length).toBeGreaterThan(0);
    expect(second.map((e) => e.idempotency_key)).toEqual(
      first.map((e) => e.idempotency_key)
    );
  });
});

describe("sampling policy", () => {
  it("accepts the default rate against a five-minute turnover", () => {
    const result = checkSampling(DEFAULT_SAMPLING);

    expect(result.ok).toBe(true);
    expect(result.samplesPerWorstCaseVisit).toBeGreaterThanOrEqual(
      DEFAULT_SAMPLING.confirmSamples + 1
    );
    expect(() => assertSamplingAdequate(DEFAULT_SAMPLING)).not.toThrow();
  });

  it("rejects a rate too slow to catch the worst case", () => {
    const slow = { ...DEFAULT_SAMPLING, intervalMs: 60_000 };

    expect(checkSampling(slow).ok).toBe(false);
    expect(() => assertSamplingAdequate(slow)).toThrow(/cannot reliably catch/);
  });

  it("tightens the ceiling as the tracker demands more confirmations", () => {
    expect(maxSafeIntervalMs(WORST_CASE_TURNOVER_MS, 2)).toBeGreaterThan(
      maxSafeIntervalMs(WORST_CASE_TURNOVER_MS, 5)
    );
  });

  it("is driven by the turnover it is given, not a hard-coded five minutes", () => {
    const twoMinutes = 2 * 60 * 1000;
    expect(maxSafeIntervalMs(twoMinutes, 2)).toBeLessThan(
      maxSafeIntervalMs(WORST_CASE_TURNOVER_MS, 2)
    );
  });
});
