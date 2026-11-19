/**
 * Stub legacy billing API for "Harbor Light Energy" (fictional utility).
 *
 * This stands in for the customer's EXISTING system that stays outside Vercel.
 * Deploy it as its own Vercel project so the agent app crosses a real network
 * boundary to reach it.
 *
 * Routes (all require `Authorization: Bearer <BILLING_API_TOKEN>` except /health):
 *   GET  /health
 *   GET  /accounts/:id
 *   GET  /accounts/:id/outages
 *   POST /accounts/:id/credits     (requires `Idempotency-Key` header)
 *
 * DELIBERATE DECISIONS (say these in your own words in the interview):
 *  - Data is seeded in memory: this is a stub, not a database. Serverless
 *    instances don't share memory, so the credit ledger is per-instance and can
 *    reset on cold start. Idempotency is therefore best-effort here. In the
 *    real system it would be enforced by the billing database (unique key).
 *  - The API enforces its own hard cap on a credit. Defense in depth: even if
 *    the agent or workflow has a bug, the system of record refuses bad amounts.
 *  - Auth is a static bearer token. Production would use OIDC-issued, short-lived
 *    credentials over private networking (see your write-up).
 */

type Account = {
  id: string;
  name: string;
  plan: "residential" | "small_business";
  balanceCents: number;
  serviceAddress: string;
  priorCreditsLast12Months: number;
};

type Outage = {
  id: string;
  startedAt: string; // ISO timestamp
  durationMinutes: number;
  cause: "storm" | "equipment_failure" | "planned_maintenance";
};

type LedgerEntry = {
  entryId: string;
  accountId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
  createdAt: string;
};

// ---- Seed data: five cases that exercise different agent/policy paths -------

const ACCOUNTS: Record<string, Account> = {
  // Clear-cut: long unplanned outage, no history -> credit expected.
  "ACCT-1001": {
    id: "ACCT-1001",
    name: "Maria Okafor",
    plan: "residential",
    balanceCents: 14250,
    serviceAddress: "12 Cedar Lane, Duluth, MN",
    priorCreditsLast12Months: 0,
  },
  // Borderline: outage right around the eligibility threshold.
  "ACCT-1002": {
    id: "ACCT-1002",
    name: "Daniel Whitfield",
    plan: "residential",
    balanceCents: 9800,
    serviceAddress: "48 Harbor St, Duluth, MN",
    priorCreditsLast12Months: 1,
  },
  // Repeat claimant: already received several credits this year.
  "ACCT-1003": {
    id: "ACCT-1003",
    name: "Priya Raman",
    plan: "small_business",
    balanceCents: 40210,
    serviceAddress: "300 Lakeshore Ave, Duluth, MN",
    priorCreditsLast12Months: 4,
  },
  // Not eligible: only outage was planned maintenance.
  "ACCT-1004": {
    id: "ACCT-1004",
    name: "Tom Lindqvist",
    plan: "residential",
    balanceCents: 6720,
    serviceAddress: "7 Birch Rd, Hermantown, MN",
    priorCreditsLast12Months: 0,
  },
  // ACCT-9999 intentionally does not exist -> tests the unknown-account path.
  "ACCT-1005": {
    id: "ACCT-1005",
    name: "Grace Holloway",
    plan: "residential",
    balanceCents: 21500,
    serviceAddress: "91 Pine Hill Dr, Proctor, MN",
    priorCreditsLast12Months: 0,
  },
};

const OUTAGES: Record<string, Outage[]> = {
  "ACCT-1001": [
    { id: "OUT-501", startedAt: "2026-11-02T03:15:00Z", durationMinutes: 540, cause: "storm" },
  ],
  "ACCT-1002": [
    { id: "OUT-502", startedAt: "2026-11-05T18:00:00Z", durationMinutes: 240, cause: "equipment_failure" },
  ],
  "ACCT-1003": [
    { id: "OUT-503", startedAt: "2026-10-28T09:30:00Z", durationMinutes: 400, cause: "equipment_failure" },
    { id: "OUT-504", startedAt: "2026-11-09T21:10:00Z", durationMinutes: 300, cause: "storm" },
  ],
  "ACCT-1004": [
    { id: "OUT-505", startedAt: "2026-11-07T08:00:00Z", durationMinutes: 480, cause: "planned_maintenance" },
  ],
  "ACCT-1005": [],
};

