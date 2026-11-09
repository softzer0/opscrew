import { join } from "node:path";
import {
  ADDON_ROTATION_HASH,
  type Credential,
  chooseDeployBranch,
  credentialInventory,
  credentialListLines,
  credentialsRecordFile,
  type DeployBranch,
  type DockerRotation,
  type DockerUndo,
  dropPendingRotation,
  dropPreviousNames,
  type GitHubSetup,
  githubClientFromToken,
  isAppName,
  listedCredentials,
  type PhaseDeps,
  publishDeploySetup,
  publishRotatedKey,
  type RefreshRecoveryResult,
  readPendingRotation,
  replaceToken,
  requireGitRepo,
  rotateAccessToken,
  rotateBeszel,
  rotateDevice,
  rotateGrant,
  rotateLocalServices,
  rotateMonitoring,
  rotateNetwork,
  rotatePortainerPassword,
  rotatePortainerServices,
  rotateServices,
  rotateSiteAppSecrets,
  rotateSshKey,
  rotateStatePassphrase,
  rotateTunnelToken,
  type SshKeyName,
  setupGitHub,
  tokenExpiries,
  USER_TOKEN_NAMES,
  type UserTokenName,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest, Clock } from "@opscrew/contracts";
import {
  approvalDecision,
  exists,
  isPlanHash,
  listText,
  OpsCrewError,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { type DeployPlan, onOneServer, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { checkConfirmName, FlagConfirmation, formatRequest, hashListed } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import { collect } from "../ui/deploy";
import { type AppEnvFlags, addEnvOption, chooseEnvironment, givenFlags } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { cancelled } from "../ui/prompts";
import { askKeyOut, userPath } from "../ui/recovery";
import { printConnection, printQr } from "./vpn";

interface RotateFlags extends AppEnvFlags {
  all?: boolean;
  json?: boolean;
  /** Every `--approve <hash>`: in a script, the plans an earlier run showed. */
  approve?: string[];
  /** `--confirm <app>`: in a script, the app's name, for a rotation that loses something. */
  confirm?: string;
  undo?: boolean;
  /** `--yes`: in a script, push the record and open its pull request. */
  yes?: boolean;
  /** `--drop-previous`, with `app`: drop the previous values the app keeps. */
  dropPrevious?: boolean;
  qr?: boolean;
  keyOut?: string;
  /** `--backup <age1…>`, or false with `--no-backup`. */
  backup?: string | false;
}

/** The SSH keys `opscrew rotate` takes by name. */
const KEYS: readonly SshKeyName[] = ["deploy-key", "check-key", "preview-key"];

/** The names that are one credential each, rotated by a path of its own. */
const SINGLES = [
  "network",
  "access-token",
  "tunnel-token",
  "state-passphrase",
  "recovery-key",
  "portainer",
  "monitoring",
  "beszel",
] as const;
type Single = (typeof SINGLES)[number];

/** What one run of `opscrew rotate` rotates. */
type Request =
  /** Services and the app's own secrets (`app`, `app:<NAME>`), which rotate together. */
  | { kind: "services"; names: string[] }
  | { kind: "key"; which: SshKeyName }
  | { kind: "device"; device: string }
  | { kind: "grant"; device: string; service: string }
  | { kind: "token"; name: UserTokenName }
  | { kind: Single };

/** One name's request, by its form: `device:<name>`, `grant:<device>/<service>`, `app:<NAME>`. */
function requestOf(name: string, given: string): Request {
  if ((KEYS as readonly string[]).includes(name)) return { kind: "key", which: name as SshKeyName };
  if ((SINGLES as readonly string[]).includes(name)) return { kind: name as Single };
  if ((USER_TOKEN_NAMES as readonly string[]).includes(name)) {
    return { kind: "token", name: name as UserTokenName };
  }
  if (isAppName(name)) return { kind: "services", names: [name] };
  if (name.startsWith("device:")) {
    const device = name.slice("device:".length);
    if (device !== "") return { kind: "device", device };
  } else if (name.startsWith("grant:")) {
    const [device = "", service = "", ...rest] = name.slice("grant:".length).split("/");
    if (device !== "" && service !== "" && rest.length === 0) {
      return { kind: "grant", device, service };
    }
  } else if (!name.includes(":")) {
    return { kind: "services", names: [name] };
  }
  throw new OpsCrewError("INVALID_INPUT", `${name} is not a name \`opscrew rotate\` takes.`, {
    hint: `Run \`opscrew rotate${given}\` to list the credentials by the names it takes, such as db, device:laptop or grant:laptop/db.`,
  });
}

/**
 * The request of `names`: services and app secrets rotate in one plan; every other credential
 * on its own.
 * @throws OpsCrewError `INVALID_INPUT` for a name it does not take, or one that must be alone.
 */
function requestFor(names: readonly string[], given: string): Request {
  const requests = names.map((name) => requestOf(name, given));
  const [first] = requests;
  if (first === undefined) throw new Error("requestFor needs a name");
  if (requests.length === 1) return first;
  const alone = names.filter((_, i) => {
    const kind = requests[i]?.kind;
    return kind !== "services";
  });
  if (alone.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(alone)} ${alone.length === 1 ? "rotates" : "rotate"} on ${alone.length === 1 ? "its" : "their"} own, each with its own plan: only services and app secrets rotate together.`,
      { hint: `Run \`opscrew rotate ${alone[0]}${given}\` by itself.` },
    );
  }
  return { kind: "services", names: [...names] };
}

