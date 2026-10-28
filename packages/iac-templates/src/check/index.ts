// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are GitHub Actions expressions, not JavaScript templates.
import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isServerlessTarget } from "@opscrew/plan-schema";
import type {
  CheckConfig,
  CheckEnvironment,
  CheckServer,
  CheckThresholds,
  ServerReach,
} from "../../check/check.mjs";
import { CHECK_SCRIPT } from "../generated/check";
import { ACTIONS, RUNTIME_DEFAULTS } from "../pins";
import { siteHosts } from "../runtime";
import { tunnelMode } from "../tunnel";
import type { RenderedFile } from "../types";
import {
  block,
  deploySecretName,
  deploysInPlace,
  environmentName,
  healthPath,
  runnerLabel,
  selfHosted,
} from "../workflow/shared";

/** The check's workflow file in `.github/workflows/`. */
export const CHECK_WORKFLOW_FILE = "opscrew-check.yml";

/** The label of every issue the check opens (`check.mjs`'s `LABEL`). */
export const CHECK_LABEL = "opscrew-check";

/** The repository variable that pauses environments: JSON, `{ "<app>/<env>": { reason, since } }`. */
export const CHECK_PAUSED_VARIABLE = "OPSCREW_CHECK_PAUSED";

/**
 * The repository secrets the check reads. `server` is each environment's, named with its prefix
 * (`deploySecretName(plan, CHECK_SECRETS.server)`) and holding {@link checkServerSecret}'s JSON.
 */
export const CHECK_SECRETS = {
  /** The check key: the private key servers let run only `df`. */
  sshKey: "OPSCREW_CHECK_SSH_KEY",
  server: "OPSCREW_CHECK_SERVER",
  /** The webhook's address. */
  webhook: "OPSCREW_CHECK_WEBHOOK",
  /** ntfy's access token, optional. */
  ntfyToken: "OPSCREW_CHECK_NTFY_TOKEN",
} as const;

/** The `check` job's runner: `ubuntu-slim` (spike result 5, a third of a 2-core minute). */
const CHECK_RUNNER = "ubuntu-slim";

const CHECK_DIR = "opscrew/check";

/** The spec's thresholds: disk 85% and 95%, 14 days of certificate, three tries 30 s apart. */
const THRESHOLDS: CheckThresholds = {
  diskWarn: 85,
  diskHigh: 95,
  certDays: 14,
  tries: 3,
  retrySeconds: 30,
  timeoutSeconds: 10,
};

/** The repository the check runs in, and its visibility. */
export interface CheckRepository {
  owner: string;
  name: string;
  public: boolean;
}

/**
 * `<app>/<env>`, the environment's name in check.json, its issues' keys and
 * {@link CHECK_PAUSED_VARIABLE}: a further app's key or the first app's base name (a named
 * environment's app is named `<app>-<env>`: `shop/staging`), then the environment (`prod` for the
 * plan without one).
 */
export function checkEnvironmentKey(plan: DeployPlan): string {
  const env = environmentName(plan);
  const suffix = `-${env}`;
  const named = plan.environment?.name !== undefined && plan.app.name.endsWith(suffix);
  const app = plan.app.key ?? (named ? plan.app.name.slice(0, -suffix.length) : plan.app.name);
  return `${app}/${env}`;
}

/** The content of an environment's server secret ({@link CHECK_SECRETS}' `server`). */
export function checkServerSecret(server: ServerReach): string {
  const { host, port, user, knownHosts } = server;
  return JSON.stringify({ host, port, user, knownHosts });
}

/**
 * The scheduled check's files, one set for the repository, from every app's and environment's plan
 * (`plans`) with `observability.check.enabled`; none when no plan has it on, and none for a
 * destroyed environment:
 * - `.github/workflows/opscrew-check.yml`: on a schedule at minutes off the hour and by hand, the
 *   `check` job on GitHub's machines, plus one job per server whose deploys run on its own runner
 *   or a runner machine, which checks that server's disk there;
 * - `opscrew/check/check.json`: each environment's hostnames, health path and server, by id and
 *   the name of the secret with its address, never an address;
 * - `opscrew/check/check.mjs`, the same in every repository.
 *
 * The interval and the webhook are the repository's: the first app's prod plan's, else every 15
 * minutes in a public repository and 60 in a private one.
 *
 * A server's disk is checked once, by the first environment in the repository's order whose plan
 * has it: one disk check, one disk issue, and one job on its own runner per server.
 */
