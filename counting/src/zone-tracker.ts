/**
 * Turns a stream of zone samples into vehicle arrival events.
 *
 * Pure and synchronous: no I/O, no clock of its own, no network. Everything it
 * decides is a function of the samples it has been handed, which is what makes
 * the awkward cases (back-to-back swaps, flicker, a tracker reset) testable
 * without a camera — see tests/zone-tracker.test.ts.
 *
 * The rules, in full:
 *
 *   - A track id that has been present for `confirmSamples` consecutive
 *     samples is a real arrival, and produces exactly one event. One stray
 *     detection — a person in a bright jacket, a reflection off wet tarmac —
 *     is seen once and never confirmed, so it produces nothing.
 *   - The event is stamped with the track's FIRST sighting, not its
 *     confirmation, so confirmation never skews arrival times later.
 *   - A track missing for `releaseSamples` consecutive samples has left. Brief
 *     occlusion does not release the id, so the same car is not re-counted
 *     when it reappears.
 *   - Occupancy is the number of currently confirmed tracks. Unconfirmed ones
 *     are not occupancy yet, which keeps in_zone_count consistent with the
 *     events actually emitted.
 *
 * Identity is what makes this work rather than differencing counts. When one
 * car leaves and another takes its space between two samples, occupancy is
 * unchanged — a count-differencing design records nothing and loses a wash.
 * Here the new track id is simply new, and it is counted.
 *
 * The known failure mode, stated plainly because the reconciliation thresholds
 * are set around it: if the tracker loses a stationary car for longer than
 * `releaseSamples` — a long occlusion, a dropped connection, a tracker restart
 * — it reacquires it under a fresh id and this code counts it as a second
 * arrival. Nothing in a presence-based, identity-free design can tell that
 * apart from a genuinely new vehicle. So the vehicle count runs slightly high
 * rather than slightly low, which is the right direction for a check whose
 * surplus side means "a wash may not have been logged": it produces occasional
 * soft flags rather than silent misses. It is also why the 4th check has an
 * absolute tolerance before it says anything at all.
 */

import type { VehicleArrivalEvent, ZoneSample } from "./source.ts";
import { DEFAULT_SAMPLING, type SamplingPolicy } from "./sampling.ts";

export interface ZoneTrackerOptions {
  deviceId: string;
  sourceName: string;
  policy?: SamplingPolicy;
}

interface TrackState {
  firstSeenIso: string;
  consecutiveSightings: number;
  consecutiveMisses: number;
  confirmed: boolean;
}

export interface TrackerStats {
  samplesSeen: number;
  /** Tracks that appeared and vanished before they were ever confirmed. */
  discardedAsNoise: number;
  /** Arrivals emitted over this tracker's lifetime. */
  arrivals: number;
}

export class ZoneTracker {
  private readonly deviceId: string;
  private readonly sourceName: string;
  private readonly policy: SamplingPolicy;
  private readonly tracks = new Map<string, TrackState>();
  private readonly stats: TrackerStats = {
    samplesSeen: 0,
    discardedAsNoise: 0,
    arrivals: 0
  };

  constructor(options: ZoneTrackerOptions) {
    this.deviceId = options.deviceId;
    this.sourceName = options.sourceName;
    this.policy = options.policy ?? DEFAULT_SAMPLING;
  }

  /** Confirmed vehicles currently in the zone. */
  get inZoneCount(): number {
    let count = 0;
    for (const track of this.tracks.values()) {
      if (track.confirmed) count++;
    }
    return count;
  }

  getStats(): TrackerStats {
    return { ...this.stats };
  }

  /**
   * Feed one sample. Returns the arrivals confirmed by this sample — usually
   * none, occasionally one, more only when several cars arrive together.
   */
  observe(sample: ZoneSample): VehicleArrivalEvent[] {
    this.stats.samplesSeen++;

    const present = new Set(sample.tracks);
    const events: VehicleArrivalEvent[] = [];

    // Absences first, so a departure in this sample frees its slot before the
    // arrivals below report occupancy.
    for (const [id, track] of this.tracks) {
      if (present.has(id)) continue;

      track.consecutiveMisses++;
      track.consecutiveSightings = 0;

      if (track.consecutiveMisses >= this.policy.releaseSamples) {
        if (!track.confirmed) this.stats.discardedAsNoise++;
        this.tracks.delete(id);
      }
    }

    // Occupancy before this sample's confirmations, so that two cars arriving
    // together read as 1-then-2 rather than both claiming the same figure.
    let occupancy = this.inZoneCount;

    // Newly present and still-present tracks.
    for (const id of present) {
      let track = this.tracks.get(id);

      if (!track) {
        track = {
          firstSeenIso: sample.at,
          consecutiveSightings: 0,
          consecutiveMisses: 0,
          confirmed: false
        };
        this.tracks.set(id, track);
      }

      track.consecutiveMisses = 0;
      track.consecutiveSightings++;

      if (track.confirmed || track.consecutiveSightings < this.policy.confirmSamples) {
        continue;
      }

      track.confirmed = true;
      occupancy++;
      this.stats.arrivals++;

      events.push({
        event_time: track.firstSeenIso,
        in_zone_count: occupancy,
        track_ref: id,
        device_id: this.deviceId,
        source: this.sourceName,
        idempotency_key: `${this.deviceId}:${id}:${track.firstSeenIso}`
      });
    }

    return events;
  }

  /**
   * Drop all track state. Called when the feed has been unreachable long
   * enough that occupancy cannot be trusted: on reconnect every id is treated
   * as new, because whatever happened in the blind window is unknowable. This
   * over-counts across an outage by design — the alternative is under-counting,
   * which would read as a clean night.
   */
  reset(): void {
    for (const track of this.tracks.values()) {
      if (!track.confirmed) this.stats.discardedAsNoise++;
    }
    this.tracks.clear();
  }
}
