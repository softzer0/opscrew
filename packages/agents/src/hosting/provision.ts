/**
 * `opscrew provision` for an app on a hosting account with a panel (027 plan 2, ADR 0030): plan A
 * installs the agent, its first report builds plan B for the app, each approved by its hash
 * (`hosting-apply`) and applied through the panel's connector; then the DNS record (when the
 * domain is on Cloudflare), the certificate, the agent's deploy key and the release signing key on
 * GitHub, and the deploy workflow in the provision pull request.
 */
import { join } from "node:path";
import { type GitClient, type GitHubClient, githubConnector } from "@opscrew/connector-github";
import type {
  ApprovalRecord,
  HostingCertificate,
  HostingFiles,
  HostingPanel,
} from "@opscrew/contracts";
import { exists, OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import { detectPhpNeeds } from "@opscrew/detect";
import {
  AGENT_SH,
  RELEASE_SIGNING_KEY_SECRET,
  type RenderedFile,
  renderEnvPhp,
  renderWorkflow,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Requirements, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { hostingDatabaseVariables } from "../design/hosting";
import { commandFlags } from "../environments/choice";
import { missing, setupCloudflare, setupGitHub } from "../provision/credentials";
import { approveLaterHint } from "../provision/plan-apply";
import { deploymentRenderContext } from "../provision/render";
import { buildAppEnvironment, placeDeploySecrets, setDeploySecrets } from "../provision/secrets";
import { deployBranchFor, deploymentRecord, publishDeployment } from "../provision/steps";
import type { ProvisionOptions, ProvisionResult, ProvisionServices } from "../provision/types";
import {
  approvalEntry,
  approveAndWriteRenderedFiles,
  githubClientFromToken,
  PlanRefusedError,
  writePlanIfChanged,
} from "../shared";
import { applyHostingPlan, HostingApplyError, type SigningKeyPair, valuesDigest } from "./apply";
import { applyHostingDns } from "./dns";
import { type HostingAccount, readHostingAccount } from "./facts";
import { connectPanel, hostingFiles, PANEL_NAMES } from "./panels";
import { choosePhp, type PhpChoice, phpRefusal } from "./php";
import {
  describeHostingPlan,
  type HostingPlan,
  type HostingStep,
  hostingPlanFile,
  hostingPlanHash,
  hostingPlanTitle,
  type PanelStepStep,
  panelSteps,
} from "./plan";
import {
  agentContents,
  agentSettingsText,
  buildAgentPlan,
  buildAppPlan,
  committedHostingFolder,
  databaseNames,
  environmentOf,
  type FileContents,
  hostingFolder,
  hostingTarget,
  hostnameOf,
  type PlannedValues,
  removedByUser,
  requireNewHostname,
} from "./provision-plans";
import { reportMisfit, waitForReport } from "./provision-report";
import {
  forgetObject,
  type HostingRecord,
  readHostingRecord,
  recordObject,
  replaceObjects,
} from "./record";
import { sftpFilesFromEnv } from "./sftp";
import { provisionSftp, type SftpProvisionServices } from "./sftp-provision";

/** Collaborators a test replaces. */
export interface HostingProvisionServices extends SftpProvisionServices {
  /**
   * The account's files where the panel's API has none (Plesk's); by default the SFTP connector
   * when the user gives SFTP access (`sftpFilesFromEnv`).
   */
  files?: HostingFiles;
  /** Random bytes for the database's password (default: Node's). */
  randomBytes?: (size: number) => Uint8Array;
  /** A new release signing key pair (default: a new ECDSA P-256 pair from Node). */
  newSigningKey?: () => SigningKeyPair;
}

/** What `opscrew provision` hands a hosting account's flow once its repository checks passed. */
export interface HostingProvisionInput {
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
}

/** How long the panel may take to issue the hostname's certificate (plan 2): 5 minutes. */
const CERTIFICATE_WAIT_MS = 5 * 60 * 1000;
const CERTIFICATE_POLL_MS = 15_000;

/** Waits `ms` (default: a timer). */
const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What one hosting plan's step of provision did. */
interface PlanOutcome {
  plan: HostingPlan;
  hash: string;
  applied: HostingStep["kind"][];
  approval?: ApprovalRecord;
}

/**
 * Provisions an app on a hosting account with a panel (see the module's comment), in this order:
 *
 * 1. The checks, before any change: the account recorded by the interview and its panel, GitHub
 *    (and Cloudflare for its domain), the account's facts, a hostname it serves already and that
 *    OpsCrew didn't make (never taken over), and a way to write the account's files.
 * 2. Plan A: the agent's folder and files and its cron line.
 * 3. The agent's first report, waited for up to 3 minutes; an account that can't run it stops here,
 *    the agent recorded.
 * 4. Plan B: the PHP version in plan 5's order (or the stop of its step 4), the app's values, a new
 *    release signing key (its private half straight to GitHub, `github-secrets`, then its public
 *    half on the account), the database, the hostname and its document root, its PHP, the cron
 *    lines, the certificate's request; the DNS record first when the domain is on Cloudflare (the
 *    IaC approval).
 * 5. GitHub: the agent's read-only deploy key (`github-settings`).
 * 6. Steps the panel's API can't take stop provision after they are listed; a run after the user
 *    took them continues.
 * 7. The certificate, waited for up to 5 minutes; then the workflow, the agent and its settings
 *    in the provision pull request.
 *
 * With `--plan-only` it shows and saves each plan it can make, and changes nothing.
 */
export async function provisionHosting(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: HostingProvisionInput,
  hostingServices: HostingProvisionServices = {},
): Promise<ProvisionResult> {
  const services: ProvisionServices = options.services ?? {};
  const sleep = services.sleep ?? timer;
  const planOnly = options.planOnly === true;
  let plan = input.plan;
  const target = hostingTarget(plan);
  if (target.panel === "sftp") return provisionSftp(deps, options, input, hostingServices);
  const hostname = hostnameOf(plan);
  const environment = environmentOf(plan);
  const folder = hostingFolder(plan);
  const { root } = deps.paths;
  const command = `opscrew provision${await commandFlags(root, deps.paths.environment, deps.paths.app)}`;

  // 1. The checks, before any change.
  deps.reporter.step("Checking your hosting account, GitHub and Cloudflare access");
  const record = await readHostingRecord(deps.paths);
  if (record?.panel === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/plan.yaml deploys the app to a hosting account, but OpsCrew has no record of the account's panel on this computer. Nothing was changed.",
      {
        hint: "Run `opscrew interview`: it finds your panel and records the account in .opscrew/hosting.json. Then run `opscrew design` and `opscrew provision` again.",
      },
    );
  }
  const { panel, url, user } = await connectPanel(deps, record.panel);
  const github = await setupGitHub(deps, input.git, services);
  const client = await githubClientFromToken(deps);
  if (client === undefined) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const cloudflare = await setupCloudflare(deps, plan, services);
  const account = await readHostingAccount(panel, deps.fetch);
  requireNewHostname(account.facts, record, hostname);
  const files = hostingFiles(panel, hostingServices.files ?? sftpFilesFromEnv(deps));
  if (files === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${PANEL_NAMES[panel.kind]}'s API can't write files, so OpsCrew installs its agent on the account over SFTP, and OPSCREW_SFTP_HOST, OPSCREW_SFTP_USER and OPSCREW_SFTP_KEY aren't set. Nothing was changed.`,
      {
        hint: "Set them to the account's SFTP login (OPSCREW_SFTP_KEY is your key file's path), then run `opscrew provision` again.",
      },
    );
  }
  const deployBranch = await deployBranchFor(deps, {
    git: input.git,
    github,
    plan,
    phase: "provision",
    commits: !planOnly,
    push: options.push !== false,
  });
  const repository = `${github.owner}/${github.repo}`;
  const header = {
    panel: panel.kind,
    account: `${user} at ${new URL(url).hostname}`,
    environment,
    hostname,
    folder,
  };
  const laravel = await exists(join(root, plan.app.buildContext, "artisan"));
  const names = databaseNames(target, account.facts);
  const applyContext = {
    panel,
    files,
    otherRoots: account.facts.domains.flatMap((domain) =>
      domain.documentRoot === undefined ? [] : [domain.documentRoot],
    ),
    redactor: deps.redactor,
    warn: (text: string) => deps.reporter.warn(text),
    sleep,
    now: () => deps.clock.now(),
    made: async (object: Parameters<typeof recordObject>[1]) => {
      await recordObject(deps.paths, object);
    },
    forget: async (kind: Parameters<typeof forgetObject>[1], key: string) => {
      await forgetObject(deps.paths, kind, key);
    },
    replace: async (object: Parameters<typeof replaceObjects>[1]) => {
      await replaceObjects(deps.paths, object);
    },
    ...(hostingServices.randomBytes !== undefined
      ? { randomBytes: hostingServices.randomBytes }
      : {}),
    ...(hostingServices.newSigningKey !== undefined
      ? { newSigningKey: hostingServices.newSigningKey }
      : {}),
    ...(names !== undefined ? { database: names } : {}),
  };

  // 2. Plan A: the agent.
  const agentFiles = agentContents(
    agentSettingsText(plan, { repository, laravel, ...(names ? { database: names.name } : {}) }),
    await client.githubSshHostKeys(),
  );
  const agentPlan = await buildAgentPlan({ header, panel, files, record, contents: agentFiles });
  const a = await hostingPlanStep(deps, {
    plan: agentPlan,
    planOnly,
    command,
    apply: (hash) =>
      applyHostingPlan(agentPlan, { ...applyContext, contents: agentFiles, approvedHash: hash }),
  });
  if (planOnly && agentPlan.steps.length > 0) {
    deps.reporter.info(
      "Plan B, the app's part, is built from the agent's first report, so it comes once plan A is applied: run the command without --plan-only.",
    );
    return { applied: false, outputs: {}, ...changingPlans(a) };
  }
  if (stopsForPanelSteps(deps, panel, panelSteps(agentPlan), command)) {
    return { applied: a.applied.length > 0, outputs: {}, ...changingPlans(a) };
  }

  // 3. The agent's first report.
  deps.reporter.step("Waiting for the agent's first report on the account (up to 3 minutes)");
  const report = await waitForReport(files, folder, { sleep });
  const misfit = reportMisfit(report, { database: target.database !== undefined });
  if (misfit !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The hosting account can't run OpsCrew's deploys: ${misfit.reason}. The agent and its cron line are installed and recorded; nothing else was made.`,
      { hint: `${misfit.fix} \`opscrew destroy\` removes the agent.` },
    );
  }

  // 4. Plan B: the app.
  const php = target.app === "php" ? await phpFor(deps, plan, report.php, account) : undefined;
  if (php !== undefined) {
    plan = { ...plan, target: { ...target, php: { version: php.version, via: php.via } } };
    deps.reporter.info(phpText(php, account));
  }
  const values = await plannedValues(deps, plan, services);
  const settings = agentSettingsText(plan, {
    repository,
    laravel,
    ...(php !== undefined ? { php } : {}),
    ...(names !== undefined ? { database: names.name } : {}),
  });
  const appFiles: FileContents = new Map([["settings.sh", settings]]);
  if (target.app === "php" && !laravel && values !== undefined) {
    appFiles.set(
      "shared/env.php",
      renderEnvPhp([...Object.keys(values.values), ...values.database].sort()),
    );
  }
  // The cron lines the user removed in the panel since the last run, as it asked, are gone.
  if (!planOnly) {
    for (const key of removedByUser(await readHostingRecord(deps.paths))) {
      await forgetObject(deps.paths, "panel-step", key);
    }
  }
  const current = await readHostingRecord(deps.paths);
  const appPlan = await buildAppPlan({
    header,
    plan,
    panel,
    files,
    record: current,
    facts: account.facts,
    php,
    values,
    contents: appFiles,
  });
  const dns =
    cloudflare === undefined
      ? undefined
      : await applyHostingDns(deps, options, {
          plan,
          requirements: input.requirements,
          github,
          cloudflare,
          address: accountAddress(account),
          command,
        });
  const b = await hostingPlanStep(deps, {
    plan: appPlan,
    planOnly,
    command,
    apply: (hash) =>
      applyHostingPlan(appPlan, {
        ...applyContext,
        contents: appFiles,
        ...(values !== undefined ? { values: values.values } : {}),
        storeSigningKey: async (privatePem: string) => {
          plan = (
            await placeDeploySecrets(deps, github, plan, { command, phase: "provision", planOnly })
          ).plan;
          await setDeploySecrets(
            deps,
            github,
            plan,
            { [RELEASE_SIGNING_KEY_SECRET]: privatePem },
            [],
            "provision",
            {
              about:
                "The key that signs the app's releases (ECDSA P-256): the agent on the account deploys only releases signed with it.",
              refusedState: "The account's key and the releases it accepts are as they were.",
            },
          );
        },
        approvedHash: hash,
      }),
  });
  if (planOnly) {
    return {
      applied: false,
      outputs: {},
      ...(dns?.planHash ? { planHash: dns.planHash } : {}),
      ...changingPlans(a, b),
    };
  }

  // 5. GitHub: the agent's deploy key.
  const after = (await readHostingRecord(deps.paths)) as HostingRecord;
  await addDeployKey(deps, client, github, {
    after,
    publicKey: report.publicKey,
    title: `opscrew-${folder.slice("opscrew/".length)}`,
  });
  // 6. Steps in the panel.
  if (stopsForPanelSteps(deps, panel, panelSteps(appPlan), command)) {
    await writePlanIfChanged(deps, plan);
    return { applied: true, outputs: {}, ...changingPlans(a, b) };
  }

  // 7. The certificate, then the files and the pull request.
  const waits = appPlan.steps.some(
    (step) => step.kind === "hostname" || step.kind === "certificate",
  );
  const certificate = await certificateOf(deps, panel, hostname, waits ? sleep : undefined);
  const own = ownCertificateId(certificate, hostname);
  if (own !== undefined) await recordObject(deps.paths, { kind: "certificate", key: own });
  const approvals = [a.approval, b.approval, dns?.approval].flatMap((approval) =>
    approval === undefined ? [] : [approvalEntry(approval)],
  );
  plan = deploymentRecord(deps, {
    plan,
    url: `https://${hostname}`,
    iac: dns ?? { applied: false },
    approvals,
  })(a.applied.length > 0 || b.applied.length > 0);
  const ctx = await deploymentRenderContext(deps, {
    plan,
    requirements: input.requirements,
    github,
    deployPublicKey: "",
    cloudflare,
  });
  const committed = committedHostingFolder(plan);
  const rendered: RenderedFile[] = [
    renderWorkflow(plan, ctx),
    { path: `${committed}/agent.sh`, content: AGENT_SH, kind: "runtime", mode: 0o755 },
    { path: `${committed}/${environment}.sh`, content: settings, kind: "runtime" },
    ...(dns?.files ?? []),
  ];
  await approveAndWriteRenderedFiles(deps, root, rendered, {
    refused:
      "The account is set up, but the workflow wasn't written, so nothing deploys yet. Run `opscrew provision` again to write it.",
  });
  const published = await publishDeployment(deps, {
    git: input.git,
    github,
    plan,
    files: rendered.map((file) => file.path),
    push: options.push !== false,
    secretsStored: true,
    phase: "provision",
    branch: deployBranch,
    dependabot: undefined,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  if (published.published.prUrl) {
    deps.reporter.info(
      `Merging ${published.published.prUrl} deploys the app: GitHub Actions builds each release and the agent on the account switches to it within about a minute.`,
    );
  }
  return {
    ...(dns?.planHash ? { planHash: dns.planHash } : {}),
    ...changingPlans(a, b),
    applied: true,
    outputs: { url: `https://${hostname}` },
    branch: published.published.branch,
    base: published.published.base,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
    published: published.published.published,
    pushed: published.published.pushed,
  };
}

/** `hostingPlanHashes`: the hash of each of `outcomes`' plans that changes something, in order. */
function changingPlans(...outcomes: PlanOutcome[]): Pick<ProvisionResult, "hostingPlanHashes"> {
  const hashes = outcomes.flatMap((outcome) =>
    outcome.plan.steps.length > 0 ? [outcome.hash] : [],
  );
  return hashes.length > 0 ? { hostingPlanHashes: hashes } : {};
}

/**
 * A hosting plan shown, saved in `.opscrew/plans/hosting-<env>-{agent,app}.json` when it changes
 * something, approved by its hash (`hosting-apply`; `--yes` never grants it), then applied, with an
 * audit entry for the start, each change and a failure. With `planOnly` it is only shown and saved.
 */
async function hostingPlanStep(
  deps: PhaseDeps,
  input: {
    plan: HostingPlan;
    planOnly: boolean;
    command: string;
    apply: (hash: string) => ReturnType<typeof applyHostingPlan>;
  },
): Promise<PlanOutcome> {
  const { plan, command } = input;
  const hash = hostingPlanHash(plan);
  const details = describeHostingPlan(plan, hash);
  const which = plan.plan === "agent" ? "Hosting plan A (the agent)" : "Hosting plan B (the app)";
  deps.reporter.info(details);
  if (plan.steps.length === 0) {
    deps.reporter.success(`${which} has nothing to change: the account is as planned.`);
    return { plan, hash, applied: [] };
  }
  await writeFileAtomic(
    hostingPlanFile(deps.paths, plan.environment, plan.plan),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  if (input.planOnly) {
    deps.reporter.info(`Saved ${which} (hash ${hash}); nothing on the account was changed.`);
    return { plan, hash, applied: [] };
  }
  const approval = await deps.approvals.request({
    kind: "hosting-apply",
    title: hostingPlanTitle(plan),
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: which,
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing on the account was changed by it.",
      hint: approveLaterHint(command, hash),
    });
  }
  await deps.approvals.assertApprovedHostingPlan(hash);
  deps.reporter.step(
    `Changing the ${PANEL_NAMES[plan.panel]} account (${plural(plan.steps.length, "change")})`,
  );
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: "provision",
      target: hash,
      decision,
      detail,
    });
  await audit(
    "hosting apply started",
    "approved",
    `${plan.plan}: ${plan.steps.map((step) => step.kind).join(", ")}`,
  );
  let result: Awaited<ReturnType<typeof applyHostingPlan>>;
  try {
    result = await input.apply(hash);
  } catch (error) {
    const done = error instanceof HostingApplyError ? error.applied : [];
    for (const kind of changed(done)) await audit(`hosting change ${kind}`, "approved", plan.plan);
    await audit(
      "hosting apply failed",
      "refused",
      `steps applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const kind of changed(result.applied)) {
    await audit(`hosting change ${kind}`, "approved", plan.plan);
  }
  deps.reporter.success(`Applied ${which} (${plural(result.applied.length, "change")}).`);
  return {
    plan,
    hash,
    applied: result.applied,
    approval,
  };
}

/** The steps that changed the account: a panel step is the user's to take. */
const changed = (kinds: readonly HostingStep["kind"][]) =>
  kinds.filter((kind) => kind !== "panel-step");

/**
 * When `steps` (the panel's API can't take them) were listed: says what the user does in the panel
 * and stops provision there; a run after the user took them continues.
 */
function stopsForPanelSteps(
  deps: PhaseDeps,
  panel: HostingPanel,
  steps: readonly PanelStepStep[],
  command: string,
): boolean {
  if (steps.length === 0) return false;
  const name = PANEL_NAMES[panel.kind];
  deps.reporter.warn(
    [
      `${name}'s API can't do ${steps.length === 1 ? "this step" : "these steps"}, so do ${steps.length === 1 ? "it" : "them"} in ${name}, then run \`${command}\` again to continue:`,
      ...steps.map(
        ({ step }) =>
          `  - ${step.what}${step.value === undefined ? "" : `: ${step.value}`} (${step.where})`,
      ),
    ].join("\n"),
  );
  return true;
}