/**
 * Refuses the flags that do not go with `request` (or with the listing when it is undefined),
 * before anything is read (exit code 2), and returns the trimmed `--approve` hashes. `command` is
 * the run's command without its flags, for the hints.
 */
function checkFlags(
  flags: RotateFlags,
  request: Request | undefined,
  command: string,
  given: string,
): string[] {
  const hashes = (flags.approve ?? []).map((hash) => hash.trim());
  const refuse = (message: string, hint: string) =>
    new OpsCrewError("INVALID_INPUT", message, { hint });
  if (hashes.some((hash) => !isPlanHash(hash))) {
    throw refuse(
      "--approve expects the 64-character SHA-256 hash of a plan an earlier run showed.",
      `Run \`${command}\` to see the plan and its hash.`,
    );
  }
  if (flags.json === true && request !== undefined) {
    throw refuse(
      "--json goes only with the list: it prints the credentials as JSON and rotates nothing.",
      `Run \`opscrew rotate --json${given}\`.`,
    );
  }
  if (request === undefined) {
    const extra = [
      [hashes.length > 0, "--approve"],
      [flags.confirm !== undefined, "--confirm"],
      [flags.undo === true, "--undo"],
      [flags.yes === true, "--yes"],
      [flags.dropPrevious === true, "--drop-previous"],
      [flags.qr === true, "--qr"],
      [flags.keyOut !== undefined || flags.backup !== undefined, "--key-out and --backup"],
    ] as const;
    const set = extra.filter(([on]) => on).map(([, flag]) => flag);
    if (set.length > 0) {
      throw refuse(
        `${listText(set)} ${set.length === 1 ? "goes" : "go"} with a rotation: name the credential to rotate.`,
        `Run \`opscrew rotate${given}\` to list them, then \`opscrew rotate <name>${given}\`.`,
      );
    }
    return hashes;
  }
  const kind = request.kind;
  if (flags.qr === true && kind !== "network" && kind !== "device") {
    throw refuse(
      "--qr goes only with network and device:<name>, which write new configurations for your devices.",
      `Run \`${command}\` without --qr.`,
    );
  }
  if ((flags.keyOut !== undefined || flags.backup !== undefined) && kind !== "recovery-key") {
    throw refuse(
      "--key-out, --backup and --no-backup go only with recovery-key, the recovery copy's age key.",
      `Run \`${command}\` without them.`,
    );
  }
  if (
    flags.dropPrevious === true &&
    !(request.kind === "services" && request.names.length === 1 && request.names[0] === "app")
  ) {
    throw refuse(
      "--drop-previous goes only with app: it drops the previous values the app keeps beside its secrets (APP_PREVIOUS_KEYS, BETTER_AUTH_SECRETS).",
      `Run \`opscrew rotate app --drop-previous${given}\`.`,
    );
  }
  if (kind === "tunnel-token" && hashes.length > 0) {
    throw refuse(
      "The Cloudflare Tunnel token rotates only in a terminal: each of its approvals is of a plan made from the step before, so no hash can be given ahead.",
      `Run \`${command}\` in a terminal, without --approve.`,
    );
  }
  const asksName =
    kind === "access-token" ||
    kind === "services" ||
    (request.kind === "key" && request.which === "deploy-key");
  if (flags.confirm !== undefined && !asksName) {
    throw refuse(
      "--confirm goes only with the app's secrets, access-token and deploy-key, whose rotations can ask for the app's name.",
      `Run \`${command}\` without --confirm.`,
    );
  }
  const undoes = kind === "services" || kind === "grant";
  if (flags.undo === true && !undoes && kind !== "monitoring" && kind !== "beszel") {
    throw refuse(
      "--undo goes only with services, app secrets and device logins (grant:<device>/<service>), whose old values OpsCrew keeps until their rotation is done.",
      `Run \`${command}\` without --undo: run again after a failure, it goes on from where it stopped.`,
    );
  }
  return hashes;
}

