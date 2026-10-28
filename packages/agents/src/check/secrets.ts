import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { CHECK_SECRETS, checkServerSecret, deploySecretName } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
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

/**
 * The webhook's secrets: its address (`OPSCREW_CHECK_WEBHOOK`) and, for ntfy, its optional access
 * token (`OPSCREW_CHECK_NTFY_TOKEN`), each from the variable of its name or, in a terminal, asked
 * like an app secret (never echoed). One not given keeps what GitHub holds.
 */
async function webhookSecrets(
  deps: Pick<PhaseDeps, "env" | "interactive">,
  settings: CheckSettings | undefined,
  services: Pick<ProvisionServices, "askEnv">,
): Promise<Record<string, string>> {
  if (settings?.webhook === undefined) return {};
  const names = [
    CHECK_SECRETS.webhook,
    ...(settings.webhook === "ntfy" ? [CHECK_SECRETS.ntfyToken] : []),
  ];
  const values: Record<string, string> = {};
  for (const name of names) {
    const given = deps.env[name]?.trim();
    if (given) {
      values[name] = given;
      continue;
    }
    if (!deps.interactive || services.askEnv === undefined) continue;
    const answer = await services.askEnv({
      name,
      secret: true,
      environment: "prod",
      localFile: ".env",
      localValueAvailable: false,
      optional: true,
    });
    if ("value" in answer && answer.value.trim().length > 0) values[name] = answer.value.trim();
  }
  return values;
}

/**
 * Stores the scheduled check's repository secrets after one `github-secrets` approval that lists
 * their names: the check key (`OPSCREW_CHECK_SSH_KEY`), the environment's server
 * (`<prefix>CHECK_SERVER`, `checkServerSecret`'s JSON: host, port, user and known-hosts line),
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
    services: Pick<ProvisionServices, "askEnv">;
    phase: PhaseName;
  },
): Promise<void> {
  const { plan, key, server } = input;
  const secrets: Record<string, string> = {
    ...(key === undefined ? {} : { [CHECK_SECRETS.sshKey]: key.privateKeyOpenSsh }),
    ...(server === undefined
      ? {}
      : { [deploySecretName(plan, CHECK_SECRETS.server)]: checkServerSecret(server) }),
    ...(await webhookSecrets(deps, input.settings, input.services)),
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