/** The hostname's PHP from the report (plan 5), or provision's stop (its step 4). */
async function phpFor(
  deps: PhaseDeps,
  plan: DeployPlan,
  binaries: Parameters<typeof choosePhp>[0]["binaries"],
  account: HostingAccount,
): Promise<PhpChoice> {
  const needs = await detectPhpNeeds(deps.paths.root, plan.app.buildContext);
  const input = {
    needs,
    binaries,
    panel: account.facts.panel,
    phpPerHostname: account.facts.phpPerHostname,
    ...(account.webServer !== undefined ? { webServer: account.webServer } : {}),
  };
  const choice = choosePhp(input);
  if (choice === undefined) throw phpRefusal(input);
  return choice;
}

/** What provision says of the hostname's PHP. */
function phpText(php: PhpChoice, account: HostingAccount): string {
  const how =
    php.via === "account"
      ? "the account's own version"
      : php.via === "handler"
        ? `CloudLinux's PHP ${php.version} through the hostname's handler line, on ${account.webServer ?? "LiteSpeed"} (only that version's default extensions load)`
        : php.panelStep === true
          ? `set for the hostname in ${PANEL_NAMES[account.facts.panel]}, which you do there`
          : "set for the hostname through MultiPHP";
  return `PHP: the app gets PHP ${php.version}, ${how}; its release command and cron jobs run with ${php.cli}.`;
}

