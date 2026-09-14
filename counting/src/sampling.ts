/**
 * How often the zone has to be sampled, and why.
 *
 * The requirement is that sampling reliably catches a five-minute worst-case
 * turnover, including back-to-back swaps — one car pulling out and another
 * taking the same space seconds later.
 *
 * Two things follow from that, and they pull in the same direction:
 *
 * 1. A vehicle that is only present for the worst-case turnover must be seen
 *    enough times to be *confirmed*. The tracker requires CONFIRM_SAMPLES
 *    consecutive sightings before it will call a track a real arrival (one
 *    stray detection is otherwise an extra car), so a whole visit has to span
 *    at least CONFIRM_SAMPLES + 1 samples, hence
 *
 *        interval <= turnover / (CONFIRM_SAMPLES + 1)
 *
 * 2. Back-to-back swaps are what actually sets the rate, and they are not a
 *    counting problem at all if identity is tracked rather than occupancy
 *    differenced. Car A leaves and car B arrives between two samples: the
 *    occupancy count is unchanged, so a system that only diffed counts would
 *    record nothing and lose a whole wash. Because the tracker compares track
 *    ids, B is a new id and is counted even though the count never moved —
 *    provided B is still present for CONFIRM_SAMPLES + 1 samples, which is
 *    condition 1 again.
 *
 * The safety factor on top covers what the arithmetic does not: dropped
 * frames, a feed that stalls for a beat, a swap that straddles a sample
 * boundary, and clock jitter between the feed and the agent. Four is not
 * derived from anything — it is a deliberate over-sample, chosen because
 * sampling a local feed costs nothing and a missed wash is invisible forever.
 *
 * With the defaults below the margin is very wide: 2s sampling against a
 * ceiling of 25s. That is intentional. The ceiling is what the code enforces;
 * the default is what it actually runs at.
 */

/** The worst-case turnover the feed must catch, from the spec. */
export const WORST_CASE_TURNOVER_MS = 5 * 60 * 1000;

export interface SamplingPolicy {
  /** Milliseconds between sample() calls. */
  intervalMs: number;
  /** Consecutive sightings before a track counts as a real arrival. */
  confirmSamples: number;
  /**
   * Consecutive misses before a track is considered gone. Tolerates brief
   * occlusion — someone walking between the camera and the car — without
   * releasing the id and re-counting the same vehicle on reacquisition.
   */
  releaseSamples: number;
}

export const DEFAULT_SAMPLING: SamplingPolicy = {
  intervalMs: 2_000,
  confirmSamples: 2,
  releaseSamples: 5
};

export const DEFAULT_SAFETY_FACTOR = 4;

/**
 * The slowest sampling that still satisfies the requirement, given how many
 * sightings the tracker needs before it believes a track.
 */
export function maxSafeIntervalMs(
  turnoverMs: number = WORST_CASE_TURNOVER_MS,
  confirmSamples: number = DEFAULT_SAMPLING.confirmSamples,
  safetyFactor: number = DEFAULT_SAFETY_FACTOR
): number {
  return Math.floor(turnoverMs / (confirmSamples + 1) / safetyFactor);
}

/** How many times a visit of the given length is seen at this policy. */
export function expectedSamplesPerVisit(
  policy: SamplingPolicy,
  dwellMs: number = WORST_CASE_TURNOVER_MS
): number {
  return Math.floor(dwellMs / policy.intervalMs);
}

export interface SamplingCheck {
  ok: boolean;
  maxSafeIntervalMs: number;
  samplesPerWorstCaseVisit: number;
  reason?: string;
}

export function checkSampling(
  policy: SamplingPolicy,
  turnoverMs: number = WORST_CASE_TURNOVER_MS,
  safetyFactor: number = DEFAULT_SAFETY_FACTOR
): SamplingCheck {
  const ceiling = maxSafeIntervalMs(turnoverMs, policy.confirmSamples, safetyFactor);
  const samples = expectedSamplesPerVisit(policy, turnoverMs);

  if (policy.intervalMs > ceiling) {
    return {
      ok: false,
      maxSafeIntervalMs: ceiling,
      samplesPerWorstCaseVisit: samples,
      reason:
        `sampling every ${policy.intervalMs}ms cannot reliably catch a ` +
        `${Math.round(turnoverMs / 1000)}s turnover with ` +
        `confirmSamples=${policy.confirmSamples}; use ${ceiling}ms or faster`
    };
  }

  if (samples < policy.confirmSamples + 1) {
    return {
      ok: false,
      maxSafeIntervalMs: ceiling,
      samplesPerWorstCaseVisit: samples,
      reason:
        `a worst-case visit would be seen ${samples} time(s), fewer than the ` +
        `${policy.confirmSamples + 1} needed to confirm it`
    };
  }

  return { ok: true, maxSafeIntervalMs: ceiling, samplesPerWorstCaseVisit: samples };
}

/**
 * Called by the agent at startup. Refusing to start is the right failure: a
 * counting unit that runs too slowly produces an undercount that reads in the
 * nightly report as "every wash was logged", which is the one wrong answer
 * nobody would question.
 */
export function assertSamplingAdequate(
  policy: SamplingPolicy,
  turnoverMs: number = WORST_CASE_TURNOVER_MS,
  safetyFactor: number = DEFAULT_SAFETY_FACTOR
): void {
  const result = checkSampling(policy, turnoverMs, safetyFactor);
  if (!result.ok) {
    throw new Error(`Sampling policy rejected: ${result.reason}`);
  }
}
