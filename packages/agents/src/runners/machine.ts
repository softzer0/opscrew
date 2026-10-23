/**
 * Runner machines (FR-1532–FR-1535, contracts/runners.md "Runner machines"): a machine of the
 * user's (a home server, a spare PC, a VM) that runs only the GitHub Actions runners of the
 * project's environments. It is set up over SSH with the user's key like their own server, the
 * host key pinned at first contact, through a host plan of its own approved by its hash. It is
 * hardened only when the user asks (FR-1536), each part on its own: SSH (key-only logins, no root)
 * and OpsCrew's own SSH firewall. Its record (the login, the pinned host key, its CPU, Docker, the
 * hardening and the environments whose runners it holds) stays in the project's home folder:
 * plans name the machine only by its name. Its host plans with the SSH firewall hold the user's
 * addresses, and are saved only in the gitignored `.opscrew/plans/`.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseGitHubRepo } from "@opscrew/connector-github";
import {
  applyHostPlan,
  canonicalSshSource,
  type DesiredRunnerHost,
  type HostFacts,
  type HostPlan,
  hostPlanHash,
  MAX_SSH_SOURCES,
  planRunnerHost,
  planUndo,
} from "@opscrew/connector-ssh-host";
import type { PhaseName } from "@opscrew/contracts";
import {
  listText,
  normalizeHostName,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  resolveProjectPaths,
  stripBom,
  upperFirst,
  writeFileAtomic,
} from "@opscrew/core";
import { runnerLabel } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  environmentsOf,
  RUNNER_HOST_NAME_MESSAGE,
  RUNNER_HOST_NAME_PATTERN,
  readArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";
import type { OwnServerServices } from "../provision/types";
import {
  approveAndApplyHostPlan,
  gitClient,
  githubCoordinates,
  type HostPlanOutcome,
  readServerAddresses,
  refusalReason,
  requireNoBlockers,
  type SshLogin,
  SshLoginSchema,
} from "../shared";
import {
  connectPinnedLogin,
  inspectOwnHost,
  type LoginWords,
  type OwnServerSession,
  ownServerLoginCheck,
} from "../shared/own-server";
import {
  allowRunnerOn,
  deleteRegistrations,
  lazyRepository,
  type RunnerGitHubApi,
  type RunnerRepository,
  repositoryUrl,
  runnerRepository,
} from "./github";
import { removeKeptRegistrations, runnerTokens, serverRunner, serverRunnerName } from "./server";
import { planWhere } from "./words";

/**
 * A runner machine's shell and host adapter, the home folder of `~/` key paths, and the check that
 * new logins still work after an SSH or firewall change (fakes in tests).
 */
export type RunnerHostServices = Pick<
  OwnServerServices,
  "remote" | "host" | "homeDir" | "verifyLogin"
>;

/** What the runner machine flows use: the machine's services and GitHub's runner API. */
export interface MachineRunnerServices {
  /** The runner machine of `runner: host` (default: SSH with its recorded login, ssh-host). */
  runnerMachine?: RunnerHostServices;
  /** GitHub's runner API (default: the client of the user's token). */
  runnerGitHub?: RunnerGitHubApi;
}

/**
 * A runner machine's hardening (FR-1536), off by default and each part on its own: `ssh`, the own
 * server's SSH hardening; `firewall`, OpsCrew's nftables table that lets only `sshFrom` reach SSH.
 */
export type RunnerHardening = NonNullable<DesiredRunnerHost["harden"]>;

/** A part of {@link RunnerHardening}. */
export type RunnerHardeningPart = keyof RunnerHardening;

const RunnerHardeningSchema = z.strictObject({
  ssh: z.literal(true).optional(),
  firewall: z.strictObject({ sshFrom: z.array(z.string()).min(1) }).optional(),
});

const RunnerHostRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().regex(RUNNER_HOST_NAME_PATTERN),
  /** The SSH login with the user's key, and the host key pinned at first contact. */
  login: SshLoginSchema,
  /** The machine's CPU, from inspection. */
  arch: z.enum(["amd64", "arm64"]),
  /** Docker was installed when OpsCrew last looked (the machine's host plan installs it). */
  docker: z.boolean(),
  /** The hardening the user chose; absent: none. */
  harden: RunnerHardeningSchema.optional(),
  /**
   * The environments whose runners OpsCrew installed there, by name: a provision of one that no
   * longer names the machine finds its runner here and removes it.
   */
  environments: z.array(z.string()),
});

/** A runner machine as this computer records it (`<project home>/runner-hosts/<name>.json`). */
export type RunnerHostRecord = z.output<typeof RunnerHostRecordSchema>;

/** `<project home>/runner-hosts`: prod's project home, since every environment shares a machine. */
function runnerHostsDir(paths: ProjectPaths): string {
  return join(environmentPaths(paths, "prod").projectHomeDir, "runner-hosts");
}

function recordFile(paths: ProjectPaths, name: string): string {
  return join(runnerHostsDir(paths), `${name}.json`);
}

/** The machine's own known_hosts file, which holds its pinned host key. */
function knownHostsFile(paths: ProjectPaths, name: string): string {
  return join(runnerHostsDir(paths), `${name}.known_hosts`);
}

/** `name`, when it is a runner machine's name; else `INVALID_INPUT` with the rule. */
function machineName(name: string): string {
  if (RUNNER_HOST_NAME_PATTERN.test(name)) return name;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `"${name}" is not a runner machine's name: it ${RUNNER_HOST_NAME_MESSAGE}.`,
    { hint: "Name the machine after what it is, for example home or build-box." },
  );
}

/** The add command, for the hints that record a machine's login again. */
const addCommand = (name: string) => `opscrew runner host add ${name} --ssh <user@host[:port]>`;

/** How the SSH connection's messages name the machine and the fix for its login. */
function machineWords(name: string): LoginWords {
  return {
    noun: `the runner machine ${name}`,
    fix: `\`${addCommand(name)}\``,
    missingKey: `Run \`${addCommand(name)} --key <file>\` again with the path of your private key (or without --key to use the key in your SSH agent), then try again.`,
  };
}

/**
 * The runner machine `name` as this computer records it; `undefined` when it has none.
 * @throws OpsCrewError `ARTIFACT_INVALID` for a damaged record.
 */
