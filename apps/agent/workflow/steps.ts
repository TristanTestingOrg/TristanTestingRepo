/**
 * Durable steps: every call that touches the billing system lives here.
 *
 * A function marked "use step" is a durable unit of work: its result is persisted,
 * it is retried automatically on failure, and it is not re-run if the workflow is
 * replayed after a crash or redeploy.
 *
 * DELIBERATE DECISIONS:
 *  - The model only ever passes an accountId. It never passes outages or amounts,
 *    so it cannot tamper with what the policy sees or inflate a credit. Each step
 *    re-fetches the case from the billing system itself.
 *  - applyCreditStep recomputes the amount from the policy and ignores anything
 *    else. Even a model that "asks" for $500 gets exactly what the policy says.
 *  - Failure handling: expected business outcomes (unknown account, nothing
 *    eligible) are RETURNED as data so the model can explain them. A 5xx or a
 *    network failure throws a plain Error, which the step retries. A 4xx from the
 *    billing system (e.g. a bad token) throws FatalError, since retrying a
 *    rejected request cannot help.
 *  - Relative imports with .ts extensions keep these steps runnable by plain node
 *    in tests (allowImportingTsExtensions is enabled in tsconfig).
 */
import { FatalError } from "workflow";
import { applyCredit, BillingError, getAccount, getOutages } from "../lib/billing.ts";
import { calculateCredit, idempotencyKeyFor } from "../lib/policy.ts";

type AccountInput = { accountId: string };

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingError) throw new FatalError(`${err.code}: ${err.message}`);
    throw err; // timeouts and 5xx: let the step retry
  }
}

async function loadCase(accountId: string) {
  const account = await getAccount(accountId);
  if (!account) return null;
  const outages = await getOutages(accountId);
  return { account, outages };
}

export async function lookupAccountStep({ accountId }: AccountInput) {
  "use step";
  return guard(async () => {
    const account = await getAccount(accountId);
    if (!account) return { found: false as const, accountId };
    return {
      found: true as const,
      account: {
        id: account.id,
        name: account.name,
        plan: account.plan,
        priorCreditsLast12Months: account.priorCreditsLast12Months,
      },
    };
  });
}

export async function getOutageHistoryStep({ accountId }: AccountInput) {
  "use step";
  return guard(async () => {
    const account = await getAccount(accountId);
    if (!account) return { found: false as const, accountId };
    return { found: true as const, accountId, outages: await getOutages(accountId) };
  });
}

export async function proposeCreditStep({ accountId }: AccountInput) {
  "use step";
  return guard(async () => {
    const c = await loadCase(accountId);
    if (!c) return { found: false as const, accountId };
    const decision = calculateCredit(c.account, c.outages);
    return { found: true as const, accountId, customerName: c.account.name, decision };
  });
}

export async function applyCreditStep({ accountId }: AccountInput) {
  "use step";
  return guard(async () => {
    const c = await loadCase(accountId);
    if (!c) return { applied: false as const, reason: "account_not_found" };

    // Recompute from scratch: the amount comes from the policy, never from the model.
    const decision = calculateCredit(c.account, c.outages);
    if (decision.outcome !== "propose") {
      return { applied: false as const, reason: `policy outcome is ${decision.outcome}` };
    }

    // Same account + same outages => same key, so a retried step or a repeat run
    // for the same case cannot credit twice.
    const key = idempotencyKeyFor(accountId, decision.eligibleOutageIds);
    const reason = `Outage credit for ${decision.eligibleOutageIds.join(", ")} (approved)`;
    const entry = await applyCredit(accountId, decision.amountCents, reason, key);
    return { applied: true as const, entry };
  });
}
