"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import {
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { useMemo, useState } from "react";

const CANNED_PROMPTS = [
  "Review account ACCT-1001 for an outage credit.",
  "ACCT-1002 had an outage on Nov 5. Can we credit them?",
  "Check ACCT-1003 for an outage credit.",
  "ACCT-1004 is asking for a credit.",
];

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Find the policy result for an account so the approver can see the amount. */
function findProposal(messages: UIMessage[], accountId: string | undefined) {
  for (const m of [...messages].reverse()) {
    for (const part of [...m.parts].reverse()) {
      if (!isToolUIPart(part) || getToolName(part) !== "proposeCredit") continue;
      if (part.state !== "output-available") continue;
      const out = part.output as {
        found?: boolean;
        accountId?: string;
        customerName?: string;
        decision?: { outcome: string; amountCents?: number; reasons?: string[] };
      };
      if (out?.found && (!accountId || out.accountId === accountId)) return out;
    }
  }
  return null;
}

export default function Chat() {
  const transport = useMemo(() => new WorkflowChatTransport<UIMessage>({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error, addToolApprovalResponse } = useChat({
    transport,
    // After the approver clicks Approve/Reject, resend automatically so the run continues.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  // DELIBERATE DECISION: if the model call fails inside the workflow (for example, no
  // AI Gateway access), the stream can close cleanly with no content and no error
  // part. Without this check the page would just go blank, so detect "finished but
  // nothing visible came back" and say so.
  const last = messages[messages.length - 1];
  const lastHasContent =
    last?.role === "assistant" &&
    last.parts.some((p) => (p.type === "text" && p.text.trim() !== "") || isToolUIPart(p));
  const noReply = status === "ready" && messages.length > 0 && !lastHasContent;

  function submit(text: string) {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <div style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ marginBottom: 4 }}>Tristan Electric Credit Agent</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Ask about an account. The agent checks the outage history and proposes a credit using a fixed
        policy. Nothing is applied until a human approves.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
        {CANNED_PROMPTS.map((p) => (
          <button key={p} disabled={busy} onClick={() => submit(p)} style={chipStyle}>
            {p}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              background: m.role === "user" ? "#eef3ff" : "#f6f6f6",
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            <strong>{m.role === "user" ? "Rep" : "Agent"}</strong>
            {m.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <p key={i} style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>
                    {part.text}
                  </p>
                );
              }
              if (isToolUIPart(part)) {
                const name = getToolName(part);
                if (part.state === "approval-requested") {
                  const accountId = (part.input as { accountId?: string } | undefined)?.accountId;
                  const proposal = findProposal(messages, accountId);
                  const d = proposal?.decision;
                  return (
                    <div key={i} style={approvalStyle}>
                      <strong>Approval needed</strong>
                      <div>
                        Apply credit to {proposal?.customerName ?? "account"} ({accountId}):{" "}
                        <strong>{d?.amountCents != null ? dollars(d.amountCents) : "see policy result"}</strong>
                      </div>
                      {d?.reasons?.map((r) => (
                        <div key={r} style={{ fontSize: 13, color: "#444" }}>
                          {r}
                        </div>
                      ))}
                      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                        <button
                          onClick={() =>
                            addToolApprovalResponse({ id: part.approval.id, approved: true })
                          }
                        >
                          Approve
                        </button>
                        <button
                          onClick={() =>
                            addToolApprovalResponse({ id: part.approval.id, approved: false })
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} style={{ fontSize: 12, color: "#666", margin: "4px 0" }}>
                    tool: {name} ({part.state})
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
      </div>

      {error && <p style={{ color: "#b00020" }}>Something went wrong: {error.message}</p>}
      {noReply && !error && (
        <p style={{ color: "#b00020" }}>
          The agent did not return a response. This usually means the model call failed (for
          example, AI Gateway access is not configured). Check the server logs.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        style={{ display: "flex", gap: 8, marginTop: 16 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. Review account ACCT-1001"
          style={{ flex: 1, padding: 8 }}
        />
        <button disabled={busy || !input.trim()}>{busy ? "Working..." : "Send"}</button>
      </form>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 16,
  border: "1px solid #bbb",
  background: "white",
  cursor: "pointer",
  fontSize: 13,
};

const approvalStyle: React.CSSProperties = {
  border: "2px solid #d9a400",
  background: "#fff8e1",
  borderRadius: 8,
  padding: 10,
  margin: "8px 0",
};
