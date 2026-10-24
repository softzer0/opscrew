/**
 * `opscrew promote` (feature 015): deploys the image another environment runs, or the target's
 * previous one, to the next environment, after checking its provenance and a `promote` approval
 * bound to the promotion's hash. For a site (feature 016): the build another environment runs on
 * Cloudflare's hosting, or a rollback to an earlier version on Cloudflare or GitHub Pages.
 */
export { type PromotionParts, promotionHash } from "./record";
export { promote } from "./run";
export type { PromoteGitHubApi, PromoteOptions, PromoteResult, PromoteServices } from "./types";
