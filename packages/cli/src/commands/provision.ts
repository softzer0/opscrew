import path from "node:path";
import {
  applyCommand,
  approveLaterHint,
  findSavedPlan,
  HOST_KEY_FINGERPRINT,
  isRemovalLiftRequest,
  type PhaseDeps,
  type ProvisionOptions,
  type ProvisionResult,
  portainerImageOptions,
  REGISTRY_TOKEN_VAR,
  REPLACEABLE_TOKENS,
  REPOSITORY_TOKEN_VAR,
  type ReplaceableToken,
  type RunProvisionOptions,
  readSavedPlanChanges,
  removalConfirmPhrase,
  runProvision,
  type SavedPlanKind,
  SOPS_CONFIG_PATH,
  savedLocalPlanChanges,
  stackFollowsReason,
  stringOutput,
} from "@opscrew/agents";
import type { ApprovalHandler, Clock } from "@opscrew/contracts";
import { approvalDecision, exists, isPlanHash, OpsCrewError, toPosixRelative } from "@opscrew/core";
import {
  type DeployPlan,
  isServerlessProvider,
  readArtifact,
  ServerNameSchema,
} from "@opscrew/plan-schema";
import { type Command, InvalidArgumentError, Option } from "commander";
import {
  APPROVE_BY_HASH_KINDS,
  checkConfirmName,
  FlagConfirmation,
  formatRequest,
  withAllowDowntime,
} from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import {
  assumeYesHint,
  collect,
  type PlannedHash,
  printPlanHashes,
  runPhaseCommand,
} from "../ui/deploy";
import { createEnvPrompt } from "../ui/env-prompt";
import { addEnvOption, type ChosenEnvironment, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { cancelled, type UiPrompts } from "../ui/prompts";
import { recoveryOptions, userPath } from "../ui/recovery";
import { createStorageKeyPrompt } from "../ui/storage-key-prompt";

/** Flags shared by `provision` and `dns`. */
export interface InfraFlags {
  planOnly?: boolean;
  /** Every `--approve <hash>` (repeatable: on a server the user owns, one per plan). */
  approve?: string[];
  engine?: "tofu" | "terraform";
  /** False with `--no-push` (`dns` has no such flag, so it stays undefined there). */
  push?: boolean;
  yes?: boolean;
  /** `--host-key SHA256:…`: the fingerprint of the user's own server, for its first connection. */
  hostKey?: string;
  /** `--password-logins off|keep` (`provision` only): the choice a server with password users needs. */
  passwordLogins?: "off" | "keep";
  /**
   * Every `--confirm <name>` (`provision` only), for a plan that removes something: the app's
   * name, and each extra server it deletes by its name at the provider (`<app>-<server>`); with
   * `--finish-move`, the moved service's name.
   */
  confirm?: string[];
  /** `--public-image` (`provision` only): the user's Portainer pulls a public image, no registry entry. */
  publicImage?: boolean;
  /** `--private-image` (`provision` only): switch a remembered public image back to private. */
  privateImage?: boolean;
  /** `--replace-token repository|registry` (`provision` only, repeatable): send a rotated token again. */
  replaceToken?: ReplaceableToken[];
  /** `--key-out <path>` (`provision` only): the file the recovery copy's first age key goes to. */
  keyOut?: string;
  /** `--pages-verification <value>` (`provision` only): GitHub's domain verification value. */
  pagesVerification?: string;
  /** `--allow-downtime` (`provision` only): a script approves a move's maintenance window. */
  allowDowntime?: boolean;
  /** `--finish-move` (`provision` only): delete a moved service's old copy, and nothing else. */
  finishMove?: boolean;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
}

/**
 * GitHub Pages: the question for the value of GitHub's domain verification record, which GitHub
 * shows only on its settings `page` once the domain is added there. It is public in DNS, so the
 * answer is shown as typed.
 */
function pagesVerificationPrompt(
  prompts: UiPrompts,
): NonNullable<ProvisionOptions["services"]>["askPagesVerification"] {
  return async ({ domain, page }) => {
    const answer = await prompts.text({
      message: `GitHub's verification value for ${domain}: on ${page}, click "Add a domain", enter ${domain} and paste the value of the TXT record GitHub shows (leave Verify for later)`,
    });
    if (prompts.isCancel(answer)) throw cancelled("provisioning", "opscrew provision");
    return answer;
  };
}

/**
 * The scheduled check's webhook address, asked with hidden input (it is a secret); cancelling
 * leaves it unset, which provision says.
 */
function checkWebhookPrompt(
  prompts: UiPrompts,
): NonNullable<ProvisionOptions["services"]>["askCheckWebhook"] {
  return async ({ prompt }) => {
    const answer = await prompts.password({ message: prompt });
    return prompts.isCancel(answer) ? undefined : answer;
  };
}

/** Commander parser of the repeatable `--replace-token repository|registry`. */
function collectToken(value: string, previous: ReplaceableToken[] | undefined): ReplaceableToken[] {
  const token = value.trim().toLowerCase();
  if (!(REPLACEABLE_TOKENS as readonly string[]).includes(token)) {
    throw new InvalidArgumentError(
      `Allowed choices are ${REPLACEABLE_TOKENS.join(", ")} (the repository token ${REPOSITORY_TOKEN_VAR} or the registry token ${REGISTRY_TOKEN_VAR}).`,
    );
  }
  const all = [...(previous ?? []), token as ReplaceableToken];
  return [...new Set(all)];
}

/**
 * `--public-image` (true) or `--private-image` (false), absent when neither was given so the
 * remembered choice applies. Both together are refused.
 */
function imageChoice(flags: Pick<InfraFlags, "publicImage" | "privateImage">): boolean | undefined {
  if (flags.publicImage === true && flags.privateImage === true) {
    throw new OpsCrewError("INVALID_INPUT", "Use either --public-image or --private-image.", {
      hint: "--public-image says the app's image on GitHub Container Registry is public (Portainer pulls it without a registry entry); --private-image switches back to a registry entry with a read-only token.",
    });
  }
  if (flags.publicImage === true) return true;
  return flags.privateImage === true ? false : undefined;
}

/** Help text of `--yes` for the commands that write files, secrets and pull requests. */
export const YES_DESCRIPTION =
  "In a non-interactive run, approve writing the generated files, storing GitHub secrets, pushing and the pull request (infrastructure and host changes still need --approve <hash>)";

/** Help text of `--approve <hash>`, which may be given once per plan. */
export const APPROVE_DESCRIPTION =
  "Apply exactly the plan with this hash (from an earlier --plan-only run); give it once per plan (the Cloudflare plan of OpsCrew's shared rules and the infrastructure plan; on your own server also the host plan; in your Portainer also the stack plan; on GitHub Pages also the Pages plan and the plan of GitHub's verification record; with a runner machine also its host plan)";

/** Adds `--plan-only` and the repeatable `--approve <hash>` to `command`. */
export function addPlanApproveOptions(command: Command): Command {
  return command
    .option("--plan-only", "Plan, run the policy checks and print the plan hash; change nothing")
    .option("--approve <hash>", APPROVE_DESCRIPTION, collect);
}

/** `--engine tofu|terraform`, the infrastructure engine to use instead of the plan's. */
export function engineOption(): Option {
  return new Option(
    "--engine <name>",
    "Infrastructure engine to use instead of the plan's",
  ).choices(["tofu", "terraform"]);
}

/**
 * The next step once the deployment is gone (the plan and the repository files stay); `flag` is
 * the environment's ` --env <name>` ({@link ChosenEnvironment}).
 */
export function deployAgainStep(flag: string): string {
  return `run \`opscrew provision${flag}\` to deploy again (the plan and the repository files are kept).`;
}

/** The next step once the deploy run has finished, or with nothing to wait for: check the site. */
function verifyStep(flag: string, runbook: string, deploys: boolean): string {
  const check = `run \`opscrew verify${flag}\` to check the live site and write ${runbook}.`;
  return deploys ? `when the deploy run in GitHub Actions has finished, ${check}` : check;
}

/** The next step for a server: check its hardening (`report` is the environment's report). */
export function secureServerStep(flag: string, report: string): string {
  return `run \`opscrew secure${flag}\` to check the server's hardening and write ${report}.`;
}

/** The next step for a site on Cloudflare's hosting or GitHub Pages: check its headers. */
export function secureSiteStep(flag: string, report: string): string {
  return `run \`opscrew secure${flag}\` to check the site's security headers and write ${report}.`;
}

/** Adds `--host-key <fingerprint>` (a server the user owns) to `command`. */
export function addHostKeyOption(command: Command): Command {
  return command.option(
    "--host-key <fingerprint>",
    "Your own server: trust this SSH host key fingerprint (SHA256:…) on the first connection, for scripts; check it on the server first",
  );
}

/**
 * Checks `--approve` values (each a 64-character SHA-256 hash, not together with `--plan-only`)
 * and `--host-key` (a `SHA256:…` fingerprint) before anything runs. `shows` is the command that
 * prints the plan's hash (default: `opscrew <command> --plan-only`). Returns the trimmed hashes.
 */
export function checkApproveFlags(
  command: string,
  flags: { planOnly?: boolean; approve?: string[]; hostKey?: string },
  shows = `opscrew ${command} --plan-only`,
): string[] {
  const hashes = (flags.approve ?? []).map((hash) => hash.trim());
  if (flags.planOnly === true && hashes.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", "Use either --plan-only or --approve <hash>.", {
      hint: `Run \`opscrew ${command} --plan-only\` to see the plan and its hash, then \`opscrew ${command} --approve <hash>\` to apply it.`,
    });
  }
  if (hashes.some((hash) => !isPlanHash(hash))) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--approve expects the 64-character SHA-256 plan hash that OpsCrew printed.",
      { hint: `Run \`${shows}\` to get the hash of the current plan.` },
    );
  }
  const hostKey = flags.hostKey?.trim();
  if (hostKey !== undefined && !HOST_KEY_FINGERPRINT.test(hostKey)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--host-key expects the server's SHA-256 host key fingerprint: SHA256: followed by 43 letters, digits, + or /.",
      {
        hint: "Read it on the server itself, for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, and pass the SHA256:… part.",
      },
    );
  }
  return hashes;
}

