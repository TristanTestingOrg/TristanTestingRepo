import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

// Reconnect endpoint: after a page refresh or dropped connection, the client asks
// for the run's stream again, starting from a chunk index. This is what makes the
// stream survive a refresh.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  // Run IDs look like wrun_01M7V4C2J70MFJ0A3XDXHPXC7R. Reject anything else early.
  if (!/^wrun_[A-Za-z0-9]+$/.test(runId)) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }

  const startIndexParam = Number(new URL(request.url).searchParams.get("startIndex") ?? "0");
  const startIndex = Number.isInteger(startIndexParam) ? startIndexParam : 0;

  const run = getRun(runId);
  return createUIMessageStreamResponse({
    stream: run.getReadable({ startIndex }).pipeThrough(createModelCallToUIChunkTransform()),
    headers: { "x-workflow-run-id": runId },
  });
}
