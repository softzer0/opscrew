# Contract: `@opscrew/connector-ssh-host`

Owned by T902. Consumers (agents) import only from the package root.

```ts
import type { RemoteExec } from "@opscrew/contracts";

export interface HostFacts { /* see data-model.md "Host facts"; zod-validated. Also: directory logins
  (nsswitch/PAM/AuthorizedKeysCommand), Compose projects of containers (running or stopped) and volumes,
  an interrupted dpkg, ufw default policies, dockerd flags and Swarm state, and `runtimeFiles`: for
  OpsCrew's files in /srv/app the SHA-256 of compose.yaml and the Caddyfile, and for the files holding
  secrets (.env, app.env, db.env) only presence, owner and mode (never their contents) */ }

/** In apply order; `package-repair` appears first only when an earlier run left dpkg interrupted. */
export type HostStepId =
  | "package-repair" | "docker" | "docker-daemon" | "deploy-user" | "sshd" | "ufw" | "web-filter" | "fail2ban"
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
  steps: HostStep[];
  findings: HostFinding[];
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
  /**
   * Only when the site is served directly behind Cloudflare's proxy (the user's explicit choice):
   * Cloudflare's current IPv4 ranges, sorted and de-duplicated, for the `web-filter` step (the site
   * is published on IPv4 only in this mode, so nothing listens on IPv6 80/443).
   */
  webFilter?: { ipv4: string[] };
  /** The user's explicit choice when other logins still use passwords (else the step blocks). */
  disablePasswords?: boolean;
}

/** Read-only commands only; never changes the server. */
export function inspectHost(remote: RemoteExec): Promise<HostFacts>;
export function planHost(facts: HostFacts, desired: DesiredHost): HostPlan;
/** The Portainer step alone, for Hetzner/DigitalOcean (run as `deploy` in its home) or own servers. */
export function planPortainer(/* facts, desired portainer, directory, run-as user */): HostPlan;
/** `app`: the plan's app name, used when the server's app marker is missing (after the host record). */
export function planTeardown(facts: HostFacts, opts: { deleteData: boolean; app: string }): HostPlan;
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

/** Throws OpsCrewError PLAN_HASH_MISMATCH on a hash mismatch, PHASE_PRECONDITION on a blocked step or a claimed server;
 *  HostApplyError {applied} (same code, message and hint) when a step fails part-way (T1021). */
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
- The undo plan deletes the OpsCrew-created `deploy` user and its home, so it is approved with
  `allowDestroy` and the typed app name (Constitution I), separately from the teardown.
- `web-filter`: a chain in Docker's IPv4 `DOCKER-USER` that passes connections whose
  original destination port is 80 or 443 only from the given ranges and drops the rest, installed
  by a unit that runs before Docker and that Docker requires (fail closed: no filter, no Docker);
  other published ports and the user's own rules are untouched; undo removes the chain, its jump
  and the unit.