/** What to do about a damaged saved host or stack plan in the terminal. */
const DAMAGED_PLAN_HINT: Record<SavedPlanKind, string> = {
  host: "Run the command with --plan-only again to save a new host plan, then approve its hash.",
  stack:
    "Run `opscrew provision --plan-only` again to save a new stack plan, then approve its hash.",
};

/**
 * True when the saved host or stack plan `hash` changes something (so it needs its own approval);
 * false when no such plan was saved. A damaged one stops (see `readSavedPlanChanges`).
 */
export async function planChanges(
  deps: Pick<PhaseDeps, "paths">,
  kind: SavedPlanKind,
  hash: string,
): Promise<boolean> {
  return (await readSavedPlanChanges(deps.paths, kind, hash, DAMAGED_PLAN_HINT[kind])) === true;
}

/** True when `name` is the name at its provider of an extra server of the app `app`: `<app>-<server>`. */
function extraServerName(app: string, name: string): boolean {
  return (
    name.startsWith(`${app}-`) && ServerNameSchema.safeParse(name.slice(app.length + 1)).success
  );
}

/** `opscrew dns` for an environment on this computer, which has no DNS to set. */
function localhostHasNoDns(environment: ChosenEnvironment): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${environment.name} environment runs on this computer, which has no DNS: its https://<app>.localhost address needs no record, since this computer answers .localhost names itself. Nothing was changed.`,
    {
      hint: `Run \`opscrew provision${environment.flag}\` to run it on this computer; \`opscrew dns\` is for an environment on a server or in your Portainer.`,
    },
  );
}