/**
 * The app's values for its settings file: the user's, generated and derived ones as
 * `buildAppEnvironment` makes them (a non-interactive run reads `OPSCREW_APP_ENV_FILE`), without
 * those the account's database fills, which the apply adds. `undefined` for a static site.
 */
async function plannedValues(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
): Promise<PlannedValues | undefined> {
  const target = hostingTarget(plan);
  if (target.app === "static") return undefined;
  const { facts } = await readArtifact("architecture", deps.paths.files.architecture);
  const filled = hostingDatabaseVariables(facts, target);
  const own = {
    ...plan,
    app: { ...plan.app, env: plan.app.env.filter((v) => !filled.has(v.name)) },
  };
  const environment = await buildAppEnvironment(deps, own, services);
  const values = environment.values.app;
  const database = [...filled.keys()].sort();
  return {
    values,
    database,
    generated: [
      ...Object.keys(environment.generated.env ?? {}),
      ...database.filter((name) => filled.get(name) === true),
    ].sort(),
    digest: valuesDigest(values),
  };
}

/** The account's IPv4 address for the DNS record. */
function accountAddress(account: HostingAccount): string {
  const address = account.facts.addresses.find((candidate) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(candidate),
  );
  if (address === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "The panel doesn't name the account's IPv4 address, so OpsCrew can't point the hostname at it.",
      {
        hint: "Add an A record from the hostname to the account's address (the panel shows it) in Cloudflare yourself, or ask your host for it; then run `opscrew provision` again.",
      },
    );
  }
  return address;
}

