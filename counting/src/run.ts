/**
 * The counting agent.
 *
 * Runs on a small box at the yard, next to whatever hardware ends up doing the
 * detection. It samples the zone, turns that into arrival events, and pushes
 * them to the ingest function. It holds no Supabase credentials — only the
 * ingest URL and a shared secret.
 *
 *   npm run count-agent
 *
 * Env (see .env.example):
 *   COUNTING_SOURCE        "simulated" (default) | "scripted"
 *   COUNTING_DEVICE_ID     stable id for this unit, e.g. "counter-main-gate"
 *   COUNTING_BRANCH_ID     branch uuid
 *   COUNTING_INGEST_URL    https://<ref>.supabase.co/functions/v1/vehicle-count-ingest
 *   COUNTING_INGEST_SECRET shared secret, also set as a function secret
 *   COUNTING_INTERVAL_MS   sampling interval (default 2000)
 *   COUNTING_SEED          seed for the simulated source
 *
 * Until a vendor is chosen COUNTING_SOURCE only has mock implementations to
 * offer. Adding a real one is a file next to mock-source.ts and a case in
 * createSource below.
 */

import { EventPublisher } from "./publisher.ts";
import { SimulatedSource } from "./mock-source.ts";
import { assertSamplingAdequate, DEFAULT_SAMPLING, type SamplingPolicy } from "./sampling.ts";
import type { VehicleCountSource } from "./source.ts";
import { ZoneTracker } from "./zone-tracker.ts";

/** Consecutive sample() failures before the feed counts as down. */
const FEED_FAILURE_LIMIT = 5;
/** How often to try to drain the buffer. */
const FLUSH_INTERVAL_MS = 30_000;

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

function createSource(kind: string, policy: SamplingPolicy): VehicleCountSource {
  switch (kind) {
    case "simulated":
      return new SimulatedSource({
        seed: Number(process.env.COUNTING_SEED ?? 1),
        intervalMs: policy.intervalMs
      });
    default:
      throw new Error(
        `Unknown COUNTING_SOURCE "${kind}". No camera vendor has been chosen ` +
          `yet; implement VehicleCountSource for it and add a case here.`
      );
  }
}

async function main(): Promise<void> {
  const policy: SamplingPolicy = {
    ...DEFAULT_SAMPLING,
    intervalMs: Number(process.env.COUNTING_INTERVAL_MS ?? DEFAULT_SAMPLING.intervalMs)
  };

  // Refuses to start rather than under-count quietly. See sampling.ts.
  assertSamplingAdequate(policy);

  const deviceId = env("COUNTING_DEVICE_ID", "counter-dev");
  const source = createSource(env("COUNTING_SOURCE", "simulated"), policy);
  const tracker = new ZoneTracker({ deviceId, sourceName: source.name, policy });

  const publisher = new EventPublisher({
    ingestUrl: env("COUNTING_INGEST_URL"),
    ingestSecret: env("COUNTING_INGEST_SECRET"),
    branchId: env("COUNTING_BRANCH_ID", "00000000-0000-0000-0000-00000000b1a1")
  });

  await source.open?.();

  let consecutiveFailures = 0;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const flushTimer = setInterval(() => {
    void publisher.flush().then((result) => {
      if (result.error) {
        console.warn(`[counting] flush failed: ${result.error} (${result.buffered} buffered)`);
      }
    });
  }, FLUSH_INTERVAL_MS);

  console.log(
    `[counting] ${source.name} on ${deviceId}, sampling every ${policy.intervalMs}ms`
  );

  while (running) {
    const startedAt = Date.now();

    try {
      const sample = await source.sample();
      const events = tracker.observe(sample);

      if (consecutiveFailures >= FEED_FAILURE_LIMIT) {
        // The zone was unobservable for a while; whatever happened in the
        // blind window is unknowable, so start clean rather than pretend the
        // pre-outage occupancy still holds.
        tracker.reset();
        console.warn("[counting] feed recovered — tracker state reset");
      }
      consecutiveFailures = 0;

      if (events.length > 0) {
        publisher.enqueue(events);
        console.log(
          `[counting] ${events.length} arrival(s), ${tracker.inZoneCount} in zone`
        );
      }
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures === FEED_FAILURE_LIMIT) {
        console.error(
          `[counting] feed down after ${FEED_FAILURE_LIMIT} failures: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const elapsed = Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, policy.intervalMs - elapsed)));
  }

  clearInterval(flushTimer);
  const final = await publisher.flushAll();
  await source.close?.();

  console.log(
    `[counting] stopped — ${final.published} published, ${final.buffered} unsent, ` +
      `${final.dropped} dropped, ${JSON.stringify(tracker.getStats())}`
  );
}

main().catch((error) => {
  console.error("[counting] fatal:", error);
  process.exit(1);
});