/**
 * In a script's `--confirm` run that lifts, then only plans: approves the delete protection lift
 * (`isRemovalLiftRequest`, whose servers provision checked against `names` before planning it), the
 * only infrastructure change such a run applies; every other request goes to `base`.
 */
function removalLiftApproval(
  base: ApprovalHandler,
  names: readonly string[],
  print: (text: string) => void,
  clock: Clock,
): ApprovalHandler {
  const flags = names.map((name) => `--confirm ${name}`).join(" ");
  return {
    request: async (request) => {
      if (!isRemovalLiftRequest(request)) return base.request(request);
      print(formatRequest(request));
      print(`  ✓ ${request.title} (confirmed with ${flags})\n`);
      return approvalDecision(clock, "--confirm flags", true);
    },
  };
}

/**
 * Runs `provision` or `dns` from the command line: checks the flags, builds the phase deps (with
 * the `--approve <hash>` / `--yes` approval handler when no human is present and the terminal
 * prompt for production values when one is), runs the phase, maps errors to exit codes 1/2 and
 * prints the plan hashes or the next steps. On a server the user owns there are two plans (the
 * infrastructure and the host plan), each with its own hash and approval.
 *
 * In a script, `provision --confirm …` with neither `--plan-only` nor `--approve` lifts the delete
 * protection of the removed extra servers the names cover (`liftConfirmedBy`), then runs as
 * `--plan-only`: it plans their deletion and prints the `--approve <hash> … --confirm …` command.
 */
