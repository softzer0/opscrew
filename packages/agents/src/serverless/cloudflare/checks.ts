/**
 * The checks of `opscrew provision` on Cloudflare's hosting, before anything changes: the two
 * tokens' Workers permission, the Worker's name in the account and the hostnames' DNS records.
 */
import {
  CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  cloudflareConnector,
} from "@opscrew/connector-cloudflare";
import type { IacEngine } from "@opscrew/contracts";
import { errorText, exists, listText, OpsCrewError, tfstateFile } from "@opscrew/core";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../../context";
import { providerProfile } from "../../providers";
import type { CloudflareSetup } from "../../provision/credentials";
import { committedTfvars } from "../../provision/render";
import { planFile } from "../../runners/words";

/** Account → Workers Scripts → Edit: all both tokens need for the Worker (016's spike, result 3). */
const WORKERS_PERMISSION = CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS[0];

/** The variable of the deploy token the workflow uploads each version with. */
const DEPLOY_TOKEN_VAR = providerProfile("cloudflare-workers").deployTokenVar;

/** The Worker's shell in the state of the root (`module.worker`). */
const WORKER_SCRIPT = "cloudflare_workers_script.this";

/**
 * The token check (FR-1610): `CLOUDFLARE_API_TOKEN` (`client`) creates the Worker and its custom
 * domains, and the deploy token (`OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`), which the deploy workflow
 * uploads each version with, is a token of its own; both hold Account → Workers Scripts → Edit for
 * the account that holds the zone (`workersPermissions`, read-only). The deploy token is checked
 * only when this run stores the deploy secrets (`deployToken`), and never OpsCrew's own token,
 * which can edit DNS, goes to GitHub. Returns the deploy token, registered with the redactor.
 * @throws OpsCrewError `CREDENTIALS_MISSING` or `CREDENTIALS_INVALID` naming the token, what it
 * lacks and where to add it; nothing was changed.
 */
export async function requireWorkersTokens(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  input: {
    client: CloudflareClient;
    cloudflare: Pick<CloudflareSetup, "accountId" | "zoneName">;
    deployToken: boolean;
    command: string;
  },
): Promise<string | undefined> {
  const { accountId, zoneName } = input.cloudflare;
  const again = `then run \`${input.command}\` again`;
  const account = `the account that holds ${zoneName}`;
  const main = await input.client.workersPermissions(accountId);
  if (main.missing.length > 0) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `CLOUDFLARE_API_TOKEN lacks ${listText(main.missing)} for ${account}, and OpsCrew creates the app's Worker and its custom domains with it. Nothing was changed.`,
      { hint: `Add it to the token at ${CLOUDFLARE_TOKEN_PAGE}, ${again}.` },
    );
  }
  if (!input.deployToken) return undefined;
  const create = `Create a token at ${CLOUDFLARE_TOKEN_PAGE} with only ${WORKERS_PERMISSION} for ${account}, set ${DEPLOY_TOKEN_VAR} to it, ${again}. OpsCrew stores it as a GitHub secret for the deploy workflow.`;
  const token = deps.env[DEPLOY_TOKEN_VAR]?.trim();
  if (!token) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${DEPLOY_TOKEN_VAR} is not set: the deploy workflow uploads each version of the Worker with a token of its own, which holds only ${WORKERS_PERMISSION}. Nothing was changed.`,
      { hint: create },
    );
  }
  deps.redactor.addLiteral(token, DEPLOY_TOKEN_VAR);
  if (token === deps.env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `${DEPLOY_TOKEN_VAR} is the same token as CLOUDFLARE_API_TOKEN, which can edit your DNS, so OpsCrew does not store it in GitHub. Nothing was changed.`,
      { hint: create },
    );
  }
  const deploy = cloudflareConnector({
    env: { CLOUDFLARE_API_TOKEN: token },
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  }).client as CloudflareClient;
  let missing: string[];
  try {
    missing = (await deploy.workersPermissions(accountId)).missing;
  } catch (error) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      deps.redactor.redact(`${DEPLOY_TOKEN_VAR} does not work: ${errorText(error)}`),
      { hint: create, cause: error },
    );
  }
  if (missing.length > 0) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `${DEPLOY_TOKEN_VAR} lacks ${listText(missing)} for ${account}, and the deploy workflow uploads each version of the Worker with it. Nothing was changed.`,
      { hint: create },
    );
  }
  return token;
}

/**
 * Refuses a Worker of the plan's name that the account already has and this app's state does not
 * hold: the infrastructure plan would create it, which replaces that Worker's code. The
 * state holds it when it lists the Worker's shell and the last run rendered this name (the
 * committed `terraform.tfvars.json`): after a rename the state's shell is the old name's.
 * Read-only.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the Worker; nothing was changed.
 */
export async function requireOwnWorker(
  deps: Pick<PhaseDeps, "paths">,
  input: {
    client: CloudflareClient;
    accountId: string;
    plan: DeployPlan;
    target: CloudflareWorkersDeployTarget;
    engine: IacEngine;
    env: Record<string, string | undefined>;
    command: string;
  },
): Promise<void> {
  const { worker } = input.target;
  if ((await input.client.listWorkerDeployments(input.accountId, worker)) === undefined) return;
  const state = tfstateFile(deps.paths);
  const held =
    (await exists(state)) &&
    (await input.engine.stateResources(state, { env: input.env })).some((address) =>
      address.endsWith(WORKER_SCRIPT),
    ) &&
    (await committedTfvars(deps.paths.root, input.plan))?.worker === worker;
  if (held) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Your Cloudflare account already has a Worker named ${worker}, and it is not this app's: OpsCrew would replace its code. Nothing was changed.`,
    {
      hint: `Give this app's Worker a name of its own in target.worker of ${planFile(input.plan)} (lower case letters, digits and hyphens), then run \`${input.command}\` again.`,
    },
  );
}

/**
 * Refuses A, AAAA and CNAME records at the app's hostnames that OpsCrew did not create (`foreign`,
 * from `setupCloudflare` with `foreignRecords: "report"`), as for servers: a custom domain cannot be
 * added next to them. The records the Worker's own custom domains created (listed by
 * `listWorkerCustomDomains`, they carry no OpsCrew comment) are not foreign. Read-only.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming each record; nothing was changed.
 */
export async function requireFreeHostnames(input: {
  client: CloudflareClient;
  accountId: string;
  worker: string;
  foreign: CloudflareSetup["foreignRecords"];
  command: string;
}): Promise<void> {
  if ((input.foreign ?? []).length === 0) return;
  const domains = new Set(
    (await input.client.listWorkerCustomDomains(input.accountId, input.worker)).map(
      (domain) => domain.hostname,
    ),
  );
  const clashing = (input.foreign ?? []).filter((record) => !domains.has(record.name));
  if (clashing.length === 0) return;
  const names = [...new Set(clashing.map((record) => record.name))];
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    [
      `Cloudflare already has DNS records for ${listText(names)} that OpsCrew did not create:`,
      ...clashing.map((record) => `  ${record.type} ${record.name} ${record.content}`),
      "The Worker's custom domains cannot be added next to them. Nothing was changed.",
    ].join("\n"),
    {
      hint: `Delete these records in the Cloudflare dashboard (DNS → Records) if they belong to a host you no longer use, or give the app another hostname (\`opscrew interview\`, then \`opscrew design\`), then run \`${input.command}\` again.`,
    },
  );
}