export async function readRunnerHost(
  paths: ProjectPaths,
  name: string,
): Promise<RunnerHostRecord | undefined> {
  const file = recordFile(paths, machineName(name));
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch {
    json = undefined;
  }
  const parsed = RunnerHostRecordSchema.safeParse(json);
  if (!parsed.success || parsed.data.name !== name) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `OpsCrew's record of the runner machine ${name} on this computer (${file}) is damaged, so OpsCrew stopped instead of guessing how to reach it.`,
      {
        hint: `Add the machine again with \`${addCommand(name)}\`: it records its login anew and asks you to confirm its host key.`,
      },
    );
  }
  return parsed.data;
}

/**
 * The runner machine `name` as this computer records it.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no record of it.
 */
export async function requireRunnerHost(
  paths: ProjectPaths,
  name: string,
): Promise<RunnerHostRecord> {
  const record = await readRunnerHost(paths, name);
  if (record !== undefined) return record;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This computer has no runner machine named ${name}: its address and SSH login are kept only on the computer that added it.`,
    {
      hint: `Add it with \`${addCommand(name)}\`, or run the command on the computer that added it. \`opscrew runner host list\` shows the machines this computer knows.`,
    },
  );
}

async function writeRunnerHost(paths: ProjectPaths, record: RunnerHostRecord): Promise<void> {
  const valid = RunnerHostRecordSchema.parse(record);
  await writeFileAtomic(recordFile(paths, valid.name), `${JSON.stringify(valid, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Rewrites the record of the runner machine `name` with `change`. */
async function updateRunnerHost(
  paths: ProjectPaths,
  name: string,
  change: (record: RunnerHostRecord) => RunnerHostRecord,
): Promise<void> {
  await writeRunnerHost(paths, change(await requireRunnerHost(paths, name)));
}

/** Records that the runner of `environment` is on the machine `name` (`on`), or no longer is. */
async function recordRunner(
  paths: ProjectPaths,
  name: string,
  environment: string,
  on: boolean,
): Promise<void> {
  await updateRunnerHost(paths, name, (record) => {
    const others = record.environments.filter((item) => item !== environment);
    return { ...record, environments: on ? [...others, environment].sort() : others };
  });
}

/** Every runner machine this computer records for the project, by name. */
async function runnerHostRecords(paths: ProjectPaths): Promise<RunnerHostRecord[]> {
  const names = await runnerHostNames(paths);
  return Promise.all(names.map((name) => requireRunnerHost(paths, name)));
}

/** The names of the runner machines this computer records for the project, sorted. */
async function runnerHostNames(paths: ProjectPaths): Promise<string[]> {
  const files = await readdir(runnerHostsDir(paths)).catch(() => [] as string[]);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => RUNNER_HOST_NAME_PATTERN.test(name))
    .sort();
}

/**
 * What the MCP server's replies hide of the runner machines this computer records for the
 * project: each one's address and `user@host` login (`machines`), and the addresses its SSH
 * firewall lets in (`sources`, each also without its prefix length). A damaged record hides
 * nothing, and never stops the others from being hidden.
 */
export async function runnerHostAddresses(
  paths: ProjectPaths,
): Promise<{ machines: string[]; sources: string[] }> {
  const machines: string[] = [];
  const sources: string[] = [];
  for (const name of await runnerHostNames(paths)) {
    const record = await readRunnerHost(paths, name).catch(() => undefined);
    if (record === undefined) continue;
    const { login } = record;
    machines.push(login.host, `${login.user}@${login.host}`);
    for (const source of record.harden?.firewall?.sshFrom ?? []) {
      sources.push(source, source.split("/")[0] as string);
    }
  }
  return { machines, sources };
}

/** The machine's CPU from inspection: amd64 or arm64, as GitHub's runner and OpsCrew support. */
function machineArch(facts: HostFacts, name: string): "amd64" | "arm64" {
  if (facts.arch === "amd64" || facts.arch === "arm64") return facts.arch;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The runner machine ${name}'s processor architecture is ${facts.arch || facts.machine || "unknown"}; OpsCrew's runners need amd64 or arm64.`,
    { hint: "Use a 64-bit machine (x86-64 or ARM64). On a Raspberry Pi, install the 64-bit OS." },
  );
}

/**
 * Connects to the machine with its recorded login, the pinned host key (asked for, or given with
 * `hostKey`, at first contact; {@link connectPinnedLogin}), then inspects it read-only, audited
 * without its address. `pin` records a newly confirmed key.
 */
async function connectMachine(
  deps: PhaseDeps,
  machine: { name: string; login: SshLogin },
  options: {
    pin: (hostKey: string) => Promise<void>;
    hostKey?: string | undefined;
    services?: RunnerHostServices | undefined;
    phase?: PhaseName;
  },
): Promise<{ session: OwnServerSession; facts: HostFacts }> {
  const { name, login } = machine;
  const words = machineWords(name);
  deps.reporter.step(`Connecting to ${words.noun}`);
  const session = await connectPinnedLogin(
    deps,
    {
      connection: login,
      knownHostsFile: knownHostsFile(deps.paths, name),
      pin: options.pin,
      words,
    },
    { hostKey: options.hostKey, services: options.services },
  );
  const facts = await inspectOwnHost(deps, session, {
    services: options.services,
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
    machine: { noun: words.noun, target: `runner machine ${name}` },
  });
  return { session, facts };
}

/** {@link connectMachine} for a recorded machine; a newly confirmed key is written to its record. */
async function connectRecorded(
  deps: PhaseDeps,
  record: RunnerHostRecord,
  options: { services?: RunnerHostServices | undefined; phase?: PhaseName },
): Promise<{ session: OwnServerSession; facts: HostFacts }> {
  return connectMachine(deps, record, {
    ...options,
    pin: (hostKey) =>
      writeRunnerHost(deps.paths, { ...record, login: { ...record.login, hostKey } }),
  });
}

/** The project's repository on GitHub, `https://github.com/<owner>/<repo>` (the `origin` remote). */
async function projectRepositoryUrl(deps: PhaseDeps): Promise<string> {
  return repositoryUrl(await githubCoordinates(gitClient(deps)));
}