export async function runInfraCommand(
  ctx: CliContext,
  command: "provision" | "dns",
  flags: InfraFlags,
  run: (deps: PhaseDeps, options: RunProvisionOptions) => Promise<ProvisionResult>,
): Promise<void> {
  const liftRun =
    command === "provision" &&
    !ctx.isInteractive &&
    flags.planOnly !== true &&
    (flags.confirm ?? []).length > 0 &&
    (flags.approve ?? []).length === 0;
  const planOnly = flags.planOnly === true || liftRun;
  // A wrong `--confirm` name is its own error, not a missing `--yes`.
  let wrongName = false;
  const yesHint = assumeYesHint(ctx, flags.yes, command);
  let flag = "";
  const result = await runPhaseCommand(
    ctx,
    async () => {
      const hashes = checkApproveFlags(command, flags);
      const publicImage = imageChoice(flags);
      const hostKey = flags.hostKey?.trim();
      const confirms = (flags.confirm ?? []).map((value) => value.trim());
      const environment = await chooseEnvironment(ctx, flags, command);
      flag = environment.flag;
      const planFile = createPhaseDeps(ctx, {
        ai: false,
        app: environment.app,
        environment: environment.name,
      }).paths.files.plan;
      if (command === "dns") {
        const plan = await readArtifact("plan", planFile).catch(() => undefined);
        if (plan?.target.provider === "localhost") throw localhostHasNoDns(environment);
      }
      // `--confirm` exists on `provision` only; without a plan the phase explains what to run.
      const app =
        command === "provision"
          ? await readArtifact("plan", planFile)
              .then((plan) => plan.app.name)
              .catch((error: unknown) => {
                if (confirms.length > 0) throw error;
                return undefined;
              })
          : undefined;
      if (app !== undefined) {
        // The app's name, or the name at the provider of an extra server the plan deletes.
        const wrong = confirms.find((value) => value !== app && !extraServerName(app, value));
        wrongName = wrong !== undefined;
        checkConfirmName(
          wrong,
          app,
          "the app's name",
          `To apply a plan that deletes or replaces resources in a script, run \`opscrew ${command}${flag} --approve <hash> … --confirm ${app}\`, with \`--confirm ${app}-<server>\` for each extra server it deletes, as the --plan-only run prints.`,
        );
      }
      const deps = createPhaseDeps(ctx, {
        ai: false,
        app: environment.app,
        environment: environment.name,
        approveHashes: hashes,
        ...(flags.yes === true ? { assumeYes: true } : {}),
        wrapApprovals: (base, clock) => {
          const typedNames =
            app === undefined
              ? base
              : new FlagConfirmation(base, {
                  kinds: APPROVE_BY_HASH_KINDS,
                  what: "a plan that deletes or replaces resources",
                  names: confirms,
                  hashes,
                  interactive: ctx.isInteractive,
                  print: ctx.stdout,
                  clock,
                });
          const lift = liftRun
            ? removalLiftApproval(typedNames, confirms, ctx.stdout, clock)
            : typedNames;
          return withAllowDowntime(ctx, flags.allowDowntime, lift, clock);
        },
      });
      const result = await run(deps, {
        ...(planOnly ? { planOnly: true } : {}),
        ...(liftRun ? { liftConfirmedBy: confirms } : {}),
        ...(hashes.length === 0 ? {} : { approveHashes: hashes }),
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(flags.push === false ? { push: false } : {}),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(flags.passwordLogins === undefined ? {} : { passwordLogins: flags.passwordLogins }),
        ...portainerImageOptions(publicImage, flags.replaceToken),
        ...(command === "provision" ? recoveryOptions(ctx, flags.keyOut) : {}),
        ...(flags.pagesVerification === undefined
          ? {}
          : { pagesVerification: flags.pagesVerification }),
        services: {
          ...(ctx.isInteractive
            ? {
                askEnv: createEnvPrompt(promptsOf(ctx), flag),
                askCheckWebhook: checkWebhookPrompt(promptsOf(ctx)),
                askStorageKey: createStorageKeyPrompt(promptsOf(ctx), ctx.stdout),
                askPagesVerification: pagesVerificationPrompt(promptsOf(ctx)),
              }
            : {}),
          ...servicesOf(ctx).provision,
        },
      });
      const plan = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
      const own = plan?.target.provider === "own";
      const portainer = plan?.target.provider === "portainer";
      // Cloudflare's hosting or GitHub Pages: no server.
      const site = plan !== undefined && isServerlessProvider(plan.target.provider);
      const planned: PlannedHash[] = [];
      // The names a plan that deletes needs typed: the app's, and each extra server it deletes.
      const confirmNames = new Set<string>();
      const named = app ?? plan?.app.name;
      // Why the stack plan comes in a later run, when it does.
      let stackFollows: string | undefined;
      if (planOnly) {
        // OpsCrew's shared Cloudflare resources change first: their plan is approved by its hash too.
        if (result.cloudflarePlanHash !== undefined) {
          planned.push({ label: "Cloudflare plan", hash: result.cloudflarePlanHash });
          // Deleting OpsCrew's rule needs the app's name, like an infrastructure plan that deletes.
          if (result.cloudflarePlanDeletes === true && named !== undefined) confirmNames.add(named);
        }
        // The app's bucket at a provider has a plan of its own.
        if (result.storagePlanHash !== undefined) {
          planned.push({ label: "bucket (object storage)", hash: result.storagePlanHash });
        }
        const saved =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(deps.paths.files.plansDir, result.planHash);
        if (result.planHash !== undefined && saved !== undefined) {
          if (saved.hasDestroy && named !== undefined) {
            // The extra servers the plan deletes by their names at the provider (`<app>-<server>`).
            const phrase = plan === undefined ? named : removalConfirmPhrase(plan, saved);
            for (const name of phrase.split(" ")) confirmNames.add(name);
          }
          planned.push({
            label: own || portainer || site ? "infrastructure (Cloudflare)" : "infrastructure",
            hash: result.planHash,
          });
        }
        if (
          result.hostPlanHash !== undefined &&
          (await planChanges(deps, "host", result.hostPlanHash))
        ) {
          planned.push({ label: "host plan for your server", hash: result.hostPlanHash });
        }
        // The scheduled check's key on a server that exists: a host plan of its own.
        if (result.checkKeyPlanHash !== undefined) {
          planned.push({
            label: "host plan for the scheduled check's key",
            hash: result.checkKeyPlanHash,
          });
        }
        if (
          result.stackPlanHash !== undefined &&
          (await planChanges(deps, "stack", result.stackPlanHash))
        ) {
          planned.push({ label: "stack plan for your Portainer", hash: result.stackPlanHash });
        }
        // GitHub Pages: the site's settings, and GitHub's verification record in a root of its own.
        if (result.pagesPlanHash !== undefined) {
          planned.push({ label: "Pages plan for GitHub Pages", hash: result.pagesPlanHash });
        }
        if (result.pagesVerificationPlanHash !== undefined) {
          planned.push({
            label: "GitHub's domain verification record",
            hash: result.pagesVerificationPlanHash,
          });
        }
        // The runner machines: the environment's runner off each machine it left, then on its own.
        for (const hash of result.runnerHostPlanHashes ?? []) {
          if (await planChanges(deps, "host", hash)) {
            planned.push({ label: "host plan for a runner machine", hash });
          }
        }
        // The app's servers (feature 018): each extra server's setup and each private network.
        for (const hash of result.serverHostPlanHashes ?? []) {
          if (await planChanges(deps, "host", hash)) {
            planned.push({ label: "host plan for one of the app's servers", hash });
          }
        }
        if (portainer) stackFollows = stackFollowsReason(result, saved !== undefined);
        // This computer: the local plan, approved by its hash like a host plan.
        if (
          result.localPlanHash !== undefined &&
          (await savedLocalPlanChanges(
            deps.paths,
            result.localPlanHash,
            `Run \`opscrew provision${flag} --plan-only\` again to save a new local plan, then approve its hash.`,
          ))
        ) {
          planned.push({ label: "local plan for this computer", hash: result.localPlanHash });
        }
      }
      return {
        result,
        planned,
        own,
        portainer,
        site,
        plan,
        runbook: toPosixRelative(deps.paths.root, deps.paths.files.runbook),
        securityReport: toPosixRelative(deps.paths.root, deps.paths.files.securityReport),
        stackFollows,
        publicImage,
        confirmNames:
          command === "provision" && confirmNames.size > 0 ? [...confirmNames] : undefined,
        // No `opscrew/.sops.yaml` yet: the apply makes the recovery copy's first key.
        keyWanted:
          planOnly &&
          command === "provision" &&
          flags.keyOut === undefined &&
          !(await exists(path.join(deps.paths.root, SOPS_CONFIG_PATH))),
        // `opscrew dns` has no --confirm: a deleting plan is approved in a terminal or by provision.
        dnsDeletes: confirmNames.size > 0 && command === "dns" ? plan?.app.name : undefined,
      };
    },
    (error) => (wrongName ? undefined : yesHint(error)),
  );

  const { outputs, applied } = result.result;
  if (planOnly) {
    if (result.planned.length > 0) {
      if (result.dnsDeletes !== undefined) {
        // `opscrew dns` has no --confirm, so no command of it applies this plan in a script.
        const hashes = result.planned.map((plan) => plan.hash).join(" ");
        ctx.stdout(`\n${approveLaterHint(`opscrew dns${flag}`, hashes, result.dnsDeletes)}\n`);
      } else {
        const names = result.confirmNames ?? [];
        const confirmFlags = names.map((name) => ` --confirm ${name}`).join("");
        printPlanHashes(
          ctx,
          result.planned,
          `${applyCommand(
            `${command}${flag}`,
            result.planned.map((plan) => plan.hash),
            {
              ...(flags.engine === undefined ? {} : { engine: flags.engine }),
              ...(flags.hostKey === undefined ? {} : { hostKey: flags.hostKey.trim() }),
              ...(flags.passwordLogins === undefined
                ? {}
                : { passwordLogins: flags.passwordLogins }),
              // The stack plan's hash depends on these, so the approving run repeats them.
              ...(result.publicImage === undefined ? {} : { publicImage: result.publicImage }),
              ...(flags.replaceToken === undefined ? {} : { replaceTokens: flags.replaceToken }),
              ...(flags.push === false ? { push: false } : {}),
              ...(flags.yes === true ? { yes: true } : {}),
              ...(flags.keyOut === undefined ? {} : { keyOut: userPath(ctx, flags.keyOut) }),
            },
          )}${confirmFlags}`,
        );
        if (result.keyWanted) {
          ctx.stdout(
            "The first encrypted recovery copy of this app's secrets needs a file for your new age key: in a script, add --key-out <file outside the repository> to the command above (a terminal asks for it).\n",
          );
        }
        if (names.length > 0) {
          // The app's name, and each extra server it deletes by its name at the provider.
          ctx.stdout(
            `This plan deletes or replaces resources, so applying it also needs "${names.join(" ")}" typed: type it when the command asks in a terminal, or keep${confirmFlags} in the command above in a script.\n`,
          );
        }
        if (result.stackFollows !== undefined) {
          ctx.stdout(
            `The stack plan for your Portainer follows once ${result.stackFollows}. In a script that takes three runs: this one, the command above (it applies these plans and stops at the stack plan, printing its hash), then \`opscrew ${command}${flag} --approve <stack plan hash>\`.\n`,
          );
        }
      }
      return;
    }
    if (result.plan?.target.provider === "localhost") {
      ctx.stdout("\nNothing to apply: the app on this computer already matches the local plan.\n");
      return;
    }
    const matched = result.own
      ? "Cloudflare and your server already match the plans"
      : result.portainer
        ? "Cloudflare and your Portainer already match the plans"
        : "the infrastructure already matches the plan";
    const remaining = result.portainer
      ? "the deploy branch, GitHub secrets and the pull request"
      : result.site
        ? "GitHub secrets and the pull request"
        : "server readiness, GitHub secrets and the pull request";
    ctx.stdout(`\nNothing to apply: ${matched}.\n`);
    printNextSteps(ctx, [
      `run \`opscrew ${command}${flag}${flags.yes === true ? " --yes" : ""}\` to finish the remaining steps (${remaining}).`,
    ]);
    return;
  }

  // Nothing was committed (the files did not change, as the phase said): no deploy run follows
  // from this run, unless a pull request from earlier is still open. A branch whose push was
  // refused still needs it first.
  const { published, pushed, prUrl, branch, base } = result.result;
  const deploys = published !== false || prUrl !== undefined;
  const push =
    published === true && pushed === false && branch !== undefined
      ? [
          `push ${branch} (\`git push -u origin ${branch}\`) and open a pull request into ${base}; merging it deploys the app.`,
        ]
      : [];
  if (result.portainer) {
    printPortainerOutcome(ctx, result.result);
    printNextSteps(ctx, [...push, ...portainerNextSteps(result, deploys, flag)]);
    return;
  }
  if (result.plan?.target.provider === "localhost") {
    printNextSteps(ctx, [
      ...push,
      `run \`opscrew verify${flag}\` to check the app on this computer and write ${result.runbook}.`,
    ]);
    return;
  }

  // A server the user owns: its address stays in OpsCrew's local state and is not repeated here.
  const ipv4 = result.own ? undefined : stringOutput(outputs, "server_ipv4");
  if (ipv4 !== undefined) {
    ctx.stdout(`\n${applied ? "Created or updated" : "Using"} the server at ${ipv4}.\n`);
  }
  printNextSteps(ctx, [
    ...push,
    verifyStep(flag, result.runbook, deploys),
    result.site
      ? secureSiteStep(flag, result.securityReport)
      : secureServerStep(flag, result.securityReport),
    ...(result.own
      ? [
          "back up your server and the app's data yourself: OpsCrew cannot turn on backups or snapshots on your own server.",
        ]
      : []),
  ]);
}