/**
 * Approves, in a script, a `remote-exec` request (a rotation's plan or its undo's) whose hash is
 * one of the `--approve` values and that needs no typed name; everything else goes to `base`.
 */
class ScriptedRotationApproval implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: {
      hashes: readonly string[];
      /** `--yes`: also push the record's commit and open its pull request. */
      yes: boolean;
      interactive: boolean;
      print: (text: string) => void;
      clock: Clock;
    },
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { hashes, yes, interactive, print, clock } = this.options;
    if (interactive || request.allowDestroy === true || request.confirmPhrase !== undefined) {
      return this.base.request(request);
    }
    if (yes && PUBLISH_KINDS.includes(request.kind)) {
      print(`  ✓ ${request.title} (approved with --yes)\n`);
      return approvalDecision(clock, "--yes flag", true);
    }
    if (request.kind !== "remote-exec" || !hashListed(hashes, request.planHash)) {
      return this.base.request(request);
    }
    print(`  ✓ ${request.title} (approved with --approve)\n`);
    return approvalDecision(clock, "--approve flag", true);
  }
}

/** What `--yes` approves: the publication of the record and the recovery copy, nothing else. */
const PUBLISH_KINDS: readonly ApprovalRequest["kind"][] = ["git-push", "pull-request"];

/**
 * The approvals of a rotation's run: every plan by its hash (a script's `--approve`), never by a
 * flag alone; `--yes` approves only pushing the record and opening its pull request. A plan that
 * loses something (a replaced resource, users logged out) also needs the app's name typed: in a
 * script `--confirm <app>` with `--approve`, the request shown first.
 */
export function rotationApprovals(
  ctx: CliContext,
  options: { hashes: readonly string[]; confirm: string | undefined; yes: boolean },
): (base: ApprovalHandler, clock: Clock) => ApprovalHandler {
  const { hashes, confirm, yes } = options;
  return (base, clock) => {
    const gate = new FlagConfirmation(
      new ScriptedRotationApproval(base, {
        hashes,
        yes,
        interactive: ctx.isInteractive,
        print: ctx.stdout,
        clock,
      }),
      {
        kinds: ["remote-exec", "iac-apply", "host-apply", "stack-apply", "cloudflare-apply"],
        what: "this rotation",
        names: confirm === undefined ? [] : [confirm],
        hashes,
        interactive: ctx.isInteractive,
        print: ctx.stdout,
        clock,
      },
    );
    if (ctx.isInteractive) return gate;
    return {
      request: (request) => {
        if (request.allowDestroy === true) ctx.stdout(formatRequest(request));
        return gate.request(request);
      },
    };
  };
}

/** The repository a rotation records itself in: its clone, GitHub and the deploy branch. */
interface Repository {
  git: Awaited<ReturnType<typeof requireGitRepo>>;
  github: GitHubSetup;
  branch: DeployBranch;
}

/**
 * The repository of `plan`, with the deploy branch chosen before anything changes (a branch check
 * stops there); none for an app on this computer that GitHub does not deploy.
 */
