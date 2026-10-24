import type { PromoteResult } from "./types";

/**
 * What a promotion deployed, in words, for the CLI and the MCP server: the build a promotion on
 * Cloudflare's hosting copied (its run and SHA-256), the version a site's rollback went back to,
 * or the image by its digest.
 */
export function promotedText(result: Pick<PromoteResult, "build" | "version" | "digest">): string {
  if (result.build !== undefined) {
    return `the build of run ${result.build.runId} (SHA-256 ${result.build.sha256})`;
  }
  return result.version !== undefined ? `version ${result.version}` : (result.digest ?? "");
}