/** A change of a runner machine's hardening (`--harden`, `--no-harden` and `--ssh-from`). */
export interface RunnerHardeningChange {
  /** The parts to turn on; `firewall` needs `sshFrom`. */
  on?: readonly RunnerHardeningPart[];
  /** The parts to turn off. */
  off?: readonly RunnerHardeningPart[];
  /** With `firewall` on: the IPv4 or IPv6 addresses or networks that may reach SSH. */
  sshFrom?: readonly string[];
}

/**
 * `current` with `change`: each part turned on or off, the firewall's sources replaced by
 * `sshFrom` in the form nft prints them (ssh-host's `canonicalSshSource`); undefined when nothing
 * stays hardened.
 * @throws OpsCrewError `INVALID_INPUT` for a part both turned on and off, the firewall without
 * sources (there is no default: a guess at this computer's address could lock the user out), and
 * sources without the firewall, that are no address or network, or more than ssh-host takes.
 */
function changedHardening(
  current: RunnerHardening | undefined,
  change: RunnerHardeningChange,
): RunnerHardening | undefined {
  const on = new Set(change.on ?? []);
  const off = new Set(change.off ?? []);
  const both = [...on].filter((part) => off.has(part));
  if (both.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--harden and --no-harden both name ${listText(both)}.`,
      {
        hint: "Name each part once: --harden turns it on, --no-harden turns it off.",
      },
    );
  }
  const given = (change.sshFrom ?? []).map((source) => source.trim());
  if (on.has("firewall") && given.length === 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The SSH firewall needs the addresses that may still reach the machine's SSH, and OpsCrew never guesses them: a guessed address could lock you out when it changes.",
      {
        hint: "Name them with --ssh-from, for example --harden firewall --ssh-from 203.0.113.7 (the address this computer reaches the machine from) or --ssh-from 192.168.1.0/24 (your home network).",
      },
    );
  }
  if (!on.has("firewall") && given.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", "--ssh-from goes with --harden firewall.", {
      hint: "Give --harden firewall --ssh-from <address or network> …; the sources replace the firewall's earlier ones.",
    });
  }
  const bad = given.filter((source) => canonicalSshSource(source) === null);
  if (bad.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(bad)} ${bad.length === 1 ? "is not an address or network" : "are not addresses or networks"} for --ssh-from.`,
      {
        hint: "Give public or private IPv4 or IPv6 addresses or networks, such as 203.0.113.7, 198.51.100.0/24 or 2001:db8::/32 (not every address, /0, nor a special IPv6 form such as ::1 or ::ffff:203.0.113.7).",
      },
    );
  }
  const sshFrom = [...new Set(given.map((source) => canonicalSshSource(source) as string))];
  if (sshFrom.length > MAX_SSH_SOURCES) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The SSH firewall takes at most ${MAX_SSH_SOURCES} sources, and --ssh-from names ${sshFrom.length}.`,
      { hint: "Name networks that hold several addresses, such as 198.51.100.0/24." },
    );
  }
  const ssh = on.has("ssh") || (!off.has("ssh") && current?.ssh === true);
  const firewall = on.has("firewall")
    ? { sshFrom }
    : off.has("firewall")
      ? undefined
      : current?.firewall;
  if (!ssh && firewall === undefined) return undefined;
  return { ...(ssh ? { ssh: true } : {}), ...(firewall !== undefined ? { firewall } : {}) };
}

/**
 * What every host plan of the machine but a runner-only removal takes: its hardening, and with
 * SSH hardening the pinned host key's algorithm (the SSH settings keep that key).
 */
function hardeningOf(
  harden: RunnerHardening | undefined,
  session: OwnServerSession,
): Pick<DesiredRunnerHost, "harden" | "hostKeyType"> {
  if (harden === undefined) return {};
  return {
    harden,
    ...(harden.ssh
      ? { hostKeyType: session.hostKey.type as DesiredRunnerHost["hostKeyType"] }
      : {}),
  };
}

/**
 * The check after an SSH or firewall change: a new login as the machine's admin works. The deploy
 * user only runs the runners there, with no SSH key, so its login is not checked.
 */
function loginCheck(
  deps: PhaseDeps,
  session: OwnServerSession,
  services: RunnerHostServices | undefined,
): () => Promise<boolean> {
  return (
    services?.verifyLogin ??
    ownServerLoginCheck(deps, session, {
      ...(services?.homeDir !== undefined ? { homeDir: services.homeDir } : {}),
    })
  );
}

/**
 * What `plan` says about the changes the machine undoes on its own unless a new login as `user`
 * works afterwards: its SSH settings, and its SSH firewall unless the plan removes it.
 */
function undoSentence(plan: HostPlan, user: string): string[] {
  const guarded = plan.steps
    .filter(
      (step) =>
        step.state === "change" &&
        (step.id === "sshd" || (step.id === "ssh-firewall" && step.params.remove !== true)),
    )
    .map((step) => (step.id === "sshd" ? "SSH settings" : "SSH firewall"));
  if (guarded.length === 0) return [];
  return [
    `The change of its ${listText(guarded)} undoes itself on the machine unless a new login as ${user} works afterwards.`,
  ];
}

/**
 * The machine's own setup (Docker, the deploy user and the hardening `machine` names), leaving
 * every runner on it as it is; its findings say to run `command` again once fixed.
 */
function setupPlan(
  facts: HostFacts,
  url: string,
  machine: Pick<DesiredRunnerHost, "harden" | "hostKeyType">,
  command: string,
): HostPlan {
  return planRunnerHost(facts, { repositoryUrl: url, runners: [], ...machine }, command);
}

/** Options of {@link addRunnerHost}. */
export interface AddRunnerHostInput {
  /** The machine's name in the project, which plans use (`environment.runnerHost.name`). */
  name: string;
  /** The admin login: root or a user with passwordless sudo, at the machine's address and port. */
  ssh: { user: string; host: string; port?: number };
  /** The private key file (absolute or `~/…`); absent: the key in the SSH agent. */
  keyFile?: string;
  /** `--host-key SHA256:…`: the fingerprint to trust at first contact when nobody can be asked. */
  hostKey?: string;
  /** The change of the machine's hardening (default: as an earlier record of it has it, else none). */
  harden?: RunnerHardeningChange;
  services?: RunnerHostServices;
}

/**
 * `opscrew runner host add <name>`: checks the login, connects with the pinned host key (confirmed
 * at first contact; for the same address and port as an earlier record, the key confirmed then),
 * inspects the machine read-only, and plans its setup with ssh-host's `planRunnerHost`: Docker and
 * the deploy user, the hardening `input.harden` asks for, no environment's runner yet. A plan with
 * blocking findings (a hardening that would lock OpsCrew out among them) stops before anything is
 * recorded; otherwise the record is written (never committed) and the plan returned with its
 * hash, which {@link applyRunnerHost} applies once approved.
 * @throws OpsCrewError `INVALID_INPUT` for a bad name, login or hardening, `PHASE_PRECONDITION`
 * without a GitHub remote, an unsupported CPU, or a plan that cannot be applied.
 */
export async function addRunnerHost(
  deps: PhaseDeps,
  input: AddRunnerHostInput,
): Promise<{ plan: HostPlan; hash: string }> {
  const name = machineName(input.name);
  const parsed = SshLoginSchema.safeParse({
    host: input.ssh.host.trim().replace(/^\[(.*)\]$/, "$1"),
    port: input.ssh.port ?? 22,
    user: input.ssh.user.trim(),
    agent: input.keyFile === undefined,
    ...(input.keyFile !== undefined ? { keyPath: input.keyFile.trim() } : {}),
  });
  if (!parsed.success) {
    // Names the field, never the value: a key file argument may hold something it should not.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The SSH login of the runner machine ${name} is not valid (${listText(fields)}).`,
      {
        hint: "Give --ssh as user@host or user@host:port (an IP address or a host name, and a user such as ana or root), and --key as the full path of your private key file, such as ~/.ssh/id_ed25519. OpsCrew never asks for a password or passphrase.",
      },
    );
  }
  // The name is never the address: replies that hide the address would rewrite the name too.
  const host = normalizeHostName(parsed.data.host);
  if (name === host || name === host.split(".")[0]) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${name}" is the runner machine's address (or its first part), and a runner machine's name ${RUNNER_HOST_NAME_MESSAGE}.`,
      { hint: "Name the machine after what it is, for example home or build-box." },
    );
  }
  const earlier = await readRunnerHost(deps.paths, name);
  const harden = changedHardening(earlier?.harden, input.harden ?? {});
  const sameAddress =
    earlier !== undefined &&
    normalizeHostName(earlier.login.host) === normalizeHostName(parsed.data.host) &&
    earlier.login.port === parsed.data.port;
  const { hostKey: _none, ...login } = parsed.data;
  const known: SshLogin =
    sameAddress && earlier.login.hostKey !== undefined
      ? { ...login, hostKey: earlier.login.hostKey }
      : login;
  const url = await projectRepositoryUrl(deps);
  let pinned = known.hostKey;
  const { session, facts } = await connectMachine(
    deps,
    { name, login: known },
    {
      // Recorded below, with the rest, once the plan can be applied.
      pin: async (hostKey) => {
        pinned = hostKey;
      },
      hostKey: input.hostKey,
      services: input.services,
      phase: "provision",
    },
  );
  const arch = machineArch(facts, name);
  const command = `opscrew runner host add ${name}`;
  const plan = setupPlan(facts, url, hardeningOf(harden, session), command);
  requireNoBlockers(plan, { server: `the runner machine ${name}`, command });
  await writeRunnerHost(deps.paths, {
    schemaVersion: 1,
    name,
    login: { ...known, ...(pinned !== undefined ? { hostKey: pinned } : {}) },
    arch,
    docker: facts.docker.kind !== "absent",
    ...(harden !== undefined ? { harden } : {}),
    environments: earlier?.environments ?? [],
  });
  return { plan, hash: hostPlanHash(plan) };
}