async function repositoryOf(
  ctx: CliContext,
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<Repository | undefined> {
  if (plan.target.provider === "localhost" && plan.environment?.runner !== "local")
    return undefined;
  const git = await requireGitRepo(deps);
  const github = await setupGitHub(deps, git, servicesOf(ctx).provision ?? {});
  return { git, github, branch: await chooseDeployBranch(deps, git, github, plan) };
}

/**
 * Proposes what a finished rotation changed in the repository: the record of the rotation, the
 * plan (a rotation of the network's keys changes its public keys) and the recovery copy, in the
 * deploy pull request. Without a repository, the copy's files are written here and the user is
 * told to commit them.
 */
async function publish(
  ctx: CliContext,
  deps: PhaseDeps,
  repository: Repository | undefined,
  copy: RefreshRecoveryResult | undefined,
): Promise<void> {
  if (copy?.warning !== undefined) deps.reporter.warn(deps.redactor.redact(copy.warning));
  if (copy?.changed === true && copy.folderCopy !== undefined) {
    deps.reporter.info(`Wrote the encrypted recovery copy to ${copy.folderCopy}.`);
  }
  const files = copy?.changed === true ? copy.repositoryFiles : [];
  const { root } = deps.paths;
  const record = credentialsRecordFile(deps.paths);
  if (repository === undefined) {
    for (const file of files) {
      await writeFileAtomic(join(root, file.path), file.content, { mode: file.mode ?? 0o644 });
    }
    const changed = [
      ...((await exists(record)) ? [toPosixRelative(root, record)] : []),
      ...files.map((file) => file.path),
    ];
    if (changed.length > 0) {
      printNextSteps(ctx, [
        `commit ${listText(changed)}, so the other computers you work from know of the rotation.`,
      ]);
    }
    return;
  }
  const paths: string[] = [];
  for (const file of [deps.paths.files.plan, record]) {
    if (await exists(file)) paths.push(toPosixRelative(root, file));
  }
  const published = await publishDeploySetup(deps, {
    git: repository.git,
    github: repository.github,
    plan: await readArtifact("plan", deps.paths.files.plan),
    paths,
    push: true,
    branch: repository.branch,
    recoveryCopy: { files },
  });
  if (published.prUrl !== undefined) ctx.stdout(`Pull request: ${published.prUrl}\n`);
}

/**
 * `--undo` of an add-on's rotation, which only goes forward: one never approved is forgotten;
 * otherwise refused.
 */
async function forgetAddonRotation(
  ctx: CliContext,
  deps: PhaseDeps,
  name: "monitoring" | "beszel",
  flag: string,
): Promise<void> {
  const { environment } = deps.paths;
  const pending = await readPendingRotation(deps);
  const ours =
    pending?.hash === ADDON_ROTATION_HASH &&
    pending.names.length === 1 &&
    pending.names[0] === name;
  if (ours && pending.step === "planned") {
    await dropPendingRotation(deps);
    ctx.stdout(
      `Forgot the rotation of ${name} in ${environment}: it was never approved, so nothing else had changed.\n`,
    );
    return;
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    ours
      ? `The rotation of ${name} in ${environment} began on the servers, and an add-on's rotation only goes forward, so it can't be undone. Nothing was changed.`
      : `No rotation of ${name} is unfinished in ${environment}, so there is nothing to undo. Nothing was changed.`,
    ours ? { hint: `Run \`opscrew rotate ${name}${flag}\` to finish it.` } : {},
  );
}

/** The listing: every credential with its date and how it rotates, as text or `--json`. */
async function list(ctx: CliContext, flags: RotateFlags): Promise<void> {
  const json = flags.json === true;
  const { app, name, flag } = await chooseEnvironment(ctx, flags, "rotate");
  const deps = createPhaseDeps(ctx, {
    ai: false,
    app,
    environment: name,
    ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
  });
  const plan = await readArtifact("plan", deps.paths.files.plan);
  // Read only: a token seen for the first time is not recorded by a listing.
  const credentials = listedCredentials(
    await credentialInventory(deps, plan),
    await tokenExpiries(deps, plan),
  );
  if (json) {
    ctx.stdout(
      `${JSON.stringify({ app: plan.app.name, environment: name, credentials }, null, 2)}\n`,
    );
    return;
  }
  const where = { app: plan.app.name, environment: name, flag, opscrew: "opscrew" };
  ctx.stdout(`${credentialListLines(credentials, where, deps.clock.now()).join("\n")}\n`);
}

/**
 * The new age key's file for `recovery-key`: `--key-out`, or asked in a terminal.
 * @throws OpsCrewError when a script gives none, or the user cancels.
 */
async function keyOutFor(ctx: CliContext, flags: RotateFlags, flag: string): Promise<string> {
  if (flags.keyOut !== undefined) return userPath(ctx, flags.keyOut);
  if (!ctx.isInteractive) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A new age key needs a file to be written to, and OpsCrew never prints a key.",
      {
        hint: `Name a file outside the repository with \`--key-out <path>\`, or run \`opscrew rotate recovery-key${flag}\` in a terminal, which asks for it.`,
      },
    );
  }
  const keyOut = await askKeyOut(ctx);
  if (keyOut === undefined)
    throw cancelled("the key rotation", `opscrew rotate recovery-key${flag}`);
  return keyOut;
}