/**
 * The agent's read-only GitHub deploy key, added after a `github-settings` approval unless OpsCrew
 * added this key already; recorded with GitHub's id. A key OpsCrew added for an earlier key of the
 * agent's (it made a new one) is removed from GitHub in the same change and forgotten.
 */
async function addDeployKey(
  deps: PhaseDeps,
  client: Pick<GitHubClient, "addDeployKey" | "removeDeployKey">,
  github: { owner: string; repo: string },
  input: { after: HostingRecord; publicKey: string; title: string },
): Promise<void> {
  const body = input.publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  const earlier = input.after.objects.filter((o) => o.kind === "deploy-key");
  if (earlier.some((o) => o.value === body)) return;
  const repository = `${github.owner}/${github.repo}`;
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Add the hosting agent's read-only deploy key to ${repository}`,
    details: [
      `Deploy key ${input.title} (read-only): ${body}`,
      "The agent on the hosting account made it and keeps its private half there; it fetches the signed releases with it and can't push.",
      ...(earlier.length > 0
        ? [
            `It replaces the agent's earlier key, which OpsCrew removes from ${repository} (GitHub's id ${earlier.map((o) => o.key).join(", ")}).`,
          ]
        : []),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The agent's deploy key wasn't added, so it can't fetch releases yet. The account is set up.",
      { hint: "Run `opscrew provision` again when you are ready; it continues from here." },
    );
  }
  const added = await client.addDeployKey(github.owner, github.repo, input.title, input.publicKey);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `add deploy key ${input.title}`,
    phase: "provision",
    target: repository,
    decision: "approved",
  });
  for (const old of earlier) {
    await client.removeDeployKey(github.owner, github.repo, Number(old.key));
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `remove deploy key ${old.key}`,
      phase: "provision",
      target: repository,
      decision: "approved",
    });
  }
  await replaceObjects(deps.paths, { kind: "deploy-key", key: String(added.id), value: body });
  deps.reporter.success(`Added the agent's read-only deploy key to ${repository}.`);
}