/**
 * `opscrew provision --finish-move`: deletes the old copy of the service a move switched to
 * another server (`runProvision` with `finishMove`), after the service's name is typed, or given
 * with `--confirm <service>` in a script, and nothing else.
 */
async function finishMoveCommand(ctx: CliContext, flags: InfraFlags): Promise<void> {
  await runPhaseCommand(ctx, async () => {
    const problems = [
      ...(flags.planOnly === true ? ["--plan-only"] : []),
      ...((flags.approve ?? []).length > 0 ? ["--approve"] : []),
      ...(flags.allowDowntime === true ? ["--allow-downtime"] : []),
    ];
    if (problems.length > 0) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `--finish-move only deletes a moved service's old copy, after you type the service's name, so it does not go with ${problems.join(" or ")}.`,
        {
          hint: "Run `opscrew provision --finish-move` in a terminal, or `opscrew provision --finish-move --confirm <service>` in a script.",
        },
      );
    }
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "provision");
    const planFile = createPhaseDeps(ctx, { ai: false, app, environment: name }).paths.files.plan;
    // Without a move the phase says there is nothing to delete, before any approval.
    const service = (await readArtifact("plan", planFile)).move?.service;
    const confirms = (flags.confirm ?? []).map((value) => value.trim());
    const confirm = confirms.find((value) => value !== service) ?? confirms[0];
    if (service !== undefined) {
      checkConfirmName(
        confirm,
        service,
        "the moved service's name",
        `To delete its old copy in a script, run \`opscrew provision${flag} --finish-move --confirm ${service}\`.`,
      );
    }
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app,
      environment: name,
      ...(service === undefined
        ? {}
        : {
            wrapApprovals: (base, clock) =>
              new FlagConfirmation(base, {
                kinds: ["remote-exec"],
                what: "deleting the moved service's old copy",
                names: confirms,
                hashes: [],
                interactive: ctx.isInteractive,
                print: ctx.stdout,
                clock,
              }),
          }),
    });
    const services = servicesOf(ctx).provision;
    await runProvision(deps, { finishMove: true, ...(services === undefined ? {} : { services }) });
  });
}

