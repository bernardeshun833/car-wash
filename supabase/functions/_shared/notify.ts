/**
 * Outbound notifications. Both channels fail soft: a report that cannot be
 * emailed must never prevent the reconciliation from being stored, or an
 * outage at the mail provider would quietly erase a day of history.
 *
 * Credentials are this deployment's own. The car wash has its own Resend and
 * Twilio configuration; nothing here is shared with the barbershop.
 */

export interface NotifyResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<NotifyResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REPORT_FROM_EMAIL");

  if (!apiKey || !from) {
    return { ok: false, skipped: "RESEND_API_KEY or REPORT_FROM_EMAIL not set" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html
      })
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Resend responded ${response.status}: ${await response.text()}`
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * WhatsApp via Twilio. Only fires at MEDIUM+ — an alert that arrives every
 * night is an alert nobody reads.
 */
export async function sendWhatsApp(params: {
  to: string;
  body: string;
}): Promise<NotifyResult> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM");

  if (!sid || !token || !from) {
    return { ok: false, skipped: "Twilio credentials not set" };
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          From: `whatsapp:${from}`,
          To: `whatsapp:${params.to}`,
          Body: params.body
        })
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        error: `Twilio responded ${response.status}: ${await response.text()}`
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