/** The rotation of services and app secrets on the target that runs them. */
async function rotateServicesOf(
  ctx: CliContext,
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  undo: boolean,
  github: () => GitHubSetup,
): Promise<RefreshRecoveryResult | undefined> {
  const provision = servicesOf(ctx).provision ?? {};
  const provider = plan.target.provider;
  if (onOneServer(provider)) {
    return (
      await rotateServices(deps, plan, names, {
        github: github(),
        ...(undo ? { undo: true } : {}),
        ...(provision.remote === undefined ? {} : { remote: provision.remote }),
        ...(provision.sleep === undefined ? {} : { sleep: provision.sleep }),
        ...(provision.now === undefined ? {} : { now: provision.now }),
      })
    ).copy;
  }
  const docker = (result: DockerRotation | DockerUndo) =>
    "copy" in result ? result.copy : undefined;
  if (provider === "portainer") {
    return docker(
      await rotatePortainerServices(deps, plan, names, {
        ...(undo ? { undo: true } : {}),
        services: { provision },
      }),
    );
  }
  if (provider === "localhost") {
    const localhost = servicesOf(ctx).localhost;
    return docker(
      await rotateLocalServices(deps, plan, names, {
        ...(undo ? { undo: true } : {}),
        ...(localhost === undefined ? {} : { services: localhost }),
      }),
    );
  }
  // A site on Cloudflare's hosting or GitHub Pages: only the app's own secrets, which it refuses
  // services for, through its GitHub secrets and a deploy followed to its end.
  const api = servicesOf(ctx).rotate?.github ?? (await followingApi(deps));
  return (
    await rotateSiteAppSecrets(deps, plan, names, {
      github: { ...github(), api },
      ...(undo ? { undo: true } : {}),
    })
  ).copy;
}

/**
 * The client of the user's GitHub token, for the rotations that start a deploy (or a check run)
 * and follow it: a key's proof, a site's deploy.
 */
async function followingApi(deps: PhaseDeps) {
  const api = await githubClientFromToken(deps);
  if (api === undefined) throw new Error("rotate found no GitHub token after setupGitHub");
  return api;
}