/** What a run did in the user's Portainer: the stack plan's hash and whether it was applied. */
function printPortainerOutcome(ctx: CliContext, result: ProvisionResult): void {
  const lines: string[] = [];
  if (result.planHash !== undefined) {
    lines.push(
      result.applied
        ? `Applied the infrastructure plan ${result.planHash} (Cloudflare).`
        : `Cloudflare already matches the infrastructure plan ${result.planHash}.`,
    );
  }
  if (result.stackPlanHash !== undefined) {
    lines.push(
      result.stackApplied === true
        ? `Applied the stack plan ${result.stackPlanHash} to your Portainer.`
        : `Your Portainer already matches the stack plan ${result.stackPlanHash}; nothing in it changed.`,
    );
  }
  if (lines.length > 0) ctx.stdout(`\n${lines.join("\n")}\n`);
}

/**
 * The next steps after provisioning into the user's Portainer, by how visitors reach the app and
 * whether a deploy run follows (`deploys`), with the environment's `flag`, runbook and report.
 */
function portainerNextSteps(
  files: { plan: DeployPlan | undefined; runbook: string; securityReport: string },
  deploys: boolean,
  flag: string,
): string[] {
  const { plan, runbook } = files;
  const proxy = plan?.target.provider === "portainer" && plan.target.web.mode === "proxy";
  return [
    proxy
      ? `${deploys ? "when the deploy run in GitHub Actions has finished and" : "when"} your reverse proxy routes to the app, run \`opscrew verify${flag}\` (add \`--url <address>\` to check the address your proxy serves it on) to check the live site and write ${runbook}.`
      : verifyStep(flag, runbook, deploys),
    `run \`opscrew secure${flag}\` to check the app's stack and write ${files.securityReport} (the host, its firewall, SSH and Portainer's own security stay yours).`,
    "back up the app's data volumes yourself: OpsCrew cannot back up a Portainer host.",
  ];
}

