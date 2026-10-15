import { readFile } from "node:fs/promises";
import {
  findSavedPlan,
  HOST_KEY_FINGERPRINT,
  hostPlanFile,
  type PhaseDeps,
  type ProvisionOptions,
  type ProvisionResult,
  REGISTRY_TOKEN_VAR,
  REPOSITORY_TOKEN_VAR,
  runProvision,
  stackPlanFile,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { isPlanHash, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { type Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { APPROVE_BY_HASH_KINDS } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import {
  assumeYesHint,
  collect,
  type PlannedHash,
  printPlanHashes,
  runPhaseCommand,
  usageErrorsExit2,
} from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { clackSecretPrompt, createEnvPrompt } from "../ui/env-prompt";
import { printNextSteps } from "../ui/output";

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
  /** `--confirm <app>` (`provision` only): the app's name, for a plan that removes something. */
  confirm?: string;
  /** `--public-image` (`provision` only): the user's Portainer pulls a public image, no registry entry. */
  publicImage?: boolean;
  /** `--private-image` (`provision` only): switch a remembered public image back to private. */
  privateImage?: boolean;
  /** `--replace-token repository|registry` (`provision` only, repeatable): send a rotated token again. */
  replaceToken?: ReplaceableToken[];
}

/** The tokens the user's Portainer keeps that `--replace-token` sends again. */
export const REPLACEABLE_TOKENS = ["repository", "registry"] as const;
/** One value of `--replace-token`. */
export type ReplaceableToken = (typeof REPLACEABLE_TOKENS)[number];

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
 * The Portainer options of `provision` from its flags: `publicImage` (true with `--public-image`,
 * false with `--private-image`, absent otherwise so the remembered choice applies) and
 * `replaceTokens`. Both image flags together are refused.
 */
export function portainerProvisionOptions(
  flags: Pick<InfraFlags, "publicImage" | "privateImage" | "replaceToken">,
): Pick<ProvisionOptions, "publicImage" | "replaceTokens"> {
  if (flags.publicImage === true && flags.privateImage === true) {
    throw new OpsCrewError("INVALID_INPUT", "Use either --public-image or --private-image.", {
      hint: "--public-image says the app's image on GitHub Container Registry is public (Portainer pulls it without a registry entry); --private-image switches back to a registry entry with a read-only token.",
    });
  }
  const tokens = flags.replaceToken ?? [];
  return {
    ...(flags.publicImage === true ? { publicImage: true } : {}),
    ...(flags.privateImage === true ? { publicImage: false } : {}),
    ...(tokens.length === 0
      ? {}
      : {
          replaceTokens: {
            ...(tokens.includes("repository") ? { repository: true } : {}),
            ...(tokens.includes("registry") ? { registry: true } : {}),
          },
        }),
  };
}

/** Help text of `--yes` for the commands that write files, secrets and pull requests. */
export const YES_DESCRIPTION =
  "In a non-interactive run, approve writing the generated files, storing GitHub secrets, pushing and the pull request (infrastructure and host changes still need --approve <hash>)";

/** Help text of `--approve <hash>`, which may be given once per plan. */
export const APPROVE_DESCRIPTION =
  "Apply exactly the saved plan with this hash (from an earlier --plan-only run); give it once per plan (on your own server: the infrastructure plan and the host plan; in your Portainer: the infrastructure plan and the stack plan)";

/** Help text of `--host-key <fingerprint>`. */
export const HOST_KEY_DESCRIPTION =
  "Your own server: trust this SSH host key fingerprint (SHA256:…) on the first connection, for scripts; check it on the server first";

/** Adds `--plan-only` and the repeatable `--approve <hash>` to `command`. */
export function addPlanApproveOptions(command: Command): Command {
  return command
    .option("--plan-only", "Plan, run the policy checks and print the plan hash; change nothing")
    .option("--approve <hash>", APPROVE_DESCRIPTION, collect);
}

/** Adds `--host-key <fingerprint>` (a server the user owns) to `command`. */
export function addHostKeyOption(command: Command): Command {
  return command.option("--host-key <fingerprint>", HOST_KEY_DESCRIPTION);
}

/**
 * Checks `--approve` values (each a 64-character SHA-256 hash, not together with `--plan-only`)
 * and `--host-key` (a `SHA256:…` fingerprint) before anything runs. Returns the trimmed hashes.
 */
export function checkApproveFlags(
  command: string,
  flags: { planOnly?: boolean; approve?: string[]; hostKey?: string },
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
      "--approve expects the 64-character SHA-256 plan hash that `--plan-only` printed.",
      { hint: `Run \`opscrew ${command} --plan-only\` to get the hash of the current plan.` },
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

/** `approvePlanHash`/`approvePlanHashes` for a phase from the `--approve` values. */
export function approveOptions(
  hashes: readonly string[],
): Pick<ProvisionOptions, "approvePlanHash" | "approvePlanHashes"> {
  const [first, ...rest] = hashes;
  return {
    ...(first === undefined ? {} : { approvePlanHash: first }),
    ...(rest.length === 0 ? {} : { approvePlanHashes: rest }),
  };
}

/** The command that applies the plans a `--plan-only` run saved, with the flags that matter. */
function approveCommand(
  command: string,
  hashes: readonly string[],
  flags: InfraFlags,
  confirm?: string,
): string {
  return [
    `opscrew ${command}`,
    ...hashes.map((hash) => `--approve ${hash}`),
    ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
    ...(flags.hostKey === undefined ? [] : [`--host-key ${flags.hostKey.trim()}`]),
    ...(flags.passwordLogins === undefined ? [] : [`--password-logins ${flags.passwordLogins}`]),
    // The stack plan's hash depends on these, so the approving run repeats them.
    ...(flags.publicImage === true ? ["--public-image"] : []),
    ...(flags.privateImage === true ? ["--private-image"] : []),
    ...(flags.replaceToken ?? []).map((token) => `--replace-token ${token}`),
    ...(flags.push === false ? ["--no-push"] : []),
    ...(flags.yes === true ? ["--yes"] : []),
    ...(confirm === undefined ? [] : [`--confirm ${confirm}`]),
  ].join(" ");
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const SavedHostPlanSchema = z.looseObject({
  steps: z.array(z.looseObject({ state: z.string() })),
});

/** True when the saved host plan `hash` changes something on the server (needs an approval). */
export async function hostPlanChanges(
  deps: Pick<PhaseDeps, "paths">,
  hash: string,
): Promise<boolean> {
  const file = hostPlanFile(deps.paths, hash);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // No saved host plan: nothing to approve. Any other problem must not hide a plan.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw error;
  }
  let parsed: z.infer<typeof SavedHostPlanSchema>;
  try {
    parsed = SavedHostPlanSchema.parse(JSON.parse(text));
  } catch {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved host plan ${hash} (.opscrew/plans/host-${hash}.json) is damaged, so OpsCrew cannot tell what it changes.`,
      {
        hint: "Run the command with --plan-only again to save a new host plan, then approve its hash.",
      },
    );
  }
  return parsed.steps.some((step) => step.state === "change");
}

const SavedStackPlanSchema = z.looseObject({
  changes: z.array(z.looseObject({ state: z.string() })),
});

/**
 * The user's Portainer: true when the saved stack plan `hash` (`.opscrew/plans/stack-<hash>.json`)
 * changes something in Portainer (needs an approval). A missing file means no such plan.
 */
export async function stackPlanChanges(
  deps: Pick<PhaseDeps, "paths">,
  hash: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(stackPlanFile(deps.paths, hash), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw error;
  }
  let parsed: z.infer<typeof SavedStackPlanSchema>;
  try {
    parsed = SavedStackPlanSchema.parse(JSON.parse(text));
  } catch {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved stack plan ${hash} (.opscrew/plans/stack-${hash}.json) is damaged, so OpsCrew cannot tell what it changes in your Portainer.`,
      {
        hint: "Run `opscrew provision --plan-only` again to save a new stack plan, then approve its hash.",
      },
    );
  }
  return parsed.changes.some((change) => change.state === "change");
}

/**
 * The typed confirmation for a plan that removes something (an `iac-apply` or `host-apply` that
 * asks for the app's name, for example the switch between serving an own server directly and
 * through the tunnel, which deletes the old DNS records). With `--confirm <app>` it approves
 * exactly that plan when its hash is also one of the `--approve` values; without `--confirm`, a run
 * nobody can answer is refused with the flag to add, and `--yes` never approves it. Every other
 * request (and this one in a terminal without `--confirm`, which asks for the name) goes to `base`.
 */
export class RemovalConfirmation implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly app: string,
    private readonly confirmed: boolean,
    private readonly hashes: readonly string[],
    private readonly interactive: boolean,
    private readonly print: (text: string) => void,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const removal =
      APPROVE_BY_HASH_KINDS.includes(request.kind) && request.confirmPhrase !== undefined;
    if (!removal) return this.base.request(request);
    const decide = (approved: boolean, extra: Partial<ApprovalDecision>): ApprovalDecision => ({
      approved,
      approver: "--approve and --confirm flags",
      decidedAt: new Date().toISOString(),
      ...extra,
    });
    if (this.confirmed) {
      const wanted = request.planHash?.toLowerCase();
      const listed =
        isPlanHash(request.planHash) && this.hashes.some((hash) => hash.toLowerCase() === wanted);
      if (request.confirmPhrase === this.app && listed) {
        this.print(`  ✓ ${request.title} (confirmed with --confirm ${this.app})\n`);
        return decide(true, { confirmation: this.app });
      }
      return decide(false, {
        reason: `--confirm ${this.app} approves a plan that deletes or replaces resources only together with --approve and that plan's hash ${request.planHash ?? ""}`,
      });
    }
    if (!this.interactive) {
      return decide(false, {
        reason: `this plan deletes or replaces resources, which needs the app's name: add --confirm ${request.confirmPhrase} (with --approve and the plan's hash), or run the command in a terminal`,
      });
    }
    return this.base.request(request);
  }
}

