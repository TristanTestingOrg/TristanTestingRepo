import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

// Reconnect endpoint: after a page refresh or dropped connection, the client asks
// for the run's stream again, starting from a chunk index. This is what makes the
// stream survive a refresh.
//
// DELIBERATE DECISIONS:
//  - The chat transport requests /api/chat/<runId>/stream, which would normally need
//    a folder named [runId]. next.config.ts rewrites that URL to this plain route, so
//    the repo has no bracketed folder names (awkward to upload through GitHub's web UI).
//  - A route handler sees the ORIGINAL request URL, not the rewritten one, so the run
//    id is read from the original path. A ?runId= query parameter is also accepted,
//    which makes the route easy to call directly while testing.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fromPath = /^\/api\/chat\/([^/]+)\/stream\/?$/.exec(url.pathname)?.[1];
  const runId = decodeURIComponent(fromPath ?? url.searchParams.get("runId") ?? "");

  // Run IDs look like wrun_01M7V4C2J70MFJ0A3XDXHPXC7R. Reject anything else early.
  if (!/^wrun_[A-Za-z0-9]+$/.test(runId)) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }

  const startIndexParam = Number(url.searchParams.get("startIndex") ?? "0");
  const startIndex = Number.isInteger(startIndexParam) ? startIndexParam : 0;

  const run = getRun(runId);
  return createUIMessageStreamResponse({
    stream: run.getReadable({ startIndex }).pipeThrough(createModelCallToUIChunkTransform()),
    headers: { "x-workflow-run-id": runId },
  });
}