/**
 * `opscrew provision`: renders the deployment files, plans the infrastructure on the plan's
 * provider (and Cloudflare), runs the security policies and applies only after an approval bound to the plan
 * hash; then waits for the server, pins its host key, stores the GitHub deploy secrets and opens a
 * pull request (FR-213). On a server the user already owns it confirms and pins the host key
 * (`--host-key` in scripts), inspects the server and applies the host plan after its own approval
 * (one `--approve <hash>` per plan in scripts; `--yes` never approves either). In the user's
 * existing Portainer it shows the Cloudflare plan and the stack plan, each approved by its hash
 * (`--yes` never approves either); `--public-image`/`--private-image` and `--replace-token` change
 * what the stack plan sends. With servers of their own for some services (feature 018), each
 * server's host plan is approved by its own hash, a moving service's maintenance window by
 * `--allow-downtime` in scripts, and `--finish-move` deletes the moved service's old copy. Exit
 * codes: 0 done, 1 refused or a policy failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("provision")
    .description(
      "Plan and, after your approval, create the servers on your cloud, prepare your own server or set up the app in your Portainer",
    );
  addPlanApproveOptions(command);
  addEnvOption(command);
  addHostKeyOption(command)
    .addOption(
      new Option(
        "--password-logins <choice>",
        "Your own server, when other users log in with a password and no SSH key: turn password logins off anyway, or keep them",
      ).choices(["off", "keep"]),
    )
    .addOption(engineOption())
    .option(
      "--no-push",
      "Commit the generated files locally but do not push or open a pull request",
    )
    .option("--yes", YES_DESCRIPTION)
    .option(
      "--confirm <name>",
      "The app's name, to apply a plan that deletes or replaces resources without a prompt (for scripts; with --approve and that plan's hash); again for each extra server the plan deletes (<app>-<server>); in a script without --approve, lifts the delete protection of the extra servers it names and only plans their deletion; with --finish-move, the moved service's name",
      collect,
    )
    .option(
      "--allow-downtime",
      "In a script: approve the maintenance window of a service moving to another of the app's servers (a terminal asks)",
    )
    .option(
      "--finish-move",
      "Once a moved service runs on its new server: delete its old copy and its data on the server it left (asks for the service's name), and nothing else",
    )
    .option(
      "--public-image",
      "Your existing Portainer: the app's image on GitHub Container Registry is public, so Portainer pulls it without a registry entry (remembered)",
    )
    .option(
      "--private-image",
      "Your existing Portainer: switch a remembered public image back to private (a registry entry with a read-only token)",
    )
    .option(
      "--replace-token <which>",
      `Your existing Portainer: send a rotated token again, "repository" (${REPOSITORY_TOKEN_VAR}) or "registry" (${REGISTRY_TOKEN_VAR}); repeat for both`,
      collectToken,
    )
    .option(
      "--key-out <path>",
      "The first time OpsCrew makes the encrypted recovery copy of this app's secrets: write your new age key to this file, outside the repository (a terminal asks for it); the key is never printed",
    )
    .option(
      "--pages-verification <value>",
      "GitHub Pages: the value of GitHub's domain verification record, which GitHub shows in your account's Pages settings once you add the domain there (a terminal asks for it; it replaces a recorded one)",
    )
    .action((flags: InfraFlags) =>
      flags.finishMove === true
        ? finishMoveCommand(ctx, flags)
        : runInfraCommand(ctx, "provision", flags, runProvision),
    );
}