/**
 * The hostname's certificate: with `sleep`, waited for up to 5 minutes (the panel issues it once
 * the hostname points at the account); what is left is said either way. `undefined` where the
 * panel's API can't read it.
 */
/**
 * The installed certificate's id when OpsCrew may count it as its own: it names nothing but the
 * hostname and `www.` of it (R13). A wildcard, a certificate shared with other hosts, or one whose
 * names the panel doesn't give is the account's, never recorded, so never removed.
 */
export function ownCertificateId(
  certificate: HostingCertificate | undefined,
  hostname: string,
): string | undefined {
  if (certificate?.installed !== true || certificate.id === undefined) return undefined;
  const host = hostname.toLowerCase();
  const names = certificate.names ?? [];
  const own = names.every((name) => [host, `www.${host}`].includes(name.toLowerCase()));
  return names.length > 0 && own ? certificate.id : undefined;
}

async function certificateOf(
  deps: PhaseDeps,
  panel: HostingPanel,
  hostname: string,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<HostingCertificate | undefined> {
  const name = PANEL_NAMES[panel.kind];
  let certificate = await panel.certificate(hostname);
  for (
    let waited = 0;
    sleep !== undefined &&
    certificate !== undefined &&
    !certificate.installed &&
    certificate.problem === undefined &&
    waited < CERTIFICATE_WAIT_MS;
    waited += CERTIFICATE_POLL_MS
  ) {
    if (waited === 0) deps.reporter.step(`Waiting for ${hostname}'s certificate (up to 5 minutes)`);
    await sleep(CERTIFICATE_POLL_MS);
    certificate = await panel.certificate(hostname);
  }
  const forced = "the agent forces HTTPS once it sees a valid certificate there";
  if (certificate === undefined) {
    deps.reporter.info(
      `${name}'s API doesn't show certificates: check ${hostname}'s free certificate in ${name}; ${forced}.`,
    );
  } else if (certificate.installed) {
    deps.reporter.success(`${hostname}'s certificate is installed; ${forced}.`);
  } else {
    deps.reporter.warn(
      `${hostname} has no certificate yet${certificate.problem === undefined ? "" : `: ${certificate.problem}`}. Until it has one, the app answers over HTTP; ${forced}. Check that the hostname points at the account, and ${name}'s certificate page.`,
    );
  }
  return certificate;
}
