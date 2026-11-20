/**
 * The credit agent as a durable workflow.
 *
 * Flow: look up account -> read outages -> proposeCredit (deterministic policy) ->
 * if the policy says "propose", call applyCredit, which PAUSES until a human
 * approves. Only then does the step run and write to the billing system.
 *
 * DELIBERATE DECISIONS:
 *  - The agent is defined inside the "use workflow" function, and every tool's
 *    execute is a "use step" function, so each tool call is a durable, retried,
 *    persisted step.
 *  - applyCredit has needsApproval: true. The human gate is enforced by the
 *    platform, not by a sentence in the prompt.
 *  - The model can call applyCredit but cannot choose the amount: the tool takes
 *    only an accountId and the step recomputes the amount (see steps.ts).
 *  - providerOptions.gateway.models is the cross-model fallback list.
 *  - Approvals are signed with WORKFLOW_TOOL_APPROVAL_SECRET (only the variable
 *    NAME is passed here, so the secret never enters workflow history).
 */
import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { tool, type ModelMessage } from "ai";
import { getWritable } from "workflow";
import { z } from "zod";
import { FALLBACK_MODELS, PRIMARY_MODEL } from "../lib/models.ts";
import {
  applyCreditStep,
  getOutageHistoryStep,
  lookupAccountStep,
  proposeCreditStep,
} from "./steps.ts";

const INSTRUCTIONS = `You are a credit assistant for Tristan Electric customer-service reps.

When a rep gives you an account ID (like ACCT-1001):
1. Call lookupAccount, then getOutageHistory.
2. Call proposeCredit. Its result is the ONLY source of truth for eligibility and amounts.
3. Explain the decision plainly to the rep, using the reasons from proposeCredit.
4. If, and only if, the outcome is "propose", call applyCredit for that account. It will
   wait for a human approver, so tell the rep the credit is awaiting approval.
5. If the outcome is "decline" or "manual_review", explain why and do NOT call applyCredit.

Rules:
- Never state a dollar amount that did not come from proposeCredit. Amounts are in cents; show dollars.
- Never invent account details. If an account is not found, say so.
- If the rep has not given an account ID, ask for one.`;

const accountInput = z.object({
  accountId: z.string().describe("Account ID such as ACCT-1001"),
});

export async function creditCase(messages: ModelMessage[]) {
  "use workflow";

  const agent = new WorkflowAgent({
    model: PRIMARY_MODEL,
    instructions: INSTRUCTIONS,
    providerOptions: { gateway: { models: FALLBACK_MODELS } },
    experimental_toolApprovalSecret: { environmentVariable: "WORKFLOW_TOOL_APPROVAL_SECRET" },
    tools: {
      lookupAccount: tool({
        description: "Look up a customer account by ID.",
        inputSchema: accountInput,
        execute: lookupAccountStep,
      }),
      getOutageHistory: tool({
        description: "Get the outage history for an account.",
        inputSchema: accountInput,
        execute: getOutageHistoryStep,
      }),
      proposeCredit: tool({
        description:
          "Run the credit policy for an account. Returns propose, manual_review or decline, with the amount in cents and the reasons.",
        inputSchema: accountInput,
        execute: proposeCreditStep,
      }),
      applyCredit: tool({
        description:
          "Apply the policy-approved credit to the account. Requires human approval. Only call this after proposeCredit returned outcome 'propose'.",
        inputSchema: accountInput,
        needsApproval: true,
        execute: applyCreditStep,
      }),
    },
  });

  const result = await agent.stream({
    messages,
    writable: getWritable<ModelCallStreamPart>(),
  });

  return { messages: result.messages };
}
