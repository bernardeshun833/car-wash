/**
 * The stand-in counting feed.
 *
 * No vendor has been chosen or quoted, so this is what the system is built and
 * tested against. It is not a toy: it is the reference implementation of
 * VehicleCountSource, it is what the agent runs in development, and it is what
 * the tracker tests drive. When a vendor is picked, the work is a new file
 * next to this one implementing the same interface — nothing downstream of
 * `sample()` needs to know.
 *
 * Two implementations:
 *
 *   ScriptedSource  — a fixed list of (time, tracks) samples. Deterministic,
 *                     no clock, no randomness. This is what the tests use, and
 *                     it is how a back-to-back swap or a tracker reset gets
 *                     reproduced exactly.
 *   SimulatedSource — a wash yard that behaves roughly like a real one:
 *                     vehicles arrive, stay for a while, leave. Seeded, so a
 *                     given seed always produces the same day. For running the
 *                     agent end to end without hardware.
 */

import type { VehicleCountSource, ZoneSample } from "./source.ts";

/** Replays a fixed sequence of samples, in order, one per call. */
export class ScriptedSource implements VehicleCountSource {
  readonly name: string;
  private readonly samples: ZoneSample[];
  private index = 0;

  // Plain fields rather than constructor parameter properties: the counting
  // agent runs under `node --experimental-strip-types`, which erases types
  // without transforming syntax, and parameter properties need a transform.
  constructor(samples: ZoneSample[], name = "mock:scripted") {
    this.samples = samples;
    this.name = name;
  }

  get exhausted(): boolean {
    return this.index >= this.samples.length;
  }

  async sample(): Promise<ZoneSample> {
    const next = this.samples[this.index];
    if (!next) throw new Error("ScriptedSource exhausted");
    this.index++;
    return next;
  }
}

export interface SimulatedSourceOptions {
  /** Anything deterministic; the same seed replays the same day. */
  seed?: number;
  /** Milliseconds of simulated time per sample. Match the agent's interval. */
  intervalMs?: number;
  /** Simulated clock start. Defaults to the real clock at construction. */
  startAt?: Date;
  /** Mean time a vehicle spends in the zone. */
  meanDwellMs?: number;
  /** Shortest possible visit — the worst-case turnover the feed must catch. */
  minDwellMs?: number;
  /** Probability that a given sample brings a new arrival. */
  arrivalChance?: number;
  /** Cars the yard physically holds. */
  capacity?: number;
}

/**
 * A plausible wash yard. Vehicles arrive at random, dwell for a randomised
 * time, and leave; the zone holds up to `capacity` of them. Occasionally two
 * cars swap back to back, which is the case the sampling rate exists for.
 */
export class SimulatedSource implements VehicleCountSource {
  readonly name = "mock:simulated";

  private readonly intervalMs: number;
  private readonly meanDwellMs: number;
  private readonly minDwellMs: number;
  private readonly arrivalChance: number;
  private readonly capacity: number;

  private clock: number;
  private seed: number;
  private nextTrackId = 1;
  private present: { id: string; leavesAt: number }[] = [];

  constructor(options: SimulatedSourceOptions = {}) {
    this.seed = options.seed ?? 1;
    this.intervalMs = options.intervalMs ?? 2_000;
    this.meanDwellMs = options.meanDwellMs ?? 12 * 60 * 1000;
    this.minDwellMs = options.minDwellMs ?? 5 * 60 * 1000;
    this.arrivalChance = options.arrivalChance ?? 0.01;
    this.capacity = options.capacity ?? 6;
    this.clock = (options.startAt ?? new Date()).getTime();
  }

  /** Mulberry32 — small, seeded, and good enough to make a day repeatable. */
  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  async sample(): Promise<ZoneSample> {
    this.clock += this.intervalMs;

    this.present = this.present.filter((v) => v.leavesAt > this.clock);

    if (this.present.length < this.capacity && this.random() < this.arrivalChance) {
      const dwell = this.minDwellMs + this.random() * (this.meanDwellMs - this.minDwellMs) * 2;
      this.present.push({
        id: `trk-${this.nextTrackId++}`,
        leavesAt: this.clock + dwell
      });
    }

    return {
      at: new Date(this.clock).toISOString(),
      tracks: this.present.map((v) => v.id)
    };
  }
}

/**
 * Builds a scripted sample list from a compact description: for each sample,
 * the track ids present. Keeps the tests readable — the sequence of zone
 * states is the thing under test, and the timestamps are bookkeeping.
 */
export function scriptSamples(
  states: string[][],
  options: { startAt?: string; intervalMs?: number } = {}
): ZoneSample[] {
  const start = Date.parse(options.startAt ?? "2026-09-14T08:00:00.000Z");
  const interval = options.intervalMs ?? 2_000;

  return states.map((tracks, i) => ({
    at: new Date(start + i * interval).toISOString(),
    tracks
  }));
}