/**
 * `opscrew runner host set <name>`: changes the recorded machine's hardening as `input.harden`
 * says, then connects with the pinned host key, inspects the machine read-only and plans its setup
 * with that hardening: a part turned off is removed. A plan with blocking findings (a hardening
 * that would lock OpsCrew out among them) stops before the record changes; otherwise the record is
 * written and the plan returned with its hash, which {@link applyRunnerHost} applies once approved
 * (with `command: opscrew runner host set <name>`, as this plan has it). The record holds the
 * chosen hardening from then on, applied with the machine's next approved host plan.
 * @throws OpsCrewError `INVALID_INPUT` for a bad hardening, `PHASE_PRECONDITION` for a machine
 * this computer does not know or a plan that cannot be applied.
 */
export async function setRunnerHost(
  deps: PhaseDeps,
  input: { name: string; harden: RunnerHardeningChange; services?: RunnerHostServices },
): Promise<{ plan: HostPlan; hash: string }> {
  const record = await requireRunnerHost(deps.paths, input.name);
  const { name } = record;
  const harden = changedHardening(record.harden, input.harden);
  const url = await projectRepositoryUrl(deps);
  const { session, facts } = await connectRecorded(deps, record, {
    services: input.services,
    phase: "provision",
  });
  const command = `opscrew runner host set ${name}`;
  const plan = setupPlan(facts, url, hardeningOf(harden, session), command);
  requireNoBlockers(plan, { server: `the runner machine ${name}`, command });
  // Read again: the connection may have pinned the host key in the record.
  const { harden: _earlier, ...current } = await requireRunnerHost(deps.paths, name);
  await writeRunnerHost(deps.paths, { ...current, ...(harden !== undefined ? { harden } : {}) });
  return { plan, hash: hostPlanHash(plan) };
}

/** The parts of `harden` in words: `SSH hardening and an SSH firewall`. */
function hardeningWords(harden: RunnerHardening): string {
  return listText([
    ...(harden.ssh ? ["SSH hardening"] : []),
    ...(harden.firewall !== undefined ? ["an SSH firewall"] : []),
  ]);
}

/**
 * Applies the runner machine's setup that {@link addRunnerHost} planned: connects with the pinned
 * host key, inspects and plans again, and refuses unless that plan is exactly the one
 * `approvedHash` names; then shows it and applies it through the host-plan gate (approved by its
 * hash as `host-apply`, never by `--yes`; audited by the hash).
 * @throws OpsCrewError `PLAN_HASH_MISMATCH` when the machine changed since its plan was shown.
 */
