/**
 * Client for the Tristan Electric billing system (the stub, in this demo).
 *
 * This file is the BOUNDARY: everything that crosses from Vercel to the customer's
 * existing world goes through here. Server-side only: the token must never reach
 * the browser, so don't import this from a client component.
 *
 * Env vars: BILLING_API_URL (e.g. https://tristantestingrepo-billing-stub.vercel.app)
 *           BILLING_API_TOKEN
 *
 * DELIBERATE DECISIONS:
 *  - Every call has a timeout, so a hung billing system can't hang the run forever.
 *  - 404 on account lookup returns null (an expected outcome, not an error).
 *  - 5xx / network failures throw a plain Error so a durable step can retry them.
 *    4xx responses throw BillingError with the billing system's own code, which
 *    retrying will not fix.
 *  - In production, the static bearer token would be replaced by short-lived
 *    OIDC-issued credentials over private networking.
 */

import type { OutageCause, Plan } from "./policy.ts";

export type Account = {
  id: string;
  name: string;
  plan: Plan;
  balanceCents: number;
  serviceAddress: string;
  priorCreditsLast12Months: number;
};

export type Outage = {
  id: string;
  startedAt: string;
  durationMinutes: number;
  cause: OutageCause;
};

export type LedgerEntry = {
  entryId: string;
  accountId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
  createdAt: string;
};

export class BillingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 10_000;

function config() {
  const base = process.env.BILLING_API_URL;
  const token = process.env.BILLING_API_TOKEN;
  if (!base || !token) {
    throw new Error("BILLING_API_URL and BILLING_API_TOKEN must be set.");
  }
  return { base: base.replace(/\/+$/, ""), token };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { base, token } = config();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 500) {
    throw new Error(`Billing system error ${res.status} on ${path}`); // retryable
  }
  return res;
}

async function failFrom(res: Response): Promise<never> {
  let code = "unknown";
  let message = `Billing system returned ${res.status}.`;
  try {
    const body = await res.json();
    code = body?.error?.code ?? code;
    message = body?.error?.message ?? message;
  } catch {
    /* non-JSON error body: keep defaults */
  }
  throw new BillingError(res.status, code, message);
}

export async function getAccount(accountId: string): Promise<Account | null> {
  const res = await call(`/accounts/${encodeURIComponent(accountId)}`);
  if (res.status === 404) return null;
  if (!res.ok) return failFrom(res);
  return res.json();
}

export async function getOutages(accountId: string): Promise<Outage[]> {
  const res = await call(`/accounts/${encodeURIComponent(accountId)}/outages`);
  if (!res.ok) return failFrom(res);
  const body = await res.json();
  return body.outages;
}

export async function applyCredit(
  accountId: string,
  amountCents: number,
  reason: string,
  idempotencyKey: string,
): Promise<LedgerEntry> {
  const res = await call(`/accounts/${encodeURIComponent(accountId)}/credits`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ amountCents, reason }),
  });
  if (!res.ok) return failFrom(res);
  return res.json();
}
