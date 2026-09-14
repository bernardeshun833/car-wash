/**
 * The counting feed, as this system is willing to depend on it.
 *
 * No counting-camera vendor has been chosen or quoted yet, so nothing below
 * names one. This is the whole contract: something that can be asked, at any
 * moment, which temporary track ids are currently inside the wash zone. Every
 * decision about what those ids mean — arrivals, occupancy, events worth
 * storing — is made in zone-tracker.ts against this interface, so choosing a
 * vendor means writing one adapter and changing nothing else.
 *
 * Deliberately NOT in this interface, because assuming any of it would tie the
 * design to a product category before the quote arrives:
 *
 *   - plates, colours, makes, or any vehicle identity. The system is
 *     presence-based; a track id is meaningless the moment the vehicle leaves,
 *     and no two visits are ever linked.
 *   - bays or parking positions. There is one zone covering the entire open
 *     wash area, because cars park wherever there is space.
 *   - images or frames. This repo never receives, stores or forwards video.
 *   - the vendor's own notion of an "entry event". Some products emit those,
 *     some only expose current occupancy; taking occupancy as the primitive
 *     works for both, and a push-based product is wrapped by an adapter that
 *     holds the latest state and answers sample() from it.
 */

/** A read of the zone at one instant. */
export interface ZoneSample {
  /** When the feed observed this, ISO 8601. The feed's clock, not ours. */
  at: string;
  /**
   * Temporary tracker ids present in the zone right now. Stable only for as
   * long as the tracker holds the vehicle; order is not meaningful, and
   * duplicates are ignored.
   */
  tracks: string[];
}

export interface VehicleCountSource {
  /** Recorded on every row as `source`, so a vendor swap is auditable. */
  readonly name: string;

  /** Optional connect/handshake. Called once before the first sample. */
  open?(): Promise<void>;

  /**
   * Current occupancy. Must resolve quickly — the agent samples on a fixed
   * interval and a slow feed shows up as a sampling gap, not as a stall.
   * Throwing is acceptable and expected on a flaky link: the agent counts
   * consecutive failures and treats a run of them as feed silence rather than
   * as an empty zone. Returning `{ tracks: [] }` means "I can see the zone and
   * it is empty", which is a completely different claim.
   */
  sample(): Promise<ZoneSample>;

  /** Optional teardown. */
  close?(): Promise<void>;
}

/** One vehicle arrival, as the tracker decided it. */
export interface VehicleArrivalEvent {
  /**
   * When the vehicle entered the zone — the first sample it appeared in, not
   * the sample that confirmed it. Confirmation is a noise filter and would
   * otherwise push every event a second or two late.
   */
  event_time: string;
  /** Occupancy including this arrival, at the moment it was confirmed. */
  in_zone_count: number;
  /** The tracker's temporary id. Identifies a track, never a vehicle. */
  track_ref: string;
  /** The counting unit, not the POS tablet. */
  device_id: string;
  /** Adapter name, from VehicleCountSource.name. */
  source: string;
  /**
   * Stable across retries of the same arrival, so an at-least-once agent
   * inserts exactly once (unique on (branch_id, idempotency_key)).
   */
  idempotency_key: string;
}
