/**
 * Model choices, in one place.
 *
 * DELIBERATE DECISIONS:
 *  - These are plain constants, not environment variables. Workflow functions are
 *    replayed to rebuild state, so they must behave the same every time; reading
 *    process.env inside one risks a replay that disagrees with the original run.
 *  - All model calls go through AI Gateway (a "creator/model" string), so swapping
 *    a model or adding a fallback is a one-line change here, not an app redesign.
 *  - The fallback is a different provider on purpose: if the primary provider is
 *    degraded, the Gateway tries the next entry in this list automatically.
 *
 * VERIFY BEFORE RELYING ON THESE: check the exact slugs in the AI Gateway "Model
 * List" in your Vercel dashboard. A wrong slug fails the call.
 */
export const PRIMARY_MODEL = "anthropic/claude-sonnet-5.5";
export const FALLBACK_MODELS = ["google/gemini-3.1-pro-preview"];
