import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { convertToModelMessages, createUIMessageStreamResponse, type UIMessage } from "ai";
import { start } from "workflow/api";
import { creditCase } from "@/workflows/credit-case";

// DELIBERATE DECISION: this route only STARTS the durable run and pipes its stream
// back. The agent loop, tools and approval pause all live in the workflow, so a
// crash or redeploy of this function does not lose the run.
//
// Input limits: this endpoint spends model credits, so cap what a caller can send.
const MAX_MESSAGES = 40;
const MAX_BODY_CHARS = 50_000;

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return Response.json({ error: "Request too large." }, { status: 413 });
  }

  let messages: UIMessage[];
  try {
    ({ messages } = JSON.parse(raw));
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return Response.json({ error: "Invalid messages." }, { status: 400 });
  }

  const modelMessages = await convertToModelMessages(messages);
  const run = await start(creditCase, [modelMessages]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    // The client transport reads this header so it can reconnect after a refresh.
    headers: { "x-workflow-run-id": run.runId },
  });
}
