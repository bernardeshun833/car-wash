import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  computeDeviceGaps,
  reconcile,
  type Baseline,
  type BusinessDateReport,
  type CashCountRow,
  type MomoPayment,
  type PosTransaction,
  type ReconciliationSettings,
  type VehicleCountEvent
} from "../_shared/reconciliation.ts";
import { emailHtml, emailSubject, whatsappAlert } from "../_shared/report.ts";
import { sendEmail, sendWhatsApp } from "../_shared/notify.ts";

const DEFAULT_BRANCH_ID =
  Deno.env.get("DEFAULT_BRANCH_ID") ?? "00000000-0000-0000-0000-00000000b1a1";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Cron fires after close, so "today" is the business day that just ended.
  // An explicit ?date= lets a missed night be re-run by hand, and ?branch=
  // is already here so a second site needs no code change.
  const url = new URL(req.url);
  const businessDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const branchId = url.searchParams.get("branch") ?? DEFAULT_BRANCH_ID;

  try {
    const report = await runReconciliation(supabase, businessDate, branchId);
    const delivery = await deliver(supabase, report);
    return Response.json({ ok: true, severity: report.severity, delivery });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("nightly-reconciliation failed", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

async function runReconciliation(
  supabase: SupabaseClient,
  businessDate: string,
  branchId: string
): Promise<BusinessDateReport> {
  const dayStart = `${businessDate}T00:00:00Z`;
  const dayEnd = `${businessDate}T23:59:59.999Z`;

  const settingsRow = await supabase
    .from("branch_settings")
    .select("*")
    .eq("branch_id", branchId)
    .single();
  if (settingsRow.error) throw new Error(`settings: ${settingsRow.error.message}`);
  const settings = settingsRow.data as ReconciliationSettings & {
    owner_email: string | null;
    owner_whatsapp: string | null;
  };

  // Gather the four independent sources. None of them depends on another, and
  // three of them are outside the reach of whoever is logging sales.
  const [txnRes, momoRes, cashRes, vehicleRes, heartbeatRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("*")
      .eq("branch_id", branchId)
      .gte("created_at_local", dayStart)
      .lte("created_at_local", dayEnd),
    supabase
      .from("momo_payments")
      .select("*")
      .eq("branch_id", branchId)
      .gte("timestamp", dayStart)
      .lte("timestamp", dayEnd),
    // Every count for the shift, not just one: a corrected count appends a new
    // row rather than replacing the first, and reconcile() decides which
    // stands. maybeSingle() here would throw the moment a count was revised.
    supabase
      .from("cash_counts")
      .select("*")
      .eq("branch_id", branchId)
      .eq("shift_date", businessDate)
      .order("created_at_local", { ascending: true }),
    supabase
      .from("vehicle_count_events")
      .select("id, event_time, in_zone_count, device_id, source")
      .eq("branch_id", branchId)
      .gte("event_time", dayStart)
      .lte("event_time", dayEnd),
    supabase
      .from("device_heartbeats")
      .select("device_id, last_synced_at")
      .eq("branch_id", branchId)
  ]);

  if (txnRes.error) throw new Error(`transactions: ${txnRes.error.message}`);
  if (momoRes.error) throw new Error(`momo_payments: ${momoRes.error.message}`);
  if (cashRes.error) throw new Error(`cash_counts: ${cashRes.error.message}`);
  if (vehicleRes.error) throw new Error(`vehicle_count_events: ${vehicleRes.error.message}`);
  if (heartbeatRes.error) throw new Error(`device_heartbeats: ${heartbeatRes.error.message}`);

  const posTransactions = (txnRes.data ?? []).map(toPosTransaction);
  const momoPayments = (momoRes.data ?? []).map(toMomoPayment);
  const cashCounts = (cashRes.data ?? []).map(toCashCount);
  const vehicleEvents = (vehicleRes.data ?? []).map(toVehicleEvent);

  const deviceGaps = computeDeviceGaps(
    posTransactions,
    heartbeatRes.data ?? [],
    businessDate,
    settings.open_time,
    settings.close_time
  );

  const baseline = await loadBaseline(supabase, businessDate, branchId);

  const report = reconcile({
    businessDate,
    branchId,
    posTransactions,
    momoPayments,
    cashCounts,
    vehicleEvents,
    deviceGaps,
    baseline,
    settings
  });

  await persist(supabase, report);
  return report;
}

/**
 * The baseline comes from previously stored reports rather than from the raw
 * transaction table. Stored reports already exclude voided entries and are
 * cheap to scan — and it means the rolling medians are built from the same
 * numbers the owner was shown, not a recomputation that might quietly differ.
 */
async function loadBaseline(
  supabase: SupabaseClient,
  businessDate: string,
  branchId: string
): Promise<Baseline> {
  const since = new Date(
    Date.parse(`${businessDate}T00:00:00Z`) - 60 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("reconciliation_reports")
    .select("business_date, txn_count, report")
    .eq("branch_id", branchId)
    .gte("business_date", since)
    .lt("business_date", businessDate)
    .order("business_date", { ascending: false });

  if (error) throw new Error(`baseline: ${error.message}`);

  const rows = (data ?? []) as {
    business_date: string;
    txn_count: number;
    report: BusinessDateReport;
  }[];

  const targetWeekday = new Date(`${businessDate}T00:00:00Z`).getUTCDay();

  const sameWeekdayCounts = rows
    .filter((r) => new Date(`${r.business_date}T00:00:00Z`).getUTCDay() === targetWeekday)
    .slice(0, 8)
    .map((r) => r.txn_count);

  const thirtyDaysAgo = new Date(
    Date.parse(`${businessDate}T00:00:00Z`) - 30 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);

  const recent = rows.filter((r) => r.business_date >= thirtyDaysAgo);

  const attendantDailyCounts: Record<string, number[]> = {};
  const cashRatios: number[] = [];

  for (const row of recent) {
    for (const attendant of row.report?.per_attendant ?? []) {
      (attendantDailyCounts[attendant.attendant_id] ??= []).push(attendant.txn_count);
    }
    if (typeof row.report?.cash_share_pct === "number" && row.report.revenue_total > 0) {
      cashRatios.push(row.report.cash_share_pct / 100);
    }
  }

  return { sameWeekdayCounts, attendantDailyCounts, cashRatios };
}

async function persist(
  supabase: SupabaseClient,
  report: BusinessDateReport
): Promise<void> {
  if (report.matches.length > 0) {
    // Match state lives here and nowhere else: momo_payments and transactions
    // are both append-only, so there is no column to flip on either side.
    await supabase.from("transaction_matches").upsert(
      report.matches.map((m) => ({
        transaction_id: m.transaction_id,
        momo_payment_id: m.momo_payment_id,
        branch_id: report.branch_id
      })),
      { onConflict: "transaction_id" }
    );
  }

  // Re-running a day overwrites its report; the transactions, cash counts and
  // vehicle events behind it are still append-only, so nothing about the
  // underlying record changes.
  const { error } = await supabase.from("reconciliation_reports").upsert(
    {
      branch_id: report.branch_id,
      business_date: report.business_date,
      severity: report.severity,
      revenue_total: report.revenue_total,
      txn_count: report.txn_count,
      vehicle_count: report.vehicles.vehicles_counted,
      report
    },
    { onConflict: "branch_id,business_date" }
  );

  if (error) throw new Error(`store report: ${error.message}`);
}

async function deliver(supabase: SupabaseClient, report: BusinessDateReport) {
  const { data: settings } = await supabase
    .from("branch_settings")
    .select("owner_email, owner_whatsapp")
    .eq("branch_id", report.branch_id)
    .single();

  const { data: attendants } = await supabase
    .from("attendants")
    .select("id, name")
    .eq("branch_id", report.branch_id);

  const attendantNames = Object.fromEntries(
    (attendants ?? []).map((a: { id: string; name: string }) => [a.id, a.name])
  );

  // Every single day, even when clean.
  const email = settings?.owner_email
    ? await sendEmail({
        to: settings.owner_email,
        subject: emailSubject(report),
        html: emailHtml(report, attendantNames)
      })
    : { ok: false, skipped: "owner_email not set" };

  const escalate = report.severity === "MEDIUM" || report.severity === "HIGH";
  const whatsapp =
    escalate && settings?.owner_whatsapp
      ? await sendWhatsApp({ to: settings.owner_whatsapp, body: whatsappAlert(report) })
      : {
          ok: true,
          skipped: escalate ? "owner_whatsapp not set" : "severity below MEDIUM"
        };

  return { email, whatsapp };
}

function toPosTransaction(row: Record<string, unknown>): PosTransaction {
  return {
    id: row.id as string,
    branch_id: row.branch_id as string,
    attendant_id: row.attendant_id as string,
    service_id: row.service_id as string,
    amount: Number(row.amount),
    payment_method: row.payment_method as PosTransaction["payment_method"],
    corrects_transaction_id: (row.corrects_transaction_id as string | null) ?? null,
    created_at_local: row.created_at_local as string,
    synced_at: row.synced_at as string,
    device_id: row.device_id as string
  };
}

function toMomoPayment(row: Record<string, unknown>): MomoPayment {
  return {
    id: row.id as string,
    external_ref: row.external_ref as string,
    amount: Number(row.amount),
    timestamp: row.timestamp as string
  };
}

function toCashCount(row: Record<string, unknown>): CashCountRow {
  return {
    id: row.id as string,
    counted_by: row.counted_by as string,
    actual: Number(row.actual),
    opening_float: Number(row.opening_float),
    notes: (row.notes as string | null) ?? null,
    created_at_local: row.created_at_local as string,
    supersedes_id: (row.supersedes_id as string | null) ?? null
  };
}

function toVehicleEvent(row: Record<string, unknown>): VehicleCountEvent {
  return {
    id: row.id as string,
    event_time: row.event_time as string,
    in_zone_count: Number(row.in_zone_count),
    device_id: row.device_id as string,
    source: (row.source as string) ?? "unknown"
  };
}
