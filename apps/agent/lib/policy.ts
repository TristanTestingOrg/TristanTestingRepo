/**
 * Credit policy for Tristan Electric outage credits.
 *
 * DELIBERATE DECISION: this is plain deterministic code, NOT model output. The
 * model's job is to orchestrate and explain; it never chooses or inflates an
 * amount. Money is always integer cents (no floating point).
 *
 * Rules (change the constants below, and the tests will tell you what moved):
 *  - Only unplanned outages qualify (storm, equipment_failure).
 *  - An outage must last at least MIN_OUTAGE_MINUTES (inclusive) to qualify.
 *  - Credit is RATE_CENTS_PER_HOUR per FULL hour of each qualifying outage.
 *  - The total for one case is capped by plan.
 *  - Accounts with REPEAT_CLAIMANT_THRESHOLD or more credits in the last 12 months
 *    go to manual review instead of getting an automatic proposal.
 *
 * DELIBERATE OMISSION: there is no "outage must be recent" window. The seeded demo
 * outages are static, so a recency rule would make the demo silently stop working
 * as the dates age. A production policy would have one, and would also check that
 * an outage hasn't already been credited (the stub ledger has no outage linkage).
 */

export type Plan = "residential" | "small_business";
export type OutageCause = "storm" | "equipment_failure" | "planned_maintenance";

export type PolicyAccount = {
  id: string;
  plan: Plan;
  priorCreditsLast12Months: number;
};

export type PolicyOutage = {
  id: string;
  durationMinutes: number;
  cause: OutageCause;
};

export type CreditLine = {
  outageId: string;
  fullHours: number;
  creditCents: number;
};

export type CreditDecision =
  | {
      outcome: "propose";
      amountCents: number;
      lines: CreditLine[];
      capApplied: boolean;
      eligibleOutageIds: string[];
      reasons: string[];
    }
  | { outcome: "manual_review"; eligibleOutageIds: string[]; reasons: string[] }
  | { outcome: "decline"; reasons: string[] };

export const ELIGIBLE_CAUSES: ReadonlySet<OutageCause> = new Set(["storm", "equipment_failure"]);
export const MIN_OUTAGE_MINUTES = 240;
export const RATE_CENTS_PER_HOUR = 500;
export const CAP_CENTS: Record<Plan, number> = {
  residential: 5000, // $50
  small_business: 15000, // $150 (matches the billing system's own hard ceiling)
};
export const REPEAT_CLAIMANT_THRESHOLD = 3;

export function calculateCredit(account: PolicyAccount, outages: PolicyOutage[]): CreditDecision {
  const reasons: string[] = [];
  const lines: CreditLine[] = [];

  for (const o of outages) {
    if (!ELIGIBLE_CAUSES.has(o.cause)) {
      reasons.push(`${o.id}: ${o.cause.replace("_", " ")} outages do not qualify.`);
    } else if (o.durationMinutes < MIN_OUTAGE_MINUTES) {
      reasons.push(
        `${o.id}: ${o.durationMinutes} minutes is under the ${MIN_OUTAGE_MINUTES}-minute minimum.`,
      );
    } else {
      const fullHours = Math.floor(o.durationMinutes / 60);
      lines.push({ outageId: o.id, fullHours, creditCents: fullHours * RATE_CENTS_PER_HOUR });
      reasons.push(`${o.id}: ${o.durationMinutes} minutes qualifies (${fullHours} full hours).`);
    }
  }

  if (outages.length === 0) {
    return { outcome: "decline", reasons: ["No outages on record for this account."] };
  }
  if (lines.length === 0) {
    return { outcome: "decline", reasons };
  }

  const eligibleOutageIds = lines.map((l) => l.outageId);

  if (account.priorCreditsLast12Months >= REPEAT_CLAIMANT_THRESHOLD) {
    return {
      outcome: "manual_review",
      eligibleOutageIds,
      reasons: [
        ...reasons,
        `${account.priorCreditsLast12Months} credits in the last 12 months ` +
          `(threshold ${REPEAT_CLAIMANT_THRESHOLD}): needs manual review, no automatic proposal.`,
      ],
    };
  }

  const uncapped = lines.reduce((sum, l) => sum + l.creditCents, 0);
  const cap = CAP_CENTS[account.plan];
  const amountCents = Math.min(uncapped, cap);
  const capApplied = uncapped > cap;
  if (capApplied) {
    reasons.push(`Total ${uncapped} cents exceeds the ${account.plan} cap; reduced to ${cap} cents.`);
  }

  return { outcome: "propose", amountCents, lines, capApplied, eligibleOutageIds, reasons };
}

/**
 * Deterministic idempotency key for the credit write. The same account and the
 * same set of outages always produce the same key, so a retried workflow step (or
 * a second run for the same case) can't credit twice. Sorting makes order irrelevant.
 */
export function idempotencyKeyFor(accountId: string, outageIds: string[]): string {
  return `credit:${accountId}:${[...outageIds].sort().join("+")}`;
}
