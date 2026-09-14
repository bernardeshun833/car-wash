/**
 * MTN MoMo Collection API client.
 *
 * This deployment uses the car wash's OWN MoMo merchant account. It is a
 * separate business from the barbershop: separate registration, separate KYC,
 * separate subscription keys. Pointing this at the barbershop's account would
 * make both reconciliations wrong, and nothing in the code would notice.
 *
 * Token acquisition below is the documented sandbox/production flow. The
 * statement endpoint is deliberately configurable: which endpoint returns
 * "payments received on date X" depends on the MoMo product the business is
 * approved for, and that approval can take weeks. Until it lands, point
 * MOMO_BASE_URL at the sandbox and the rest of the pipeline — matching,
 * variance, reporting — runs end to end on sandbox data.
 *
 * Env:
 *   MOMO_BASE_URL            https://sandbox.momodeveloper.mtn.com
 *   MOMO_SUBSCRIPTION_KEY    Ocp-Apim-Subscription-Key from the developer portal
 *   MOMO_API_USER            API user UUID
 *   MOMO_API_KEY             API key generated for that user
 *   MOMO_TARGET_ENVIRONMENT  "sandbox", or the production environment name
 *   MOMO_STATEMENT_PATH      optional override for the statement endpoint
 */

export interface MomoTransaction {
  external_ref: string;
  amount: number;
  timestamp: string;
}

interface MomoConfig {
  baseUrl: string;
  subscriptionKey: string;
  apiUser: string;
  apiKey: string;
  targetEnvironment: string;
  statementPath: string;
}

export function readMomoConfig(): MomoConfig | null {
  const baseUrl = Deno.env.get("MOMO_BASE_URL");
  const subscriptionKey = Deno.env.get("MOMO_SUBSCRIPTION_KEY");
  const apiUser = Deno.env.get("MOMO_API_USER");
  const apiKey = Deno.env.get("MOMO_API_KEY");

  if (!baseUrl || !subscriptionKey || !apiUser || !apiKey) return null;

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    subscriptionKey,
    apiUser,
    apiKey,
    targetEnvironment: Deno.env.get("MOMO_TARGET_ENVIRONMENT") ?? "sandbox",
    statementPath:
      Deno.env.get("MOMO_STATEMENT_PATH") ?? "/collection/v1_0/account/statement"
  };
}

async function getAccessToken(config: MomoConfig): Promise<string> {
  const response = await fetch(`${config.baseUrl}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${config.apiUser}:${config.apiKey}`)}`,
      "Ocp-Apim-Subscription-Key": config.subscriptionKey
    }
  });

  if (!response.ok) {
    throw new Error(
      `MoMo token request failed: ${response.status} ${await response.text()}`
    );
  }

  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

/**
 * Payments received between two instants. Returns [] rather than throwing on
 * an empty window; callers must treat "no MoMo data" as a fact to reconcile
 * against, not as a reason to skip the night's run.
 */
export async function fetchMomoPayments(
  config: MomoConfig,
  fromIso: string,
  toIso: string
): Promise<MomoTransaction[]> {
  const token = await getAccessToken(config);

  const url = new URL(`${config.baseUrl}${config.statementPath}`);
  url.searchParams.set("startDate", fromIso);
  url.searchParams.set("endDate", toIso);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Target-Environment": config.targetEnvironment,
      "Ocp-Apim-Subscription-Key": config.subscriptionKey
    }
  });

  if (!response.ok) {
    throw new Error(
      `MoMo statement request failed: ${response.status} ${await response.text()}`
    );
  }

  const body = await response.json();
  return normaliseStatement(body);
}

/**
 * MoMo's statement shapes vary by product and version, so this is tolerant by
 * design: anything with a reference, an amount and a timestamp is usable, and
 * a row missing one of those is skipped rather than silently coerced into a
 * zero-value payment that would distort the variance.
 */
export function normaliseStatement(body: unknown): MomoTransaction[] {
  const rows = extractRows(body);

  return rows.flatMap((row) => {
    const ref =
      row.externalId ?? row.financialTransactionId ?? row.referenceId ?? row.transactionId;
    const rawAmount = row.amount;
    const timestamp = row.timestamp ?? row.createdAt ?? row.transactionDate;

    if (ref === undefined || rawAmount === undefined || timestamp === undefined) {
      return [];
    }

    const amount = typeof rawAmount === "string" ? Number.parseFloat(rawAmount) : rawAmount;
    if (!Number.isFinite(amount)) return [];

    return [
      {
        external_ref: String(ref),
        amount: amount as number,
        timestamp: new Date(timestamp as string).toISOString()
      }
    ];
  });
}

type StatementRow = Record<string, unknown> & {
  externalId?: unknown;
  financialTransactionId?: unknown;
  referenceId?: unknown;
  transactionId?: unknown;
  amount?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  transactionDate?: unknown;
};

function extractRows(body: unknown): StatementRow[] {
  if (Array.isArray(body)) return body as StatementRow[];
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["transactions", "data", "items", "results"]) {
      if (Array.isArray(record[key])) return record[key] as StatementRow[];
    }
  }
  return [];
}