export async function applyRunnerHost(
  deps: PhaseDeps,
  input: {
    name: string;
    approvedHash: string;
    /**
     * The command that planned it (`opscrew runner host add <name>`, the default, or `set`): the
     * plan's findings and the messages name it.
     */
    command?: string;
    services?: RunnerHostServices;
  },
): Promise<void> {
  const record = await requireRunnerHost(deps.paths, input.name);
  const { name } = record;
  const url = await projectRepositoryUrl(deps);
  const { session, facts } = await connectRecorded(deps, record, {
    services: input.services,
    phase: "provision",
  });
  const { harden } = record;
  const command = input.command ?? `opscrew runner host add ${name}`;
  const plan = setupPlan(facts, url, hardeningOf(harden, session), command);
  if (hostPlanHash(plan) !== input.approvedHash.toLowerCase()) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The host plan of the runner machine ${name} is no longer the one you approved (${input.approvedHash}): the machine changed since. Nothing was changed.`,
      { hint: `Run \`${command}\` again, review the new plan and approve its hash.` },
    );
  }
  const machine = `the runner machine ${name}`;
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: session.remote,
    apply: input.services?.host?.apply ?? applyHostPlan,
    verifyLogin: loginCheck(deps, session, input.services),
    title: `Set up the runner machine ${name}: Docker${harden === undefined ? " and the deploy user" : `, the deploy user, ${hardeningWords(harden)}`}`,
    server: machine,
    planOf: machine,
    upToDate: `The runner machine ${name} is set up; nothing on it changes.`,
    command,
    phase: "provision",
    intro: [
      `This prepares ${machine} for the GitHub Actions runners of this project's environments. ${harden === undefined ? "OpsCrew hardens its SSH and firewall only when you ask: it may be your desktop." : `As you chose, OpsCrew sets up ${hardeningWords(harden)} there.`}`,
      ...undoSentence(plan, record.login.user),
    ],
    secrets: async () => ({}),
    applying: `Setting up ${machine} (installing Docker can take a few minutes)`,
  });
  await writeRunnerHost(deps.paths, { ...record, docker: true });
  if (outcome.applied) {
    deps.reporter.success(
      `The runner machine ${name} is set up. Choose it for an environment with \`opscrew env set <env> --runner host --runner-host ${name}\`.`,
    );
  }
}

/** Each environment of the app in `root` with its plan. */
async function environmentPlans(root: string): Promise<{ name: string; plan: DeployPlan }[]> {
  const names = await environmentsOf(root);
  return Promise.all(
    names.map(async (name) => ({
      name,
      plan: await readArtifact(
        "plan",
        resolveProjectPaths(root, { env: {}, environment: name }).files.plan,
      ),
    })),
  );
}

/** True when `plan`'s deploy job runs on the runner machine `name`. */
function runsOn(plan: DeployPlan, name: string): boolean {
  return plan.environment?.runner === "host" && plan.environment.runnerHost?.name === name;
}

/** The environments that use the runner machine `name` and are not torn down, by name. */
async function environmentsOn(root: string, name: string): Promise<string[]> {
  return (await environmentPlans(root))
    .filter(({ plan }) => runsOn(plan, name) && plan.deployment.destroyedAt === undefined)
    .map((environment) => environment.name);
}

/**
 * `opscrew runner host remove <name>`: refused while the plan of an environment that is not torn
 * down names the machine. Otherwise connects with the pinned host key, inspects, and takes back
 * what OpsCrew set up there with ssh-host's `planUndo`: this repository's runners (unregistered
 * with a remove token fetched while the plan is applied), deploy's lingering, `/srv/runners` and
 * the deploy user when OpsCrew created them; another repository's runner blocks it, and Docker
 * stays. The plan deletes the deploy user's home folder, so it is approved by its hash as
 * `host-apply` with `allowDestroy` and the machine's name typed; with `approvedHash`, only that
 * exact plan. Then the record and the pinned key are forgotten on this computer. A machine OpsCrew
 * cannot reach is only forgotten, with its runners' registrations at GitHub
 * ({@link forgetMachine}).
 * @throws OpsCrewError `PHASE_PRECONDITION` while an environment uses the machine, and
 * `PLAN_HASH_MISMATCH` when the plan is not the approved one.
 */
export async function removeRunnerHost(
  deps: PhaseDeps,
  input: {
    name: string;
    approvedHash?: string;
    services?: RunnerHostServices;
    runnerGitHub?: RunnerGitHubApi;
  },
): Promise<void> {
  const record = await requireRunnerHost(deps.paths, input.name);
  const { name } = record;
  const command = `opscrew runner host remove ${name}`;
  const users = await environmentsOn(deps.paths.root, name);
  if (users.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The runner machine ${name} runs the deploy jobs of ${listText(users)}, so OpsCrew does not remove it. Nothing was changed.`,
      {
        hint: `Give ${users.length === 1 ? "that environment" : "each of them"} another runner (\`opscrew env set <env> --runner github\`, then \`opscrew provision --env <env>\`) or destroy it (\`opscrew destroy --env <env>\`), then run \`${command}\` again: it removes the runners left on the machine too.`,
      },
    );
  }
  const remote = parseGitHubRepo((await gitClient(deps).remoteUrl("origin")) ?? "");
  const url = remote === undefined ? undefined : repositoryUrl(remote);
  const repo = lazyRepository(deps, input.runnerGitHub);
  let connected: Awaited<ReturnType<typeof connectRecorded>>;
  try {
    connected = await connectRecorded(deps, record, {
      services: input.services,
      phase: "provision",
    });
  } catch (error) {
    if (!unreachable(error)) throw error;
    return forgetMachine(deps, record, repo);
  }
  const { session, facts } = connected;
  const plan = planUndo(facts, url === undefined ? {} : { repositoryUrl: url }, command);
  if (input.approvedHash !== undefined && hostPlanHash(plan) !== input.approvedHash.toLowerCase()) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The plan that takes back the runner machine ${name} is no longer the one you approved (${input.approvedHash}): the machine changed since. Nothing was changed.`,
      { hint: `Run \`${command}\` again, review the new plan and approve its hash.` },
    );
  }
  const machine = `the runner machine ${name}`;
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: session.remote,
    apply: input.services?.host?.apply ?? applyHostPlan,
    verifyLogin: loginCheck(deps, session, input.services),
    title: `Take back what OpsCrew set up on the runner machine ${name}`,
    server: machine,
    planOf: machine,
    upToDate: `Nothing of OpsCrew's is left on ${machine}.`,
    command,
    phase: "provision",
    allowDestroy: true,
    confirmPhrase: name,
    intro: [
      `This removes this project's GitHub Actions runners from ${machine}, and the deploy user OpsCrew created with its home folder and everything in it; this cannot be undone. Docker stays installed (other software may use it), and the machine itself stays.`,
      ...takenOff(plan),
      ...undoSentence(plan, record.login.user),
    ],
    auditAs: "host undo",
    secrets: async () => ({}),
    runnerToken: runnerTokens(deps, repo),
  });
  if (outcome.stillRegistered !== undefined && outcome.stillRegistered.length > 0) {
    deps.reporter.warn(
      `GitHub may still list the runners of ${listText(outcome.stillRegistered)} that OpsCrew removed from ${machine}. Remove them under the repository's Settings → Actions → Runners.`,
    );
  }
  await forgetRecord(deps.paths, name);
  deps.reporter.success(
    `Removed the runner machine ${name}; this computer no longer keeps its login.`,
  );
}