export function renderCheck(input: {
  plans: readonly DeployPlan[];
  repo: CheckRepository;
  /**
   * The id of each environment's server, by {@link checkEnvironmentKey}: what identifies the
   * server outside the plan (an own server's record), so environments on one server share it.
   * Letters, digits, `-` and `_`, never an address. Without one, a cloud or own server's id is
   * `<provider>-<app name>` (`hetzner-shop`, `own-shop`).
   */
  serverIds?: Readonly<Record<string, string>>;
}): RenderedFile[] {
  const { repo } = input;
  const plans = input.plans
    .filter((plan) => plan.observability?.check?.enabled === true)
    .filter((plan) => plan.deployment.destroyedAt === undefined)
    .sort(byApp);
  if (plans.length === 0) return [];

  const settings = input.plans.find(
    (plan) => plan.app.key === undefined && plan.environment?.name === undefined,
  )?.observability?.check;
  const intervalMinutes = settings?.intervalMinutes ?? (repo.public ? 15 : 60);
  const webhook = settings?.webhook;

  const seen = new Set<string>();
  const environments: { plan: DeployPlan; environment: CheckEnvironment }[] = plans.map((plan) => {
    const path = isServerlessTarget(plan.target) ? "/" : healthPath(plan);
    let server = serverOf(plan, input.serverIds?.[checkEnvironmentKey(plan)]);
    if (server !== undefined && seen.has(server.id)) server = undefined;
    if (server !== undefined) seen.add(server.id);
    return {
      plan,
      environment: {
        key: checkEnvironmentKey(plan),
        hosts: siteHosts(plan).map((hostname) => ({ hostname, healthPath: path })),
        ...(server === undefined ? {} : { server }),
      },
    };
  });
  const config: CheckConfig = {
    version: 1,
    intervalMinutes,
    thresholds: THRESHOLDS,
    ...(webhook === undefined ? {} : { webhook }),
    public: repo.public,
    environments: environments.map(({ environment }) => environment),
  };
  return [
    {
      path: `.github/workflows/${CHECK_WORKFLOW_FILE}`,
      content: workflow(config, repo, environments),
      kind: "workflow",
    },
    {
      path: `${CHECK_DIR}/check.json`,
      content: `${JSON.stringify(config, null, 2)}\n`,
      kind: "workflow",
    },
    { path: `${CHECK_DIR}/check.mjs`, content: CHECK_SCRIPT, kind: "workflow" },
  ];
}

/** The repository's order: the first app, then the further apps by key; prod, then by name. */
function byApp(a: DeployPlan, b: DeployPlan): number {
  const key = (plan: DeployPlan) => `${plan.app.key ?? ""}\u0000${plan.environment?.name ?? ""}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** A server id: it names a job, a concurrency group and a part of each disk issue's key. */
const SERVER_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The server whose disk the check reads, on a cloud or own server: by `given` (the caller's id for
 * it), else by the provider and the app's name (`hetzner-shop`, `own-shop`), which no other
 * environment in the repository has. Read where the environment's deploys run: from GitHub's
 * machines or its runner machine over SSH with the check key, or on the server's own runner. An
 * own server in tunnel mode is reached over SSH only through Cloudflare Access, so it gets a disk
 * check only from its own runner.
 * @throws OpsCrewError `INTERNAL` for a given id with other characters than {@link SERVER_ID}'s.
 */
function serverOf(plan: DeployPlan, given: string | undefined): CheckServer | undefined {
  const via = checkDiskVia(plan);
  if (via === undefined) return undefined;
  if (given !== undefined && !SERVER_ID.test(given)) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew gave the scheduled check a server id for ${checkEnvironmentKey(plan)} with characters other than letters, digits, "-" and "_".`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  const id = given ?? `${plan.target.provider}-${plan.app.name}`;
  if (via === "own-runner") return { id, via };
  return { id, secret: deploySecretName(plan, CHECK_SECRETS.server), via };
}

/**
 * How the check reads the disk of `plan`'s server: where the environment's deploys run, over SSH
 * with the check key from GitHub's machines (`github`) or its runner machine (`runner-host`), or
 * on the server's own runner (`own-runner`). `undefined` when it reads none: no server of the
 * app's (Portainer, the server-less targets), or an own server in tunnel mode deployed over SSH,
 * which the check's SSH can't reach through the tunnel's Cloudflare Access login.
 */
export function checkDiskVia(plan: DeployPlan): CheckServer["via"] | undefined {
  if (plan.target.mode !== "vps-compose") return undefined;
  if (deploysInPlace(plan)) return "own-runner";
  if (tunnelMode(plan)) return undefined;
  return selfHosted(plan) ? "runner-host" : "github";
}

