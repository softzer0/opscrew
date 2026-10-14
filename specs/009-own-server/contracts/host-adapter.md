# Contract: `@opscrew/connector-ssh-host`

Owned by T902. Consumers (agents) import only from the package root.

```ts
import type { RemoteExec } from "@opscrew/contracts";

export interface HostFacts { /* see data-model.md "Host facts"; zod-validated. Also: directory logins
  (nsswitch/PAM/AuthorizedKeysCommand), Compose projects of containers (running or stopped) and volumes,
  an interrupted dpkg, ufw default policies, dockerd flags and Swarm state */ }

/** In apply order; `package-repair` appears first only when an earlier run left dpkg interrupted. */
export type HostStepId =
  | "package-repair" | "docker" | "docker-daemon" | "deploy-user" | "sshd" | "ufw" | "fail2ban"
  | "unattended-upgrades" | "runtime-dirs" | "app-marker" | "tunnel-connector" | "portainer";

export interface HostStep {
  id: HostStepId;
  /** Plain English, e.g. "Install Docker Engine 28.x from Docker's repository". */
  title: string;
  state: "in-place" | "change" | "blocked";
  /** Why it is blocked, or what is already there. */
  reason?: string;
  /** Non-secret parameters the step's script uses (ports, user names, versions). */
  params: Readonly<Record<string, string | number | boolean>>;
}

export interface HostFinding { code: string; message: string; hint: string }

export interface HostPlan {
  schemaVersion: 1;
  purpose: "setup" | "teardown" | "undo";
  app: string;
  steps: readonly HostStep[];
  findings: readonly HostFinding[];
  deleteData?: boolean;
}

export interface DesiredHost {
  app: string;
  projectId: string;
  admin: { user: string; isRoot: boolean };
  deploy: { user: "deploy"; publicKey: string };
  sshPort: number;
  access: "public" | "tunnel";
  /** Required in tunnel mode: the connector's Compose file and the (non-secret) tunnel id. */
  tunnel?: { compose: string; tunnelId: string };
  /** Compose files for the first start (initial admin secret) and afterwards. */
  portainer?: { version: string; compose: { initial: string; final: string } };
  /** The user's explicit choice when other logins still use passwords (else the step blocks). */
  disablePasswords?: boolean;
}

/** Read-only commands only; never changes the server. */
export function inspectHost(remote: RemoteExec): Promise<HostFacts>;
export function planHost(facts: HostFacts, desired: DesiredHost): HostPlan;
/** The Portainer step alone, for Hetzner/DigitalOcean (run as `deploy` in its home) or own servers. */
export function planPortainer(/* facts, desired portainer, directory, run-as user */): HostPlan;
export function planTeardown(facts: HostFacts, opts: { deleteData: boolean }): HostPlan;
export function planUndo(facts: HostFacts): HostPlan;
/** SHA-256 of the canonical JSON of the plan. */
export function hostPlanHash(plan: HostPlan): string;

export interface ApplyOptions {
  /** The hash the user approved; apply refuses any other plan. */
  approvedHash: string;
  /** Supplied at apply, never part of the plan. */
  secrets?: { tunnelToken?: string; portainerPassword?: string };
  /** Opens NEW connections (deploy user, admin login); true when both work. */
  verifyLogin: () => Promise<boolean>;
  /** Seconds before the server undoes an sshd/ufw change on its own (default 180). */
  deadManSeconds?: number;
  /** Recorded as `opscrewVersion` (default: the package's version). */
  version?: string;
  /** Clock for the record's timestamps (tests). */
  now?: () => Date;
}

export interface ApplyResult { applied: HostStepId[]; skipped: HostStepId[] }

/** Throws OpsCrewError PLAN_HASH_MISMATCH on a hash mismatch, PHASE_PRECONDITION on a blocked step or a claimed server. */
export function applyHostPlan(remote: RemoteExec, plan: HostPlan, opts: ApplyOptions): Promise<ApplyResult>;
```

Rules:

- Every command is a fixed template; parameters are shell-quoted; no command text comes from a
  model or from the server's own output.
- Secrets reach the server only through a root-only file written over the SSH connection's stdin
  (never on a command line, which other users can see in the process list) and are never logged,
  audited or included in errors.
- `sshd` and `ufw` changes: schedule the undo with `systemd-run --on-active`, apply, call
  `verifyLogin`, cancel the undo only on success; otherwise wait for (or trigger) the undo and fail
  the step with a plain message.
- Every applied change appends to `/etc/opscrew/host.json` with the previous value before it is made.
- Teardown and add-on removal never rely on the login's working directory: an explicit project
  directory and Compose file, or removal by the `com.docker.compose.project` label.
- A setup apply re-checks the server's claim before its first change and refuses another app's server.
