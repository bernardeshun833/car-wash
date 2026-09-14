import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Ingest endpoint for the counting agent (counting/src/run.ts).
 *
 * The agent runs on a box at the yard, on a network nobody controls. It
 * therefore holds no Supabase key — only this URL and a shared secret. The
 * secret buys one thing: the ability to append vehicle count rows. It cannot
 * read transactions, cannot read reports, and cannot touch anything else, so
 * the worst a stolen counting-unit secret does is inject fake arrivals — which
 * shows up in the nightly report as a discrepancy, loudly, rather than
 * silently hiding one.
 *
 * Idempotent on (branch_id, idempotency_key): the agent retries over a bad
 * link and every retry must land exactly once. Inserts use ignoreDuplicates
 * rather than a merge, because vehicle_count_events is append-only (migration
 * 0002) and an upsert that updated would be rejected by the guard trigger.
 */

interface IncomingEvent {
  event_time: string;
  in_zone_count: number;
  track_ref?: string;
  device_id: string;
  source: string;
  idempotency_key: string;
}

const MAX_EVENTS_PER_REQUEST = 500;

Deno.serve(async (req) => {
  const secret = Deno.env.get("COUNTING_INGEST_SECRET");
  if (!secret) {
    return Response.json(
      { ok: false, error: "COUNTING_INGEST_SECRET is not configured" },
      { status: 500 }
    );
  }

  if (req.headers.get("X-Counting-Secret") !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { branch_id?: string; events?: IncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const branchId = body.branch_id;
  const events = body.events ?? [];

  if (!branchId) {
    return Response.json({ ok: false, error: "branch_id is required" }, { status: 400 });
  }
  if (events.length === 0) {
    return Response.json({ ok: true, inserted: 0 });
  }
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return Response.json(
      { ok: false, error: `at most ${MAX_EVENTS_PER_REQUEST} events per request` },
      { status: 413 }
    );
  }

  const invalid = events.find(
    (e) =>
      typeof e?.event_time !== "string" ||
      !Number.isInteger(e?.in_zone_count) ||
      e.in_zone_count < 0 ||
      typeof e?.device_id !== "string" ||
      typeof e?.idempotency_key !== "string"
  );
  if (invalid) {
    return Response.json(
      { ok: false, error: "every event needs event_time, in_zone_count, device_id and idempotency_key" },
      { status: 400 }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const rows = events.map((e) => ({
    branch_id: branchId,
    event_time: e.event_time,
    in_zone_count: e.in_zone_count,
    track_ref: e.track_ref ?? null,
    device_id: e.device_id,
    source: e.source ?? "unknown",
    idempotency_key: e.idempotency_key
  }));

  const { error } = await supabase
    .from("vehicle_count_events")
    .upsert(rows, { onConflict: "branch_id,idempotency_key", ignoreDuplicates: true });

  if (error) {
    console.error("vehicle-count-ingest failed", error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // The counting unit's liveness matters as much as the tablet's: a dead
  // counter makes the 4th check read as "everything was logged".
  const latest = events.reduce((a, b) => (a.event_time > b.event_time ? a : b));
  await supabase.from("device_heartbeats").upsert(
    {
      device_id: latest.device_id,
      branch_id: branchId,
      device_kind: "counter",
      last_synced_at: new Date().toISOString()
    },
    { onConflict: "device_id" }
  );

  return Response.json({ ok: true, accepted: rows.length });
});