/**
 * Runs `provision` or `dns` from the command line: checks the flags, builds the phase deps (with
 * the `--approve <hash>` / `--yes` approval handler when no human is present and the terminal
 * prompt for production values when one is), runs the phase, maps errors to exit codes 1/2 and
 * prints the plan hashes or the next steps. On a server the user owns there are two plans (the
 * infrastructure and the host plan), each with its own hash and approval.
 */
export async function runInfraCommand(
  ctx: CliContext,
  command: "provision" | "dns",
  flags: InfraFlags,
  run: (deps: PhaseDeps, options: ProvisionOptions) => Promise<ProvisionResult>,
): Promise<void> {
  const planOnly = flags.planOnly === true;
  // A wrong `--confirm` name is its own error, not a missing `--yes`.
  let wrongName = false;
  const yesHint = assumeYesHint(ctx, flags.yes, command);
  const result = await runPhaseCommand(
    ctx,
    async () => {
      const hashes = checkApproveFlags(command, flags);
      const portainerOptions = portainerProvisionOptions(flags);
      const hostKey = flags.hostKey?.trim();
      const confirm = flags.confirm?.trim();
      // `--confirm` exists on `provision` only; without a plan the phase explains what to run.
      const app =
        command === "provision"
          ? await readArtifact("plan", createPhaseDeps(ctx, { ai: false }).paths.files.plan)
              .then((plan) => plan.app.name)
              .catch((error: unknown) => {
                if (confirm !== undefined) throw error;
                return undefined;
              })
          : undefined;
      if (confirm !== undefined && confirm !== app) {
        wrongName = true;
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          `--confirm ${confirm} does not match the app's name, so nothing was changed.`,
          {
            hint: `To apply a plan that deletes or replaces resources in a script, run \`opscrew ${command} --approve <hash> … --confirm ${app}\`.`,
          },
        );
      }
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(hashes.length === 0 ? {} : { approvePlanHashes: hashes }),
        ...(flags.yes === true ? { assumeYes: true } : {}),
        ...(app === undefined
          ? {}
          : {
              wrapApprovals: (base: ApprovalHandler) =>
                new RemovalConfirmation(
                  base,
                  app,
                  confirm !== undefined,
                  hashes,
                  // A person can answer: a terminal, or (in tests) an attached approval handler.
                  ctx.isInteractive || servicesOf(ctx).approvalHandler !== undefined,
                  ctx.stdout,
                ),
            }),
      });
      const prompts = promptsOf(ctx);
      const secretPrompt = servicesOf(ctx).prompts === undefined ? clackSecretPrompt : undefined;
      const result = await run(deps, {
        ...(planOnly ? { planOnly: true } : {}),
        ...approveOptions(hashes),
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(flags.push === false ? { push: false } : {}),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(flags.passwordLogins === undefined ? {} : { passwordLogins: flags.passwordLogins }),
        ...portainerOptions,
        services: {
          ...(ctx.isInteractive ? { askEnv: createEnvPrompt(prompts, secretPrompt) } : {}),
          ...deployServicesOf(ctx).provision,
        },
      });
      const plan = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
      const own = plan?.target.provider === "own";
      const portainer = plan?.target.provider === "portainer";
      const planned: PlannedHash[] = [];
      let removes = false;
      let stackFollows = false;
      if (planOnly) {
        const saved =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(deps.paths.files.plansDir, result.planHash);
        if (result.planHash !== undefined && saved !== undefined) {
          removes = saved.hasDestroy;
          planned.push({
            label: own || portainer ? "infrastructure (Cloudflare)" : "infrastructure",
            hash: result.planHash,
          });
        }
        if (
          result.hostPlanHash !== undefined &&
          (await hostPlanChanges(deps, result.hostPlanHash))
        ) {
          planned.push({ label: "host plan for your server", hash: result.hostPlanHash });
        }
        if (
          result.stackPlanHash !== undefined &&
          (await stackPlanChanges(deps, result.stackPlanHash))
        ) {
          planned.push({ label: "stack plan for your Portainer", hash: result.stackPlanHash });
        }
        // The stack plan needs the Cloudflare Tunnel's token, which exists only after this apply.
        stackFollows = portainer && saved !== undefined && result.stackPlanHash === undefined;
      }
      return {
        result,
        planned,
        own,
        portainer,
        plan,
        stackFollows,
        confirmApp: removes ? app : undefined,
      };
    },
    (error) => (wrongName ? undefined : yesHint(error)),
  );

  const { outputs, applied } = result.result;
  if (planOnly) {
    if (result.planned.length > 0) {
      printPlanHashes(
        ctx,
        result.planned,
        approveCommand(
          command,
          result.planned.map((plan) => plan.hash),
          flags,
          result.confirmApp,
        ),
      );
      if (result.confirmApp !== undefined) {
        ctx.stdout(
          `This plan deletes or replaces resources, so applying it also needs the app's name: type it when the command asks in a terminal, or keep --confirm ${result.confirmApp} in the command above in a script.\n`,
        );
      }
      if (result.stackFollows) {
        ctx.stdout(
          `The stack plan for your Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token. In a script that takes three runs: this one, the command above (it applies the infrastructure and stops at the stack plan, printing its hash), then \`opscrew ${command} --approve <stack plan hash>\`.\n`,
        );
      }
      return;
    }
    ctx.stdout(
      result.own
        ? "\nNothing to apply: Cloudflare and your server already match the plans.\n"
        : result.portainer
          ? "\nNothing to apply: Cloudflare and your Portainer already match the plans.\n"
          : "\nNothing to apply: the infrastructure already matches the plan.\n",
    );
    printNextSteps(ctx, [
      `run \`opscrew ${command}${flags.yes === true ? " --yes" : ""}\` to finish the remaining steps (${result.portainer ? "the deploy branch, GitHub secrets and the pull request" : "server readiness, GitHub secrets and the pull request"}).`,
    ]);
    return;
  }

  if (result.portainer) {
    printPortainerOutcome(ctx, result.result);
    printNextSteps(ctx, portainerNextSteps(result.plan));
    return;
  }

  // A server the user owns: its address stays in OpsCrew's local state and is not repeated here.
  const ipv4 = result.own ? undefined : stringOutput(outputs, "server_ipv4");
  if (ipv4 !== undefined) {
    ctx.stdout(`\n${applied ? "Created or updated" : "Using"} the server at ${ipv4}.\n`);
  }
  printNextSteps(ctx, [
    "when the deploy run in GitHub Actions has finished, run `opscrew verify` to check the live site and write opscrew/RUNBOOK.md.",
    "run `opscrew secure` to check the server's hardening and write opscrew/SECURITY_REPORT.md.",
    ...(result.own
      ? [
          "back up your server and the app's data yourself: OpsCrew cannot turn on backups or snapshots on your own server.",
        ]
      : []),
  ]);
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