/** One rotation in the chosen environment: `requested`, or with `--all` every service and `app`. */
async function rotate(
  ctx: CliContext,
  flags: RotateFlags,
  requested: Request,
  hashes: readonly string[],
): Promise<void> {
  let request = requested;
  const { app, name, flag } = await chooseEnvironment(ctx, flags, "rotate");
  const confirm = flags.confirm?.trim();
  const deps = createPhaseDeps(ctx, {
    ai: false,
    app,
    environment: name,
    approveHashes: hashes,
    wrapApprovals: rotationApprovals(ctx, { hashes, confirm, yes: flags.yes === true }),
  });
  const plan = await readArtifact("plan", deps.paths.files.plan);
  checkConfirmName(
    confirm,
    plan.app.name,
    "the app's name",
    `Give --confirm ${plan.app.name}, the name of the app.`,
  );
  const services = servicesOf(ctx);
  const provision = services.provision ?? {};
  const vpn = services.vpn ?? {};
  const undo = flags.undo === true;

  if (request.kind === "recovery-key") {
    const keyOut = await keyOutFor(ctx, flags, flag);
    const git = await requireGitRepo(deps);
    const github = await setupGitHub(deps, git, provision);
    const rotated = await publishRotatedKey(deps, {
      git,
      github,
      plan,
      keyOut,
      ...(flags.backup === false ? { backup: null } : {}),
      ...(typeof flags.backup === "string" ? { backup: flags.backup } : {}),
    });
    ctx.stdout(`${rotated.message}\n`);
    if (rotated.prUrl !== undefined) ctx.stdout(`Pull request: ${rotated.prUrl}\n`);
    return;
  }
  if (request.kind === "monitoring" || request.kind === "beszel") {
    if (undo) return forgetAddonRotation(ctx, deps, request.kind, flag);
  }
  // `--all`: every service and the app's own secrets in one plan (the typed name once for those
  // that log users out); every other credential is named after it, to rotate one by one.
  let others: string[] = [];
  if (flags.all === true) {
    const inventory = await credentialInventory(deps, plan);
    const rotates = (c: Credential) => c.rotation.mode !== "none" && c.kind !== "user-token";
    const together = (c: Credential) => c.kind === "service" || c.name === "app";
    const names = inventory.filter((c) => rotates(c) && together(c)).map((c) => c.name);
    others = inventory
      .filter((c) => rotates(c) && !together(c) && c.kind !== "app-secret")
      .map((c) => `\`opscrew rotate ${c.name}${flag}\``);
    if (names.length === 0) {
      ctx.stdout(`${plan.app.name} has no services or app secrets to rotate in ${name}.\n`);
      printNextSteps(ctx, others);
      return;
    }
    request = { kind: "services", names };
  }
  const repository = await repositoryOf(ctx, deps, plan);
  const github = () => {
    if (repository === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `This rotation goes through the app's GitHub repository, and GitHub doesn't deploy ${plan.app.name} in ${name}. Nothing was changed.`,
        { hint: `Run \`opscrew rotate${flag}\` to list what can be rotated here.` },
      );
    }
    return repository.github;
  };
  const waits = {
    ...(provision.sleep === undefined ? {} : { sleep: provision.sleep }),
    ...(provision.now === undefined ? {} : { now: provision.now }),
  };
  const engine = provision.engine === undefined ? {} : { services: { engine: provision.engine } };
  let copy: RefreshRecoveryResult | undefined;
  switch (request.kind) {
    case "services":
      copy = await rotateServicesOf(
        ctx,
        deps,
        plan,
        flags.dropPrevious === true ? await dropPreviousNames(deps, plan) : request.names,
        undo,
        github,
      );
      break;
    case "key":
      copy = (
        await rotateSshKey(deps, plan, request.which, {
          // The proof dispatches a deploy (or a check run) and follows it.
          github: { ...github(), api: services.rotate?.github ?? (await followingApi(deps)) },
          provision,
          ...(provision.remote === undefined ? {} : { remote: provision.remote }),
          ...(provision.engine === undefined ? {} : { engine: provision.engine }),
        })
      ).copy;
      break;
    case "network": {
      const rotated = await rotateNetwork(deps, plan, {
        ...(flags.qr === true ? { qr: true } : {}),
        services: vpn,
      });
      for (const device of rotated.devices) {
        if (device.qr !== undefined) printQr(ctx, device.qr);
      }
      copy = rotated.copy;
      break;
    }
    case "device": {
      const rotated = await rotateDevice(deps, plan, request.device, {
        ...(flags.qr === true ? { qr: true } : {}),
        services: vpn,
      });
      if (rotated.qr !== undefined) printQr(ctx, rotated.qr);
      copy = rotated.copy;
      break;
    }
    case "grant": {
      const rotated = await rotateGrant(deps, plan, request.device, request.service, {
        services: vpn,
        servers: {
          github: github(),
          ...(undo ? { undo: true } : {}),
          ...(provision.remote === undefined ? {} : { remote: provision.remote }),
          ...waits,
        },
      });
      if (rotated.connection !== undefined) {
        printConnection(ctx, { ...rotated, connection: rotated.connection });
      }
      copy = rotated.copy;
      break;
    }
    case "access-token":
      copy = (await rotateAccessToken(deps, plan, { github: github(), ...waits, ...engine })).copy;
      break;
    case "tunnel-token":
      copy = (
        await rotateTunnelToken(deps, plan, {
          provision,
          ...(services.vpn === undefined ? {} : { server: services.vpn }),
          ...engine,
        })
      ).copy;
      break;
    case "state-passphrase":
      copy = (await rotateStatePassphrase(deps, plan, engine)).copy;
      break;
    case "portainer":
      copy = (
        await rotatePortainerPassword(
          deps,
          plan,
          provision.remote === undefined ? {} : { remote: provision.remote },
        )
      ).copy;
      break;
    case "monitoring":
      copy = (await rotateMonitoring(deps, plan, { services: provision })).copy;
      break;
    case "beszel":
      copy = (await rotateBeszel(deps, plan, { services: provision })).copy;
      break;
    case "token":
      await replaceToken(deps, plan, request.name, {
        ...(services.init === undefined ? {} : { init: services.init }),
        ...(provision.github === undefined || provision.github === null
          ? {}
          : { github: provision.github }),
      });
      break;
  }
  // An undo that changed no file of the repository proposes nothing.
  if (!undo || copy?.changed === true) await publish(ctx, deps, repository, copy);
  printNextSteps(ctx, others);
}