// Hard ceiling enforced by the billing system itself ($150.00).
const MAX_CREDIT_CENTS = 15000;

// In-memory ledger + idempotency index (per warm instance; see note above).
const ledger: LedgerEntry[] = [];
const byIdempotencyKey = new Map<string, LedgerEntry>();

// ---- Helpers -----------------------------------------------------------------

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Constant-time-ish string compare so token checks don't leak length/prefix timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.BILLING_API_TOKEN;
  // Fail closed: if the token isn't configured, nobody gets in.
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match ? safeEqual(match[1], expected) : false;
}

// ---- Router ------------------------------------------------------------------

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // DELIBERATE DECISION: on Vercel, vercel.json rewrites every request to this one
  // function and passes the original path as ?path=... (Vercel's docs show rewrite
  // parameters arriving as query params). Locally/tests there is no rewrite, so we
  // fall back to the real pathname.
  const rawPath = url.searchParams.get("path") ?? url.pathname;
  const path = rawPath.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") {
    return json({ status: "ok", service: "harbor-light-billing-stub" });
  }

  if (!isAuthorized(request)) {
    return error(401, "unauthorized", "Missing or invalid bearer token.");
  }

  // GET /accounts/:id
  let m = /^\/accounts\/([^/]+)$/.exec(path);
  if (m && method === "GET") {
    const account = ACCOUNTS[decodeURIComponent(m[1])];
    if (!account) return error(404, "account_not_found", "No such account.");
    return json(account);
  }

  // GET /accounts/:id/outages
  m = /^\/accounts\/([^/]+)\/outages$/.exec(path);
  if (m && method === "GET") {
    const id = decodeURIComponent(m[1]);
    if (!ACCOUNTS[id]) return error(404, "account_not_found", "No such account.");
    return json({ accountId: id, outages: OUTAGES[id] ?? [] });
  }

  // POST /accounts/:id/credits
  m = /^\/accounts\/([^/]+)\/credits$/.exec(path);
  if (m && method === "POST") {
    const id = decodeURIComponent(m[1]);
    const account = ACCOUNTS[id];
    if (!account) return error(404, "account_not_found", "No such account.");

    const key = request.headers.get("idempotency-key");
    if (!key) {
      return error(400, "idempotency_key_required", "Send an Idempotency-Key header.");
    }

    // Replay: same key returns the original result, never a second credit.
    const existing = byIdempotencyKey.get(key);
    if (existing) {
      if (existing.accountId !== id) {
        return error(409, "idempotency_key_reused", "Key was used for a different account.");
      }
      return json(existing, 200, { "idempotent-replay": "true" });
    }

    let body: { amountCents?: unknown; reason?: unknown };
    try {
      body = await request.json();
    } catch {
      return error(400, "invalid_json", "Body must be valid JSON.");
    }

    const { amountCents, reason } = body;
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      return error(422, "invalid_amount", "amountCents must be a positive integer.");
    }
    if (amountCents > MAX_CREDIT_CENTS) {
      return error(
        422,
        "amount_exceeds_cap",
        `Credits are capped at ${MAX_CREDIT_CENTS} cents by the billing system.`,
      );
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return error(422, "reason_required", "A non-empty reason is required.");
    }

    const entry: LedgerEntry = {
      entryId: `LED-${(ledger.length + 1).toString().padStart(5, "0")}`,
      accountId: id,
      amountCents,
      reason: reason.trim().slice(0, 500),
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
    };
    ledger.push(entry);
    byIdempotencyKey.set(key, entry);
    account.balanceCents -= amountCents;
    account.priorCreditsLast12Months += 1;

    return json(entry, 201);
  }

  return error(404, "not_found", "Unknown route.");
}

// Vercel Functions entry points (Web-standard Request/Response).
export const GET = handle;
export const POST = handle;