/** What of OpsCrew's hardening the undo `plan` takes off the machine, in words. */
function takenOff(plan: HostPlan): string[] {
  const removes = (id: string) => plan.steps.some((s) => s.id === id && s.state === "change");
  const parts = [
    ...(removes("sshd") ? ["SSH hardening"] : []),
    ...(removes("ssh-firewall") ? ["SSH firewall"] : []),
  ];
  return parts.length === 0 ? [] : [`It also takes off OpsCrew's ${listText(parts)}.`];
}

/** Forgets the runner machine `name` on this computer: its record and its pinned host key. */
async function forgetRecord(paths: ProjectPaths, name: string): Promise<void> {
  await rm(recordFile(paths, name), { force: true });
  await rm(knownHostsFile(paths, name), { force: true });
}

/** True for the stop of a machine OpsCrew cannot reach over SSH (off, gone, or moved). */
function unreachable(error: unknown): boolean {
  return error instanceof OpsCrewError && error.code === "COMMAND_FAILED";
}

/** What a removal OpsCrew could not make on an unreachable machine leaves there. */
const LEFT_ON_MACHINE =
  "OpsCrew's runner folders in /srv/runners, their services and the deploy user stay on the machine; remove them there if you use it again";

/**
 * {@link removeRunnerHost} for a machine OpsCrew cannot reach (off for good, wiped): after the
 * machine's name is typed to confirm, forgets it on this computer and deletes the GitHub
 * registrations of the runners its record lists, each by its exact name and label; nothing on
 * the machine changes, and the warning says what stays there.
 */
async function forgetMachine(
  deps: PhaseDeps,
  record: RunnerHostRecord,
  repo: () => Promise<RunnerRepository>,
): Promise<void> {
  const { name } = record;
  const machine = `the runner machine ${name}`;
  const plans = (await environmentPlans(deps.paths.root)).filter((environment) =>
    record.environments.includes(environment.name),
  );
  const unknown = record.environments.filter((env) => !plans.some((p) => p.name === env));
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Forget the runner machine ${name}, which OpsCrew cannot reach, and delete its runners at GitHub`,
    details: [
      `OpsCrew cannot reach ${machine} over SSH, so it changes nothing there.`,
      plans.length > 0
        ? `It deletes the GitHub registrations of the runners it installed there (${listText(plans.map(({ plan }) => runnerLabel(plan)))}) and forgets the machine on this computer.`
        : "It forgets the machine on this computer.",
      `${LEFT_ON_MACHINE}.`,
    ].join("\n"),
    confirmPhrase: name,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Forgetting ${machine} was not approved${refusalReason(approval)}. Nothing was changed.`,
      {
        hint: `Bring the machine back and run \`opscrew runner host remove ${name}\` again, or run it again and type ${name} to forget it.`,
      },
    );
  }
  for (const { plan } of plans) {
    await deleteRegistrations(deps, await repo(), plan, {
      phase: "provision",
      name: serverRunnerName(plan, record.login.host),
    });
  }
  await forgetRecord(deps.paths, name);
  deps.reporter.warn(
    `Forgot ${machine}, which OpsCrew could not reach${plans.length > 0 ? ", and deleted its runners' registrations at GitHub" : ""}. ${LEFT_ON_MACHINE}.${unknown.length > 0 ? ` GitHub may still list the runners of ${listText(unknown)}, whose plans are gone: remove them under the repository's Settings → Actions → Runners.` : ""}`,
  );
}

/** One runner machine of {@link listRunnerHosts}. */
export interface RunnerHostSummary {
  name: string;
  arch: "amd64" | "arm64";
  /** Docker was installed when OpsCrew last looked. */
  docker: boolean;
  /** The hardening the user chose; absent: none. */
  harden?: RunnerHardening;
  /** The environments whose deploy job runs on it. */
  environments: string[];
}

/** The runner machines this computer knows for the project, by name, with the environments on each. */
export async function listRunnerHosts(
  deps: Pick<PhaseDeps, "paths">,
): Promise<RunnerHostSummary[]> {
  const plans = await environmentPlans(deps.paths.root);
  return (await runnerHostRecords(deps.paths)).map(({ name, arch, docker, harden }) => ({
    name,
    arch,
    docker,
    ...(harden !== undefined ? { harden } : {}),
    environments: plans
      .filter(({ plan }) => runsOn(plan, name))
      .map((environment) => environment.name),
  }));
}

/**
 * Stops when the runner machine is the environment's own server (the same address, or the host
 * key pinned for both): its deploy job belongs on the server's runner then.
 */
export async function requireOtherMachine(
  paths: ProjectPaths,
  record: RunnerHostRecord,
  environment: string,
): Promise<void> {
  const addresses = await readServerAddresses(paths);
  const own = addresses.own;
  const hosts = [
    own?.host,
    own?.publicIpv4,
    own?.publicIpv6,
    addresses.deployment?.ipv4,
    addresses.deployment?.ipv6,
  ].flatMap((host) => (host === undefined ? [] : [normalizeHostName(host)]));
  const sameKey = own?.hostKey !== undefined && own.hostKey === record.login.hostKey;
  if (!sameKey && !hosts.includes(normalizeHostName(record.login.host))) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `The runner machine ${record.name} is the ${environment} environment's own server, so a runner there would be the server's runner.`,
    {
      hint: `Use the server's runner instead (\`opscrew env set ${environment} --runner server\`): the deploy then runs on the server itself.`,
    },
  );
}