/** The command's line in `opscrew --help`, and the first line of its own help. */
const SUMMARY =
  "List the credentials OpsCrew made for an environment with their age, or rotate the ones you name";

/**
 * `opscrew rotate [<name>...]` (feature 025): with no name, the environment's credentials (what
 * OpsCrew made, then the user's own tokens) with how each rotates and its date, read only
 * (`--json` too); with names, their rotation, each a plan shown and approved by its hash (in a
 * script `--approve <hash>`), then the record of the rotation and the recovery copy proposed in
 * the deploy pull request. Services and app secrets rotate in one plan; every other name alone.
 * No value is ever printed: a device login's new password is shown once, and a device's new
 * configuration only as a file or a QR code. Exit codes: 0 done, 1 refused or not approved, 2
 * error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("rotate")
    .summary(SUMMARY)
    .description(
      [
        SUMMARY,
        "",
        "Without a name it lists every credential by the name this command takes, how it rotates",
        "and when it was made or last rotated, then your own tokens with their expiry. Each",
        "rotation is a plan you approve by its hash; neither the old nor the new value is shown.",
        "Services and the app's own secrets rotate together in one plan, everything else on its own.",
      ].join("\n"),
    )
    .argument("[names...]", "The credentials to rotate, by the names the list shows")
    .option(
      "--all",
      "Rotate every service and the app's own secrets in one plan, then list the other credentials",
    )
    .option("--json", "With no name: print the credentials as JSON")
    .option(
      "--approve <hash>",
      "In a script: apply exactly the plan with this hash, which an earlier run showed (give it once per plan)",
      collect,
    )
    .option(
      "--confirm <app>",
      "In a script, with --approve: the app's name, for a rotation that logs users out or replaces a resource (app secrets, access-token, deploy-key on a cloud server)",
    )
    .option(
      "--yes",
      "In a script: also push the record of the rotation and open its pull request (never approves the rotation itself)",
    )
    .option(
      "--undo",
      "Put the old values back of a services' or a device login's rotation that stopped before it finished",
    )
    .option(
      "--drop-previous",
      "With app: drop the previous values Laravel and Better Auth keep beside the current secret",
    )
    .option("--qr", "With network or device:<name>: also show each new configuration as a QR code")
    .option(
      "--key-out <path>",
      "With recovery-key: the file to write the new key to, outside the repository",
    )
    .option(
      "--backup <recipient>",
      "With recovery-key: replace the backup key with this public key (age1…)",
    )
    .option("--no-backup", "With recovery-key: drop the backup key");
  addEnvOption(command)
    .addHelpText(
      "after",
      [
        "",
        "  opscrew rotate                          what can be rotated, with its age",
        "  opscrew rotate db cache                 the services db and cache, in one plan",
        "  opscrew rotate db --undo                put db's old password back after a failed rotation",
        "  opscrew rotate app                      the app's own secrets (a typed name if users log out)",
        "  opscrew rotate app --drop-previous      drop the previous keys Laravel or Better Auth keep",
        "  opscrew rotate deploy-key               a new deploy key, proven before the old one goes",
        "  opscrew rotate network --qr             new WireGuard keys, each device's new configuration",
        "  opscrew rotate grant:laptop/cache       a new password for laptop's login to cache",
        "  opscrew rotate recovery-key --key-out <path>   a new age key for the recovery copy",
        "  opscrew rotate hetzner                  after you set a new HCLOUD_TOKEN",
      ].join("\n"),
    )
    .action(async (names: string[], flags: RotateFlags) => {
      const given = givenFlags(flags);
      const wanted = names.map((name) => name.trim()).filter((name) => name !== "");
      if (flags.all === true && wanted.length > 0) {
        throw new OpsCrewError("INVALID_INPUT", "Use either --all or the names to rotate.", {
          hint: `Run \`opscrew rotate --all${given}\`, or \`opscrew rotate <name>${given}\`.`,
        });
      }
      if (flags.all === true) {
        const all = `opscrew rotate --all${given}`;
        const request: Request = { kind: "services", names: [] };
        return rotate(ctx, flags, request, checkFlags(flags, request, all, given));
      }
      const request = wanted.length === 0 ? undefined : requestFor(wanted, given);
      const command = `opscrew rotate${wanted.map((name) => ` ${name}`).join("")}${given}`;
      const hashes = checkFlags(flags, request, command, given);
      if (request === undefined) return list(ctx, flags);
      return rotate(ctx, flags, request, hashes);
    });
}
