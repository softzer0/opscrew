import type { ApprovalRequest } from "@opscrew/contracts";

/**
 * The answers of a scripted `opscrew destroy --confirm <name>` (no `--yes`, no terminal), as the
 * CLI's typed-name handler gives them: the teardown's plans that ask for exactly that name (and
 * `iac-apply` without a name: lifting delete protection), and the deploy secrets' removal; every
 * other request (a `github-settings` change among them) is refused.
 */
export function scriptedConfirm(name: string): (request: ApprovalRequest) => boolean {
  return (request) => {
    switch (request.kind) {
      case "iac-apply":
        return request.confirmPhrase === undefined || request.confirmPhrase === name;
      case "host-apply":
        return request.confirmPhrase === name;
      case "stack-apply":
      case "cloudflare-apply":
      case "pages-apply":
        return request.allowDestroy === true && request.confirmPhrase === name;
      case "github-secrets":
        return true;
      default:
        return false;
    }
  };
}
