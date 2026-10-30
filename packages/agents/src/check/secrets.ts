import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { CHECK_SECRETS, checkServerSecret, deploySecretName } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import type { CheckKey } from "./key";
import type { CheckSettings } from "./settings";

/** How the check key reaches an environment's server: what `<prefix>CHECK_SERVER` holds. */
export interface CheckServerReach {
  host: string;
  port: number;
  user: string;
  knownHosts: string;
}

/** Each webhook kind as the user knows it. */
const WEBHOOK_NAMES = { slack: "Slack", discord: "Discord", ntfy: "ntfy" } as const;

/**
 * The webhook's secrets: its address (`OPSCREW_CHECK_WEBHOOK`), from the variable of that name
 * or, in a terminal, asked with `askCheckWebhook` (never echoed) when the repository has no such
 * secret yet; a cancelled question says the address was not stored. A secret GitHub already holds
 * is kept, with a hint that a changed webhook kind needs the variable set again. For ntfy, its
 * optional access token (`OPSCREW_CHECK_NTFY_TOKEN`) from the variable of that name. One not given
 * keeps what GitHub holds.
 */
async function webhookSecrets(
  deps: Pick<PhaseDeps, "env" | "interactive" | "reporter">,
  github: GitHubSetup,
  settings: CheckSettings | undefined,
  services: Pick<ProvisionServices, "askCheckWebhook">,
): Promise<Record<string, string>> {
  const kind = settings?.webhook;
  if (kind === undefined) return {};
  let address = deps.env[CHECK_SECRETS.webhook]?.trim();
  const stored =
    !address &&
    (await github.api.actionsSecretExists(github.owner, github.repo, CHECK_SECRETS.webhook));
  if (stored) {
    deps.reporter.info(
      `GitHub already holds the scheduled check's webhook address (${CHECK_SECRETS.webhook}), so it is kept. If you changed the webhook to ${WEBHOOK_NAMES[kind]}, set ${CHECK_SECRETS.webhook} to its address and run \`opscrew provision\` again.`,
    );
  }
  if (!address && !stored && deps.interactive && services.askCheckWebhook !== undefined) {
    address = (
      await services.askCheckWebhook({
        kind,
        prompt: `Address of the ${WEBHOOK_NAMES[kind]} webhook for the scheduled check (stored as a GitHub secret)`,
      })
    )?.trim();
    if (!address) {
      deps.reporter.warn(
        `The ${WEBHOOK_NAMES[kind]} webhook's address was not stored, so the scheduled check posts nowhere new. Run \`opscrew provision\` again to give it, or set ${CHECK_SECRETS.webhook}.`,
      );
    }
  }
  const token = kind === "ntfy" ? deps.env[CHECK_SECRETS.ntfyToken]?.trim() : undefined;
  return {
    ...(address ? { [CHECK_SECRETS.webhook]: address } : {}),
    ...(token ? { [CHECK_SECRETS.ntfyToken]: token } : {}),
  };
}

/**
 * Stores the scheduled check's repository secrets after one `github-secrets` approval that lists
 * their names: the check key (`OPSCREW_CHECK_SSH_KEY`), the environment's server
 * (`<prefix>CHECK_SERVER`, `checkServerSecret`'s JSON list, here only the app's entry (`id: app`)),
 * and the webhook's ({@link webhookSecrets}) when the repository's `settings` have one. Values are
 * registered with the redactor and sealed on this computer; only names are shown and audited.
 * Nothing to store asks nothing.
 */
export async function storeCheckSecrets(
  deps: Pick<PhaseDeps, "env" | "interactive" | "approvals" | "audit" | "reporter" | "redactor">,
  github: GitHubSetup,
  input: {
    plan: DeployPlan;
    settings: CheckSettings | undefined;
    key?: CheckKey;
    server?: CheckServerReach;
    services: Pick<ProvisionServices, "askCheckWebhook">;
    phase: PhaseName;
  },
): Promise<void> {
  const { plan, key, server } = input;
  const secrets: Record<string, string> = {
    ...(key === undefined ? {} : { [CHECK_SECRETS.sshKey]: key.privateKeyOpenSsh }),
    ...(server === undefined
      ? {}
      : {
          [deploySecretName(plan, CHECK_SECRETS.server)]: checkServerSecret([
            { id: APP_SERVER, ...server },
          ]),
        }),
    ...(await webhookSecrets(deps, github, input.settings, input.services)),
  };
  const names = Object.keys(secrets).sort();
  if (names.length === 0) return;
  for (const [name, value] of Object.entries(secrets)) deps.redactor.addLiteral(value, name);
  const repo = `${github.owner}/${github.repo}`;
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Store ${names.length} secrets of the scheduled check in GitHub Actions for ${repo}`,
    details: [
      "Repository secrets (names only; values are encrypted on this computer before upload and never shown):",
      ...names.map((name) => `  ${name}`),
      "The scheduled check reads the servers' disks with them, and posts to the webhook when one is set.",
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The scheduled check's secrets were not stored, so it can't read the server's disk or post to the webhook yet. Everything before this step is done.",
      { hint: "Run `opscrew provision` again when you are ready; it continues from here." },
    );
  }
  const sealing = await github.api.getActionsPublicKey(github.owner, github.repo);
  for (const name of names) {
    await github.api.setActionsSecret(
      github.owner,
      github.repo,
      name,
      secrets[name] as string,
      sealing,
    );
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `set secret ${name}`,
      phase: input.phase,
      target: repo,
      decision: "approved",
    });
  }
  deps.reporter.success(`Stored ${names.length} secrets of the scheduled check in GitHub Actions.`);
}
