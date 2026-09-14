import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchMomoPayments, readMomoConfig } from "../_shared/momo.ts";

/**
 * Pulls recent MoMo payments and inserts them, ignoring any external_ref
 * already stored, so the same payment arriving in two overlapping windows
 * lands once. Insert-only, never an update: momo_payments is append-only
 * (migration 0002), and a payment's amount and timestamp are facts from MTN
 * that should never be rewritten locally.
 *
 * Runs every 15 minutes (migration 0005) with a deliberately generous
 * lookback — the cost of re-fetching a payment we already have is nothing, and
 * the cost of missing one is a false "money arrived with no wash logged" flag
 * in the nightly report.
 */
const LOOKBACK_HOURS = 6;

const BRANCH_ID =
  Deno.env.get("DEFAULT_BRANCH_ID") ?? "00000000-0000-0000-0000-00000000b1a1";

Deno.serve(async () => {
  const config = readMomoConfig();
  if (!config) {
    return Response.json(
      { ok: false, skipped: "MoMo credentials not configured" },
      { status: 200 }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  try {
    const payments = await fetchMomoPayments(config, from.toISOString(), to.toISOString());

    if (payments.length > 0) {
      const { error } = await supabase.from("momo_payments").upsert(
        payments.map((p) => ({
          ...p,
          branch_id: BRANCH_ID,
          fetched_at: new Date().toISOString()
        })),
        { onConflict: "external_ref", ignoreDuplicates: true }
      );

      if (error) throw new Error(error.message);
    }

    return Response.json({ ok: true, fetched: payments.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("momo-sync failed", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
