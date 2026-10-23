/**
 * The files OpsCrew generates for the server-less targets besides the workflow and the IaC: the
 * Wrangler config and the SSR headers wrapper; and the names provision and promotion share with
 * the workflows.
 */
export { renderHeadersEntry } from "./headers";
export { SITE_ARTIFACT, siteEnvSecret } from "./site";
export { renderWranglerConfig } from "./wrangler";