/** The cron line: every `interval` minutes from a minute the repository's name picks, never :00. */
function cron(repo: CheckRepository, interval: number): string {
  const name = `${repo.owner}/${repo.name}`.toLowerCase();
  const hash = createHash("sha256").update(name).digest().readUInt32BE(0);
  const minutes: number[] = [];
  for (let minute = 1 + (hash % (interval - 1)); minute < 60; minute += interval) {
    minutes.push(minute);
  }
  return `${minutes.join(",")} * * * *`;
}

function workflow(
  config: CheckConfig,
  repo: CheckRepository,
  environments: readonly { plan: DeployPlan; environment: CheckEnvironment }[],
): string {
  const guard = `github.repository == '${repo.owner}/${repo.name}'`;
  const webhook = [
    ...(config.webhook === undefined ? [] : [CHECK_SECRETS.webhook]),
    ...(config.webhook === "ntfy" ? [CHECK_SECRETS.ntfyToken] : []),
  ];
  const overSsh = config.environments.flatMap(({ server }) =>
    server?.via === "github" && server.secret !== undefined ? [server.secret] : [],
  );
  const lines = [
    "# Generated by OpsCrew from every plan with the scheduled check on (observability.check);",
    "# `opscrew provision` regenerates it. It runs opscrew/check/check.mjs, which checks what",
    "# opscrew/check/check.json lists: each hostname's health path over HTTPS and its certificate,",
    "# and each server's disk. A failing check opens a GitHub issue labelled opscrew-check, which",
    "# closes when the check passes again.",
    "name: OpsCrew check",
    "",
    "on:",
    "  schedule:",
    `    # Every ${config.intervalMinutes} minutes, never on the hour: GitHub delays the runs at the top of each hour.`,
    `    - cron: "${cron(repo, config.intervalMinutes)}"`,
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "  issues: write",
    "",
    "jobs:",
    ...job({
      id: "check",
      name: "Check the hostnames, certificates and disks",
      guard,
      runsOn: CHECK_RUNNER,
      concurrency: "opscrew-check",
      steps: [
        ...CHECKOUT,
        ...runStep(
          [...(overSsh.length > 0 ? [CHECK_SECRETS.sshKey, ...overSsh] : []), ...webhook],
          "",
        ),
      ],
    }),
  ];
  for (const { plan, environment } of environments) {
    const server = environment.server;
    if (server === undefined || server.via === "github") continue;
    const secrets = server.secret === undefined ? [] : [CHECK_SECRETS.sshKey, server.secret];
    lines.push(
      "",
      ...job({
        id: `disk-${server.id}`,
        name: `Check the disk of ${server.id}`,
        guard,
        runsOn: `[self-hosted, ${runnerLabel(plan)}]`,
        concurrency: `opscrew-check-disk-${server.id}`,
        steps: [
          ...CHECKOUT,
          `- uses: ${ACTIONS.setupNode}`,
          "  with:",
          `    node-version: ${JSON.stringify(RUNTIME_DEFAULTS.node)}`,
          ...runStep([...secrets, ...webhook], ` --only disk:${server.id}`),
        ],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Only the check's folder, and the job's token stays out of git's settings. */
const CHECKOUT = [
  `- uses: ${ACTIONS.checkout}`,
  "  with:",
  `    sparse-checkout: ${CHECK_DIR}`,
  "    persist-credentials: false",
];

/** The step that runs check.mjs with `args` and the secrets named in `secrets`. */
function runStep(secrets: readonly string[], args: string): string[] {
  return [
    "- name: Run the check",
    "  env:",
    "    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    `    ${CHECK_PAUSED_VARIABLE}: \${{ vars.${CHECK_PAUSED_VARIABLE} }}`,
    ...secrets.map((name) => `    ${name}: \${{ secrets.${name} }}`),
    `  run: node ${CHECK_DIR}/check.mjs${args}`,
  ];
}

/**
 * A job of the check: only in this repository (a fork's runs would open issues in the fork), five
 * minutes at most, and one run at a time in its group, never cancelled. Each disk job on a
 * self-hosted runner has a group of its own, so while that runner is offline its runs wait there
 * and the `check` job goes on.
 */
function job(j: {
  id: string;
  name: string;
  guard: string;
  runsOn: string;
  concurrency: string;
  steps: readonly string[];
}): string[] {
  return [
    `  ${j.id}:`,
    `    name: ${j.name}`,
    `    if: ${j.guard}`,
    `    runs-on: ${j.runsOn}`,
    "    timeout-minutes: 5",
    "    concurrency:",
    `      group: ${j.concurrency}`,
    "      cancel-in-progress: false",
    "    steps:",
    ...block(j.steps, 6),
  ];
}
