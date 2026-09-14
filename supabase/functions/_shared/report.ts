import type { BusinessDateReport, Severity } from "./reconciliation.ts";

const SEVERITY_LABEL: Record<Severity, string> = {
  NONE: "All clear",
  LOW: "Worth a look",
  MEDIUM: "Needs attention",
  HIGH: "Needs attention today"
};

const SEVERITY_COLOR: Record<Severity, string> = {
  NONE: "#059669",
  LOW: "#0284c7",
  MEDIUM: "#d97706",
  HIGH: "#dc2626"
};

const ghs = (n: number) => `GHS ${n.toFixed(2)}`;

export function emailSubject(report: BusinessDateReport): string {
  const prefix = report.severity === "NONE" ? "" : `[${SEVERITY_LABEL[report.severity]}] `;
  return `${prefix}Wash report ${report.business_date} — ${ghs(report.revenue_total)}, ${
    report.txn_count
  } washes`;
}

/**
 * Sent every day, clean or not. A report that only arrives when something is
 * wrong teaches the reader that silence means fine — and silence is exactly
 * what a dead tablet or a dead counting unit produces.
 */
export function emailHtml(
  report: BusinessDateReport,
  attendantNames: Record<string, string>
): string {
  const flagRows =
    report.flags.length === 0
      ? `<p style="margin:0;color:#059669">Nothing flagged. ${
          report.momo_checked
            ? "Cash, MoMo, the POS and the vehicle count all agree."
            : "The POS, the drawer and the vehicle count all agree."
        }</p>`
      : report.flags
          .map(
            (f) => `
            <div style="border-left:3px solid ${SEVERITY_COLOR[f.severity]};padding:6px 12px;margin-bottom:8px;background:#f8fafc">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b">${f.kind.replace(/_/g, " ")}</div>
              <div style="color:#0f172a">${escapeHtml(f.message)}</div>
            </div>`
          )
          .join("");

  const attendantRows = report.per_attendant
    .map(
      (a) => `
      <tr>
        <td style="padding:6px 0">${escapeHtml(attendantNames[a.attendant_id] ?? a.attendant_id)}</td>
        <td style="padding:6px 0;text-align:right">${a.txn_count}</td>
        <td style="padding:6px 0;text-align:right">${ghs(a.revenue)}</td>
        <td style="padding:6px 0;text-align:right;color:#64748b">${ghs(a.cash_revenue)} / ${ghs(a.digital_revenue)}</td>
      </tr>`
    )
    .join("");

  const cashRow =
    report.cash_counted === null
      ? `<tr><td style="padding:6px 0">Cash counted</td><td style="padding:6px 0;text-align:right;color:#d97706">not recorded</td></tr>`
      : `<tr><td style="padding:6px 0">Cash counted vs expected</td><td style="padding:6px 0;text-align:right">${ghs(
          report.cash_counted
        )} vs ${ghs(report.expected_cash)} <strong>(${
          report.cash_variance! >= 0 ? "+" : ""
        }${report.cash_variance!.toFixed(2)})</strong></td></tr>`;

  const vehicleRow = !report.vehicles.checked
    ? `<tr><td style="padding:6px 0">Vehicles counted</td><td style="padding:6px 0;text-align:right;color:#64748b">${escapeHtml(
        report.vehicles.skipped_reason ?? "not checked"
      )}</td></tr>`
    : `<tr><td style="padding:6px 0">Vehicles counted vs washes logged</td><td style="padding:6px 0;text-align:right">${
        report.vehicles.vehicles_counted
      } vs ${report.vehicles.transactions_counted} <strong>(${
        report.vehicles.difference >= 0 ? "+" : ""
      }${report.vehicles.difference})</strong></td></tr>`;

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#0f172a">
    <div style="background:${SEVERITY_COLOR[report.severity]};color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:13px;opacity:.9">${report.business_date}</div>
      <div style="font-size:22px;font-weight:600">${SEVERITY_LABEL[report.severity]}</div>
    </div>

    <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 12px 12px">
      <h3 style="margin:0 0 8px">The day</h3>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:6px 0">Revenue</td><td style="padding:6px 0;text-align:right"><strong>${ghs(report.revenue_total)}</strong></td></tr>
        <tr><td style="padding:6px 0">Washes</td><td style="padding:6px 0;text-align:right">${report.txn_count}${
          report.expected_txn_count !== null
            ? ` <span style="color:#64748b">(usual ${report.expected_txn_count})</span>`
            : ""
        }</td></tr>
        <tr><td style="padding:6px 0">Cash / digital</td><td style="padding:6px 0;text-align:right">${ghs(report.cash_total)} / ${ghs(
          report.digital_total
        )} <span style="color:#64748b">(${report.cash_share_pct.toFixed(0)}% cash)</span></td></tr>
        ${cashRow}
        ${
          report.momo_checked
            ? `<tr><td style="padding:6px 0">Digital logged vs MoMo received</td><td style="padding:6px 0;text-align:right">${ghs(
                report.digital_total
              )} vs ${ghs(report.momo_actual_total)} <strong>(${
                report.digital_variance >= 0 ? "+" : ""
              }${report.digital_variance.toFixed(2)})</strong></td></tr>`
            : `<tr><td style="padding:6px 0">Mobile money</td><td style="padding:6px 0;text-align:right;color:#64748b">cash only — not checked</td></tr>`
        }
        ${vehicleRow}
      </table>

      <h3 style="margin:20px 0 8px">Flags</h3>
      ${flagRows}

      <h3 style="margin:20px 0 8px">By attendant</h3>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr style="color:#64748b;font-size:13px;text-align:left">
          <th style="padding:6px 0;font-weight:500">Attendant</th>
          <th style="padding:6px 0;font-weight:500;text-align:right">Washes</th>
          <th style="padding:6px 0;font-weight:500;text-align:right">Revenue</th>
          <th style="padding:6px 0;font-weight:500;text-align:right">Cash / digital</th>
        </tr>
        ${attendantRows || `<tr><td colspan="4" style="padding:6px 0;color:#64748b">No washes logged.</td></tr>`}
      </table>

      ${
        report.corrections.length > 0
          ? `<h3 style="margin:20px 0 8px">Corrections</h3><p style="margin:0;color:#475569">${report.corrections.length} entr${
              report.corrections.length === 1 ? "y was" : "ies were"
            } voided today. Originals remain in the record.</p>`
          : ""
      }

      ${
        !report.baseline_available
          ? `<p style="margin:20px 0 0;color:#64748b;font-size:13px">Volume checks are still building their baseline — they need a few weeks of history before they mean anything.</p>`
          : ""
      }

      <p style="margin:20px 0 0;color:#64748b;font-size:13px">
        Flags are prompts to ask a question, not accusations. Honest miscounts are more
        common than anything else, and the vehicle counter itself miscounts sometimes —
        a van turning around in the yard looks exactly like a customer.
      </p>
    </div>
  </div>`;
}

/** Short enough to read on a phone lock screen. */
export function whatsappAlert(report: BusinessDateReport): string {
  const lines = [
    `${SEVERITY_LABEL[report.severity]} — ${report.business_date}`,
    `${ghs(report.revenue_total)} across ${report.txn_count} washes.`,
    ""
  ];

  for (const f of report.flags.slice(0, 4)) {
    lines.push(`• ${f.message}`);
  }
  if (report.flags.length > 4) {
    lines.push(`• …and ${report.flags.length - 4} more`);
  }

  lines.push("", "Full report is in your email.");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