/**
 * Stops when the runner machine's CPU, `arch` (from its record or its inspection), is not the one
 * `plan` records for it (`environment.runnerHost.arch`): the runner's archive, and a build there,
 * would be for the wrong CPU.
 */
async function requirePlannedArch(root: string, plan: DeployPlan, arch: string): Promise<void> {
  const host = plan.environment?.runnerHost;
  if (host === undefined || host.arch === arch) return;
  const env = plan.environment?.name ?? "prod";
  const { file, flag } = await planWhere(root, plan);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The runner machine ${host.name} is ${arch}, but ${file} records it as ${host.arch}. Nothing was changed.`,
    {
      hint: `Choose it again with \`opscrew env set ${env} --runner host --runner-host ${host.name}\`, which records its CPU, then run \`opscrew provision${flag}\` again.`,
    },
  );
}

/**
 * Removal of the runner of `input.plan`'s environment from the machine `record` OpsCrew cannot
 * reach (off for good, wiped): its registration at GitHub is deleted by its exact name and label,
 * the record no longer lists the environment, and the warning says that its folder stays on the
 * machine; the run goes on. With `planOnly` it only says so.
 */
async function forgetUnreachableRunner(
  deps: PhaseDeps,
  record: RunnerHostRecord,
  input: {
    plan: DeployPlan;
    phase: PhaseName;
    planOnly?: boolean;
    repo: () => Promise<RunnerRepository>;
  },
): Promise<void> {
  const { plan } = input;
  const app = plan.app.name;
  const machine = `the runner machine ${record.name}`;
  const env = deps.paths.environment;
  const stays = `The runner's folder /srv/runners/${app} and its service stay on the machine: remove them there if you use it again, or run \`opscrew runner host remove ${record.name}\` once it is back.`;
  if (input.planOnly === true) {
    deps.reporter.warn(
      `OpsCrew cannot reach ${machine} over SSH, so applying this run deletes the registration of the runner of ${app} at GitHub instead and no longer counts it there. ${stays}`,
    );
    return;
  }
  const deleted = await deleteRegistrations(deps, await input.repo(), plan, {
    phase: input.phase,
    name: serverRunnerName(plan, record.login.host),
  });
  await recordRunner(deps.paths, record.name, env, false);
  const what =
    deleted > 0
      ? `deleted the registration of the runner of ${app} at GitHub`
      : `found no registration of the runner of ${app} at GitHub`;
  deps.reporter.warn(
    `OpsCrew could not reach ${machine} over SSH, so it ${what} and no longer counts that runner there. ${stays}`,
  );
}

/**
 * Before any change of a provision with `runner: host`: the runner machine is recorded on this
 * computer and is not the environment's own server, and the repository may use a self-hosted
 * runner (a public one only after its own `github-settings` approval, FR-1527). Returns the
 * repository for {@link applyMachineRunner}; none on another runner.
 */
export async function checkMachineRunner(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: MachineRunnerServices,
  run: { phase: PhaseName; command: string; planOnly: boolean },
): Promise<RunnerRepository | undefined> {
  const name = plan.environment?.runner === "host" ? plan.environment.runnerHost?.name : undefined;
  if (name === undefined) return undefined;
  const record = await requireRunnerHost(deps.paths, name);
  await requireOtherMachine(deps.paths, record, deps.paths.environment);
  await requirePlannedArch(deps.paths.root, plan, record.arch);
  const repository = await runnerRepository(deps, services.runnerGitHub);
  await allowRunnerOn(deps, repository, run);
  return repository;
}

/**
 * Provision with `runner: host`: the environment's `github-runner` step on its runner machine's
 * host plan (`planRunnerHost`, with Docker and the deploy user as the machine's setup has them),
 * planned from the machine's inspection over SSH with the pinned host key, shown and approved by
 * that plan's hash as `host-apply`, and applied with a registration token fetched only while the
 * step runs, then recorded in the machine's record. Other environments' runners on the machine
 * stay as they are. `undefined` on another runner; with `planOnly` the plan is only shown and saved.
 */
export async function applyMachineRunner(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: MachineRunnerServices;
    phase: PhaseName;
    command: string;
    planOnly?: boolean;
    /** The repository {@link checkMachineRunner} read. */
    repository?: RunnerRepository | undefined;
  },
): Promise<HostPlanOutcome | undefined> {
  const { plan, services, command } = input;
  const name = plan.environment?.runner === "host" ? plan.environment.runnerHost?.name : undefined;
  if (name === undefined) return undefined;
  const record = await requireRunnerHost(deps.paths, name);
  const repository = input.repository ?? (await runnerRepository(deps, services.runnerGitHub));
  const env = deps.paths.environment;
  let connected: Awaited<ReturnType<typeof connectRecorded>>;
  try {
    connected = await connectRecorded(deps, record, {
      services: services.runnerMachine,
      phase: input.phase,
    });
  } catch (error) {
    if (!(error instanceof OpsCrewError) || !unreachable(error)) throw error;
    // The machine the plan uses stops the run; one that is gone for good is left this way.
    const away = `If the machine is gone for good, move the ${env} environment off it with \`opscrew env set ${env} --runner github\`, then run \`opscrew runner host remove ${name}\`, which forgets it.`;
    throw new OpsCrewError(error.code, error.message, {
      hint: `${error.hint ?? ""} ${away}`.trim(),
      cause: error,
    });
  }
  const { session, facts } = connected;
  const arch = machineArch(facts, name);
  if (arch !== record.arch) await updateRunnerHost(deps.paths, name, (r) => ({ ...r, arch }));
  await requirePlannedArch(deps.paths.root, plan, arch);
  const runner = serverRunner(plan, { arch, host: record.login.host }, repository);
  const app = plan.app.name;
  const hostPlan = planRunnerHost(
    facts,
    {
      repositoryUrl: repositoryUrl(repository),
      runners: [{ app, runner }],
      ...hardeningOf(record.harden, session),
    },
    command,
  );
  const machine = `the runner machine ${name}`;
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote: session.remote,
    apply: services.runnerMachine?.host?.apply ?? applyHostPlan,
    verifyLogin: loginCheck(deps, session, services.runnerMachine),
    title: `Install the GitHub Actions runner of ${app} on the runner machine ${name}, run as deploy`,
    server: machine,
    planOf: machine,
    upToDate: `The runner of ${app} on ${machine} is installed and running as planned; nothing on it changes.`,
    command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    runnerToken: runnerTokens(deps, async () => repository),
    applying: `Installing the GitHub Actions runner of ${app} on ${machine}`,
  });
  if (input.planOnly === true) return outcome;
  await recordRunner(deps.paths, name, deps.paths.environment, true);
  if (outcome.applied) {
    deps.reporter.success(
      `The runner of ${app} is installed on ${machine}; the deploy job runs there now and reaches the server over SSH.`,
    );
  }
  return outcome;
}

