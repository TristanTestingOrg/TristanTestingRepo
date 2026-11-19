// Simple liveness check so a deploy can be verified with curl. It never touches the
// billing system or any secret.
export function GET() {
  return Response.json({ status: "ok", service: "tristan-electric-credit-agent" });
}