/** The next steps after provisioning into the user's Portainer, by how visitors reach the app. */
function portainerNextSteps(plan: DeployPlan | undefined): string[] {
  const proxy = plan?.target.provider === "portainer" && plan.target.web.mode === "proxy";
  return [
    proxy
      ? "when the deploy run in GitHub Actions has finished and your reverse proxy routes to the app, run `opscrew verify` (add `--url <address>` to check the address your proxy serves it on) to check the live site and write opscrew/RUNBOOK.md."
      : "when the deploy run in GitHub Actions has finished, run `opscrew verify` to check the live site and write opscrew/RUNBOOK.md.",
    "run `opscrew secure` to check the app's stack and write opscrew/SECURITY_REPORT.md (the host, its firewall, SSH and Portainer's own security stay yours).",
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
 * what the stack plan sends. Exit codes: 0 done, 1 refused or a policy failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("provision")
    .description(
      "Plan and, after your approval, create the servers on your cloud, prepare your own server or set up the app in your Portainer",
    );
  addPlanApproveOptions(command);
  addHostKeyOption(command)
    .addOption(
      new Option(
        "--password-logins <choice>",
        "Your own server, when other users log in with a password and no SSH key: turn password logins off anyway, or keep them",
      ).choices(["off", "keep"]),
    )
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .option(
      "--no-push",
      "Commit the generated files locally but do not push or open a pull request",
    )
    .option("--yes", YES_DESCRIPTION)
    .option(
      "--confirm <name>",
      "The app's name, to apply a plan that deletes or replaces resources without a prompt (for scripts; with --approve and that plan's hash)",
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
    .exitOverride(usageErrorsExit2)
    .action((flags: InfraFlags) => runInfraCommand(ctx, "provision", flags, runProvision));
}
