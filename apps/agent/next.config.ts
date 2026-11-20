import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// withWorkflow enables the "use workflow" and "use step" directives and generates
// the internal /.well-known/workflow routes that run durable steps.
const nextConfig: NextConfig = {};

export default withWorkflow(nextConfig);