/**
 * The environment's runner alone comes off the recorded runner machine `record`
 * (`planRunnerHost` with only its removal), unregistered with a remove token fetched while the
 * plan is applied, approved by that plan's hash as `host-apply`; other environments' runners and
 * the machine's setup stay. A registration GitHub kept is deleted through its API, and the
 * machine's record no longer lists the environment. A machine OpsCrew cannot reach is left as it
 * is ({@link forgetUnreachableRunner}: only the registration goes) and gives no outcome. With
 * `planOnly` the plan is only shown and saved.
 */
async function removeRunnerFrom(
  deps: PhaseDeps,
  record: RunnerHostRecord,
  input: {
    plan: DeployPlan;
    services: MachineRunnerServices;
    phase: PhaseName;
    command: string;
    planOnly?: boolean;
  },
): Promise<HostPlanOutcome | undefined> {
  const { plan, services, command } = input;
  const { name } = record;
  const app = plan.app.name;
  const repo = lazyRepository(deps, services.runnerGitHub);
  const url = await projectRepositoryUrl(deps);
  let connected: Awaited<ReturnType<typeof connectRecorded>>;
  try {
    connected = await connectRecorded(deps, record, {
      services: services.runnerMachine,
      phase: input.phase,
    });
  } catch (error) {
    if (!unreachable(error)) throw error;
    await forgetUnreachableRunner(deps, record, { ...input, repo });
    return undefined;
  }
  const { session, facts } = connected;
  // A runner-only removal leaves the machine's hardening as it is.
  const hostPlan = planRunnerHost(facts, { repositoryUrl: url, runners: [{ app }] }, command);
  const machine = `the runner machine ${name}`;
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote: session.remote,
    apply: services.runnerMachine?.host?.apply ?? applyHostPlan,
    verifyLogin: loginCheck(deps, session, services.runnerMachine),
    title: `Remove the GitHub Actions runner of ${app} from the runner machine ${name}`,
    server: machine,
    planOf: machine,
    upToDate: `${upperFirst(machine)} has no runner of ${app}; nothing on it changes.`,
    command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    runnerToken: runnerTokens(deps, repo),
    applying: `Removing the GitHub Actions runner of ${app} from ${machine}`,
  });
  if (input.planOnly === true) return outcome;
  await recordRunner(deps.paths, name, deps.paths.environment, false);
  if (!outcome.applied) return outcome;
  if (outcome.stillRegistered !== undefined) {
    await removeKeptRegistrations(deps, repo, plan, {
      phase: input.phase,
      stillRegistered: outcome.stillRegistered,
      host: record.login.host,
      machine: name,
    });
  }
  deps.reporter.success(`Removed the runner of ${app} from ${machine}.`);
  return outcome;
}

/**
 * Provision: the environment's runner comes off each runner machine whose record lists it but
 * that its plan no longer names (a switch to GitHub's machines, the server's runner or another
 * machine), through {@link removeRunnerFrom}: one host plan per machine, approved by its hash.
 * A machine OpsCrew cannot reach loses only the registration, and the run goes on. Returns their
 * outcomes; none when no other machine has its runner.
 */
async function leaveRunnerMachines(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: MachineRunnerServices;
    phase: PhaseName;
    command: string;
    planOnly?: boolean;
  },
): Promise<HostPlanOutcome[]> {
  const { plan } = input;
  const current =
    plan.environment?.runner === "host" ? plan.environment.runnerHost?.name : undefined;
  const outcomes: HostPlanOutcome[] = [];
  for (const record of await runnerHostRecords(deps.paths)) {
    if (record.name === current || !record.environments.includes(deps.paths.environment)) continue;
    const outcome = await removeRunnerFrom(deps, record, input);
    if (outcome !== undefined) outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Provision's runner machine plans: the environment's runner removed from each machine it left
 * ({@link leaveRunnerMachines}), then, with `runner: host`, installed on its machine
 * ({@link applyMachineRunner}). Returns their outcomes in that order.
 */
export async function provisionRunnerMachines(
  deps: PhaseDeps,
  input: Parameters<typeof applyMachineRunner>[1],
): Promise<HostPlanOutcome[]> {
  const left = await leaveRunnerMachines(deps, input);
  const installed = await applyMachineRunner(deps, input);
  return installed === undefined ? left : [...left, installed];
}

/**
 * Destroy: the environment's runner comes off its runner machine (`runner: host`) and off every
 * other machine whose record lists it ({@link removeRunnerFrom}), each by its own plan's hash; one
 * OpsCrew cannot reach loses only the registration, and the teardown goes ahead.
 * Without the record of its plan's machine on this computer nothing is changed there, and the
 * warning says what to remove by hand. Returns the outcomes.
 */
export async function removeMachineRunners(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: MachineRunnerServices;
    phase: PhaseName;
    command: string;
  },
): Promise<HostPlanOutcome[]> {
  const { plan } = input;
  const name = plan.environment?.runner === "host" ? plan.environment.runnerHost?.name : undefined;
  if (name !== undefined && (await readRunnerHost(deps.paths, name)) === undefined) {
    const app = plan.app.name;
    deps.reporter.warn(
      `This computer has no record of the runner machine ${name}, so OpsCrew cannot remove the runner of ${app} from it. Remove that runner under the repository's Settings → Actions → Runners, and delete /srv/runners/${app} on the machine.`,
    );
  }
  const outcomes: HostPlanOutcome[] = [];
  for (const record of await runnerHostRecords(deps.paths)) {
    if (record.name !== name && !record.environments.includes(deps.paths.environment)) continue;
    const outcome = await removeRunnerFrom(deps, record, input);
    if (outcome !== undefined) outcomes.push(outcome);
  }
  return outcomes;
}
