// Policy tests. Run: node --experimental-strip-types lib/policy.test.ts
// The first block mirrors the five seeded stub accounts, so the demo's expected
// outcomes are pinned by tests and not by memory.
import assert from "node:assert/strict";
import {
  calculateCredit,
  idempotencyKeyFor,
  type PolicyAccount,
  type PolicyOutage,
} from "./policy.ts";

const acct = (over: Partial<PolicyAccount> = {}): PolicyAccount => ({
  id: "ACCT-T",
  plan: "residential",
  priorCreditsLast12Months: 0,
  ...over,
});
const out = (id: string, durationMinutes: number, cause: PolicyOutage["cause"] = "storm"): PolicyOutage => ({
  id,
  durationMinutes,
  cause,
});

// --- Seeded demo accounts -------------------------------------------------

// ACCT-1001: 540 min storm, no history -> 9 full hours -> $45
{
  const d = calculateCredit(acct({ id: "ACCT-1001" }), [out("OUT-501", 540)]);
  assert.equal(d.outcome, "propose");
  if (d.outcome === "propose") {
    assert.equal(d.amountCents, 4500);
    assert.equal(d.capApplied, false);
  }
}
// ACCT-1002: 240 min equipment failure, exactly at the threshold -> qualifies, $20
{
  const d = calculateCredit(acct({ id: "ACCT-1002", priorCreditsLast12Months: 1 }), [
    out("OUT-502", 240, "equipment_failure"),
  ]);
  assert.equal(d.outcome, "propose");
  if (d.outcome === "propose") assert.equal(d.amountCents, 2000);
}
// ACCT-1003: small business, 4 prior credits, two eligible outages -> manual review
{
  const d = calculateCredit(
    acct({ id: "ACCT-1003", plan: "small_business", priorCreditsLast12Months: 4 }),
    [out("OUT-503", 400, "equipment_failure"), out("OUT-504", 300)],
  );
  assert.equal(d.outcome, "manual_review");
  if (d.outcome === "manual_review") assert.deepEqual(d.eligibleOutageIds, ["OUT-503", "OUT-504"]);
}
// ACCT-1004: planned maintenance only -> decline
{
  const d = calculateCredit(acct({ id: "ACCT-1004" }), [out("OUT-505", 480, "planned_maintenance")]);
  assert.equal(d.outcome, "decline");
}
// ACCT-1005: no outages -> decline
{
  const d = calculateCredit(acct({ id: "ACCT-1005" }), []);
  assert.equal(d.outcome, "decline");
}

// --- Boundaries and caps --------------------------------------------------

// 239 minutes is one minute short of the minimum
assert.equal(calculateCredit(acct(), [out("O1", 239)]).outcome, "decline");

// Partial hours are not paid: 299 min -> 4 full hours -> $20
{
  const d = calculateCredit(acct(), [out("O1", 299)]);
  assert.equal(d.outcome === "propose" && d.amountCents, 2000);
}

// Residential cap: 20 hours would be $100, capped at $50
{
  const d = calculateCredit(acct(), [out("O1", 1200)]);
  assert.equal(d.outcome, "propose");
  if (d.outcome === "propose") {
    assert.equal(d.amountCents, 5000);
    assert.equal(d.capApplied, true);
  }
}

// Business cap is higher: same 20 hours -> $100, not capped
{
  const d = calculateCredit(acct({ plan: "small_business" }), [out("O1", 1200)]);
  assert.equal(d.outcome === "propose" && d.amountCents, 10000);
}

// Mixed outages: only qualifying ones are paid
{
  const d = calculateCredit(acct(), [
    out("A", 300), // 5h -> $25
    out("B", 600, "planned_maintenance"), // excluded
    out("C", 100), // too short
  ]);
  assert.equal(d.outcome, "propose");
  if (d.outcome === "propose") {
    assert.equal(d.amountCents, 2500);
    assert.deepEqual(d.eligibleOutageIds, ["A"]);
  }
}

// Repeat claimant threshold: 2 prior is fine, 3 goes to review
assert.equal(calculateCredit(acct({ priorCreditsLast12Months: 2 }), [out("O1", 300)]).outcome, "propose");
assert.equal(calculateCredit(acct({ priorCreditsLast12Months: 3 }), [out("O1", 300)]).outcome, "manual_review");

// A repeat claimant with NOTHING eligible is declined, not escalated
assert.equal(
  calculateCredit(acct({ priorCreditsLast12Months: 9 }), [out("O1", 60)]).outcome,
  "decline",
);

// --- Idempotency key ------------------------------------------------------

assert.equal(
  idempotencyKeyFor("ACCT-1001", ["OUT-2", "OUT-1"]),
  idempotencyKeyFor("ACCT-1001", ["OUT-1", "OUT-2"]),
);
assert.notEqual(idempotencyKeyFor("ACCT-1001", ["OUT-1"]), idempotencyKeyFor("ACCT-1002", ["OUT-1"]));

console.log("all policy checks passed");
