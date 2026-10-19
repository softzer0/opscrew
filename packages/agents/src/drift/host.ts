import {
  appDirs,
  type HASHED_RUNTIME_FILES,
  type HostFacts,
  type HostPlan,
  type HostStep,
  type HostStepId,
  MIN_DOCKER_MAJOR,
  planHost,
  type RuntimeFileName,
  runtimeFilePath,
  SECRET_RUNTIME_FILES,
  SHARED_DIRS,
  tunnelDir,
  tunnelOf,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
} from "@opscrew/connector-ssh-host";
import { listText, lowerFirst, sha256Hex, upperFirst } from "@opscrew/core";
import {
  DEPLOY_SECRETS,
  keepNewerPins,
  type RenderContext,
  renderCaddyfile,
  renderCompose,
  serviceSpec,
} from "@opscrew/iac-templates";
import { type DeployPlan, serviceOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { desiredHost, type OwnServerServices, ownTarget } from "../provision";
import { type OwnWebSources, ownWebFromCloudflare, ownWebSources } from "../provision/own";
import { readRequirements } from "../provision/render";
import type { CloudflareApi } from "../provision/types";
import { committedText, lastHostSetup, passwordLoginChoice, readDeployPublicKey } from "../shared";
import { connectAndInspectOwnServer } from "../shared/own-server";

/** One way the user's own server differs from what OpsCrew set up. Never a secret or an address. */
export interface HostDifference {
  /** The host step it belongs to; `record` for OpsCrew's host record, `app` for the app's containers and runtime files, `server` for other findings. */
  area: HostStepId | "record" | "app" | "server";
  /** What OpsCrew set up, in plain English. */
  title: string;
  /** What differs now, in plain English. */
  detail: string;
  /**
   * True when `opscrew provision` puts it back (a step of its host plan: SSH settings, OpsCrew's
   * ufw rules and an incoming "allow", the deploy user, the web filter, the connector, Portainer…).
   * False for what provision leaves alone (ufw rules added later, other default policies, the
   * runtime files and containers the deploy workflow writes, OpsCrew's record, what blocks
   * provision): those say their own next step where there is one.
   */
  restoredByProvision: boolean;
}

/** Host drift of a server the user owns (FR-911): every difference found, in host-step order. */
export interface HostDrift {
  differences: HostDifference[];
}

const AREA_TITLES: Readonly<Record<HostStepId, string>> = {
  "package-repair": "Packages",
  docker: "Docker",
  "docker-daemon": "Docker daemon settings (/etc/docker/daemon.json)",
  "deploy-user": "The deploy user",
  "deploy-key": "The app's deploy key",
  sshd: "SSH settings",
  ufw: "Firewall (ufw)",
  "web-filter": "Web filter (only Cloudflare reaches ports 80 and 443)",
  fail2ban: "Brute-force protection (fail2ban)",
  "unattended-upgrades": "Automatic security updates",
  "runtime-dirs": "Shared folders (/srv/edge, /srv/apps and /srv/data)",
  "app-dirs": "The app's folders (in /srv/apps and /srv/data)",
  "app-record": "The app's record (in /etc/opscrew/apps)",
  edge: "The shared edge (/srv/edge)",
  "tunnel-connector": "Cloudflare Tunnel connector",
  portainer: "Portainer",
};

const RUNTIME_FILES_TITLE = "OpsCrew's runtime files of the app";

function portList(value: string | number | boolean | undefined): string[] {
  return String(value ?? "")
    .split(" ")
    .filter((port) => port !== "");
}

function dockerDetails(facts: HostFacts): string[] {
  const docker = facts.docker;
  if (docker.kind === "absent") return ["Docker is not installed."];
  const out: string[] = [];
  const major = Number((docker.version ?? "").split(".")[0]);
  if (docker.version === null || !(major >= MIN_DOCKER_MAJOR)) {
    out.push(
      `Docker Engine ${docker.version ?? "(unknown version)"} is older than ${MIN_DOCKER_MAJOR}.`,
    );
  }
  if (!docker.composePlugin || !docker.buildxPlugin) {
    out.push("The Docker Compose or Buildx plugin is missing.");
  }
  if (!docker.running) out.push("Docker is not running.");
  return out;
}

function deployUserDetails(facts: HostFacts): string[] {
  const user = facts.deployUser;
  if (user === null) {
    return ["The deploy user no longer exists, so deploys from GitHub Actions cannot log in."];
  }
  return user.groups.includes("docker")
    ? []
    : ["The deploy user is no longer in the docker group."];
}

function deployKeyDetails(facts: HostFacts, step: HostStep): string[] {
  const user = facts.deployUser;
  // Said by the deploy user's own step.
  if (user === null) return [];
  const keys = String(step.params.keys ?? "")
    .split("\n")
    .filter((key) => key !== "");
  const id = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");
  const missing = keys.filter((key) => !user.keys.some((line) => id(line) === id(key)));
  if (user.keys.length === 0) {
    return ["The deploy user's authorized_keys no longer holds the deploy key."];
  }
  if (missing.length > 0) {
    return ["The deploy user's authorized_keys does not hold this project's deploy key."];
  }
  if (user.keys.length > keys.length) {
    return [
      `The deploy user's authorized_keys holds ${user.keys.length} keys; OpsCrew set up only the deploy key.`,
    ];
  }
  return [];
}

function sshdDetails(facts: HostFacts, step: HostStep): string[] {
  const sshd = facts.sshd;
  if (sshd === null) return ["OpsCrew could not read the SSH settings (sshd -T failed)."];
  const out: string[] = [];
  const root = String(step.params.permitRootLogin ?? "");
  if (root !== "" && sshd.permitRootLogin !== root) {
    out.push(`PermitRootLogin is ${sshd.permitRootLogin}; OpsCrew set ${root}.`);
  }
  if (step.params.disablePasswords === true && sshd.passwordAuthentication) {
    out.push("Password logins are on again.");
  }
  if (step.params.kbdInteractiveOff === true && sshd.kbdInteractiveAuthentication) {
    out.push("Keyboard-interactive logins are on again.");
  }
  if (sshd.dropIn === null) {
    out.push("OpsCrew's SSH settings file /etc/ssh/sshd_config.d/10-opscrew.conf is missing.");
  } else if (out.length === 0 && !facts.pendingUndo.sshd) {
    out.push("OpsCrew's SSH settings file /etc/ssh/sshd_config.d/10-opscrew.conf was edited.");
  }
  if (facts.pendingUndo.sshd) {
    out.push(
      "An automatic undo of an SSH change from an interrupted run is still waiting on the server.",
    );
  }
  return out;
}

function ufwDetails(facts: HostFacts, step: HostStep): string[] {
  const out: string[] = [];
  if (facts.firewall.ufw === "absent") out.push("ufw is no longer installed.");
  else if (facts.firewall.ufw === "inactive") out.push("The firewall (ufw) is off.");
  const ssh = portList(step.params.sshRulePorts);
  if (facts.firewall.ufw === "active" && ssh.length > 0) {
    out.push(`ufw no longer lets SSH in on port ${listText(ssh)}.`);
  }
  const web = portList(step.params.webRules);
  if (facts.firewall.ufw === "active" && web.length > 0) {
    out.push(`ufw no longer allows web traffic (${listText(web)}).`);
  }
  if (
    step.params.web === false &&
    facts.firewall.ufwRules.some((rule) => rule.comment === "opscrew-web")
  ) {
    out.push(
      "ufw still lets web traffic in, although the app is served through the Cloudflare Tunnel.",
    );
  }
  if (facts.pendingUndo.ufw) {
    out.push(
      "An automatic undo of a firewall change from an interrupted run is still waiting on the server.",
    );
  }
  // Without OpsCrew's record of ufw, the default policy is told here (else by ufwSinceSetup).
  if (step.params.denyIncoming === true && firstSetupEntry(facts, "ufw") === undefined) {
    out.push(
      'ufw lets every incoming connection in: its default policy for incoming traffic is "allow". `opscrew provision` sets it to deny.',
    );
  }
  return out;
}

/** The (IPv4) ranges a web-filter step lets in. */
function filterRanges(step: Pick<HostStep, "params"> | undefined): string[] | undefined {
  if (step === undefined || typeof step.params.ipv4 !== "string") return undefined;
  return String(step.params.ipv4).split(" ").filter(Boolean);
}

const NEXT_STEP =
  "Run `opscrew provision`: it shows the change and applies it only after you approve it.";

/**
 * The web filter differs from what the plan wants now: removed or edited on the server, its unit
 * off, Cloudflare's ranges changed since the last applied host plan (`applied`), or a filter left
 * although the site is no longer served directly behind Cloudflare's proxy.
 */
function webFilterDetails(facts: HostFacts, step: HostStep, applied?: HostPlan): string[] {
  if (step.params.remove === true) {
    return [
      "OpsCrew's web filter is still on the server, although the site is no longer served directly behind Cloudflare's proxy, so visitors who do not come through Cloudflare cannot reach it.",
    ];
  }
  const wf = facts.webFilter;
  const wanted = filterRanges(step) ?? [];
  const before = filterRanges(applied?.steps.find((item) => item.id === "web-filter"));
  const sameAs = (list: readonly string[]) =>
    list.length === wanted.length && list.every((net) => wanted.includes(net));
  const out: string[] = [];
  if (wf.files.script === null && wf.rules4.chain === null) {
    return [
      `The web filter is missing, so visitors can reach your server around Cloudflare. ${NEXT_STEP}`,
    ];
  }
  if (before !== undefined && !sameAs(before)) {
    const added = wanted.filter((net) => !before.includes(net)).length;
    const dropped = before.filter((net) => !wanted.includes(net)).length;
    const parts = [
      ...(added > 0 ? [`${added} new`] : []),
      ...(dropped > 0 ? [`${dropped} no longer listed`] : []),
    ];
    out.push(
      `Cloudflare's IP ranges changed since the last provision (${parts.join(", ")}), and the filter still lets in only the old list. ${NEXT_STEP}`,
    );
  } else {
    if (wf.files.dropIn === null) {
      out.push(
        `Docker no longer requires the web filter (the docker.service.d drop-in is missing), so after a restart Docker could publish the web ports without it. ${NEXT_STEP}`,
      );
    }
    if (!wf.enabled || !wf.active) {
      out.push(`The web filter's unit is not enabled and running. ${NEXT_STEP}`);
    }
    const chain = wf.rules4.chain;
    if (chain === null || !chain.dropsRest || chain.other > 0) {
      out.push(`OpsCrew's chain OPSCREW-WEB was removed or edited. ${NEXT_STEP}`);
    } else if (wf.rules4.dockerUser.leading.length < 3) {
      out.push(
        `OpsCrew's jumps are no longer the first rules of DOCKER-USER, so another rule may let visitors in around Cloudflare. ${NEXT_STEP}`,
      );
    }
  }
  return out;
}

/** The first setup entry of `step` in OpsCrew's host record: the value before OpsCrew's change. */
function firstSetupEntry(facts: HostFacts, step: HostStepId) {
  return facts.record?.changes.find((entry) => entry.step === step && entry.purpose === "setup");
}

/** ufw words that start a rule in `ufw show added`; a comma elsewhere is part of a port list. */
const UFW_RULE_START = /^(allow|deny|reject|limit|route|insert|prepend)\b/;

/** The record's `rules` (`ufw show added` without `ufw ` and comments, comma-joined). */
function recordedRules(value: string | number | boolean | undefined): Set<string> {
  const rules: string[] = [];
  for (const part of String(value ?? "").split(",")) {
    const text = part.trim();
    if (text === "") continue;
    const last = rules.length - 1;
    // `allow 80,443/tcp` was split at its port list: put it back together.
    if (!UFW_RULE_START.test(text) && last >= 0) rules[last] = `${rules[last]},${text}`;
    else rules.push(text);
  }
  return new Set(rules);
}

/** A ufw rule as shown in drift: addresses in it are replaced, so none is ever printed. */
function shownRule(rule: string): string {
  return rule
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g, "<address>")
    .replace(
      /(?<![\w:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:\/\d{1,3})?(?![\w:])/g,
      "<address>",
    );
}

const UFW_POLICY_WORDS = /^(allow|deny|reject)$/;

/** A ufw change since OpsCrew's setup, and whether `opscrew provision` puts it back. */
interface UfwChange {
  detail: string;
  restoredByProvision: boolean;
}

/**
 * What changed in ufw since OpsCrew set the server up, from the first setup entry of OpsCrew's host
 * record (FR-911): rules added afterwards (the current rules minus the rules that were there before
 * OpsCrew minus OpsCrew's own commented rules), and default policies other than the ones OpsCrew
 * left (deny incoming and allow outgoing when it turned ufw on, deny incoming when ufw was on but
 * let everything in, else the ones it found). `opscrew provision` removes none of the user's rules
 * and resets no policy other than an incoming "allow" (its ufw `step` sets `denyIncoming` then):
 * that one says provision sets it back; every other change comes with what to do.
 */
function ufwSinceSetup(facts: HostFacts, step: HostStep): UfwChange[] {
  const entry = firstSetupEntry(facts, "ufw");
  if (entry === undefined || facts.firewall.ufw === "absent") return [];
  const out: UfwChange[] = [];
  const before = recordedRules(entry.previous.rules);
  const ours = new Set<string | null>([UFW_SSH_COMMENT, UFW_WEB_COMMENT]);
  const added = [
    ...new Set(
      facts.firewall.ufwRules
        .filter((rule) => !ours.has(rule.comment) && !before.has(rule.rule))
        .map((rule) => rule.rule),
    ),
  ];
  for (const rule of added) {
    out.push({
      detail: `ufw has a rule that was added after OpsCrew set the server up: ${shownRule(rule)}. If you added it on purpose, nothing needs to change; otherwise find it with \`sudo ufw status numbered\` on the server and remove it with \`sudo ufw delete <number>\`.`,
      restoredByProvision: false,
    });
  }
  const current = facts.firewall.ufwDefaults;
  if (current === null) return out;
  const turnedOn = entry.previous.active === false;
  const previous = (key: string) => {
    const value = entry.previous[key];
    return typeof value === "string" && UFW_POLICY_WORDS.test(value) ? value : undefined;
  };
  // OpsCrew also set deny incoming when ufw was on but let everything in.
  const setDeny = turnedOn || previous("defaultIncoming") === "allow";
  const expected = {
    incoming: setDeny ? "deny" : previous("defaultIncoming"),
    outgoing: turnedOn ? "allow" : previous("defaultOutgoing"),
    routed: previous("defaultRouted"),
  };
  const setByOpsCrew = { incoming: setDeny, outgoing: turnedOn, routed: false };
  const traffic = { incoming: "incoming", outgoing: "outgoing", routed: "routed (forwarded)" };
  // Provision's host plan sets an incoming "allow" back to deny, and no other policy.
  const deniesIncoming =
    step.state === "change" && step.params.denyIncoming === true && current.incoming === "allow";
  for (const key of ["incoming", "outgoing", "routed"] as const) {
    const wanted = expected[key];
    if (wanted === undefined || current[key] === wanted) continue;
    const source = setByOpsCrew[key]
      ? `OpsCrew set ${wanted}`
      : `it was ${wanted} when OpsCrew set the server up`;
    if (key === "incoming" && deniesIncoming && wanted === "deny") {
      out.push({
        detail: `ufw's default policy for incoming traffic is allow; ${source}. \`opscrew provision\` sets it to deny again.`,
        restoredByProvision: true,
      });
      continue;
    }
    out.push({
      detail: `ufw's default policy for ${traffic[key]} traffic is ${current[key]}; ${source}. If you changed it on purpose, nothing needs to change; otherwise put it back with \`sudo ufw default ${wanted} ${key}\` on the server.`,
      restoredByProvision: false,
    });
  }
  return out;
}

/** What OpsCrew renders now for the runtime files the deploy workflow copies to the server. */
export interface ExpectedRuntimeFiles {
  /** SHA-256 of each rendered file (`compose.yaml`, the `site`) as OpsCrew renders it now. */
  rendered: Readonly<Partial<Record<(typeof HASHED_RUNTIME_FILES)[number], string>>>;
  /** The deploy workflow writes `db.env` (the plan has PostgreSQL). */
  dbEnv: boolean;
}

/**
 * The SHA-256 of `opscrew/runtime/compose.yaml` and the app's site file
 * (`opscrew/runtime/edge/sites/<app>.caddy`) as OpsCrew renders them from `plan` now (the deploy
 * workflow copies exactly these to the app's folder and the shared edge). Both read only the plan
 * and the contact email for certificates, so no secret and no connection is needed. The Compose
 * file keeps the newer pins of `committedCompose`, its committed copy (FR-1222).
 */
export function expectedRuntimeFiles(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "opscrewVersion" | "acmeEmail">,
  committedCompose = "",
): ExpectedRuntimeFiles {
  // The site file does not depend on the repository or the deploy key (a test checks both files
  // match the full render), so these stay empty here.
  const full: RenderContext = {
    opscrewVersion: ctx.opscrewVersion,
    github: { owner: "", repo: "" },
    deploySshPublicKey: "",
    ...(ctx.acmeEmail !== undefined ? { acmeEmail: ctx.acmeEmail } : {}),
  };
  return {
    rendered: {
      "compose.yaml": sha256Hex(keepNewerPins(committedCompose, renderCompose(plan).content)),
      site: sha256Hex(renderCaddyfile(plan, full).content),
    },
    dbEnv: serviceOf(plan, "postgres") !== undefined,
  };
}

const REDEPLOY =
  "Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.";

/** Why each of the app's runtime files matters, said when it is missing. */
const RUNTIME_FILE_ROLE: Readonly<Record<RuntimeFileName, string>> = {
  "compose.yaml": "which defines the app's containers",
  site: "the app's site on the shared web server",
  ".env": "which names the image the app runs",
  "app.env": `the app's settings from the GitHub secret ${DEPLOY_SECRETS.appEnv}`,
  "db.env": `the database's settings from the GitHub secret ${DEPLOY_SECRETS.dbEnv}`,
};

/**
 * How OpsCrew's runtime files of the app (in its folder, and its site on the shared edge) differ
 * from what OpsCrew renders now (FR-911, US4/AC1): a rendered file edited, replaced or missing,
 * and a file with secrets missing, owned by someone else than deploy, or readable by other users.
 * Files that hold secrets are compared by presence, owner and mode only; no file content is ever
 * read. Missing files count only once the app was deployed (the deploy workflow writes them on
 * its first run). Other apps' files are never looked at.
 */
function runtimeFileDetails(
  facts: HostFacts,
  app: string,
  expected: ExpectedRuntimeFiles,
  deployed: boolean,
): string[] {
  const folder = appDirs(app).app;
  // No app folder at all is reported with the app's folders already.
  if (facts.dirs.find((dir) => dir.path === folder)?.kind !== "dir") return [];
  const out: string[] = [];
  for (const file of facts.runtimeFiles.filter((item) => item.app === app)) {
    const path = runtimeFilePath(app, file.name);
    const wanted = (expected.rendered as Record<string, string | undefined>)[file.name];
    const secret = (SECRET_RUNTIME_FILES as readonly string[]).includes(file.name);
    if (file.name === "db.env" && !expected.dbEnv) continue;
    if (file.kind === "absent") {
      if (deployed) out.push(`${path} (${RUNTIME_FILE_ROLE[file.name]}) is missing. ${REDEPLOY}`);
      continue;
    }
    if (file.kind !== "file") {
      out.push(
        `${path} is no longer a regular file (it is a symbolic link or something else), so OpsCrew does not look into it. Remove it on the server, then ${lowerFirst(REDEPLOY)}`,
      );
      continue;
    }
    if (wanted !== undefined && file.sha256 !== wanted) {
      out.push(
        `${path} differs from what OpsCrew renders from opscrew/plan.yaml now: it was edited on the server, or the deploy workflow has not copied the current version yet. ${REDEPLOY}`,
      );
    }
    if (secret && file.name !== ".env") {
      if (file.owner !== "deploy") {
        out.push(
          `${path} is owned by ${file.owner ?? "?"}:${file.group ?? "?"}, so the deploy workflow (which logs in as deploy) may not be able to replace it. Run \`chown deploy:deploy ${path}\` as root on the server.`,
        );
      }
      if (!/^0?[0-7]00$/.test(file.mode ?? "")) {
        out.push(
          `${path} holds secrets but other users on the server can read it (mode ${file.mode ?? "?"}). Run \`chmod 600 ${path}\` on the server.`,
        );
      }
    }
  }
  return out;
}

function fail2banDetails(facts: HostFacts): string[] {
  if (!facts.packages.fail2ban) return ["fail2ban is no longer installed."];
  if (!facts.fail2ban.active) return ["fail2ban is not running."];
  return [
    "OpsCrew's fail2ban jail for SSH (/etc/fail2ban/jail.d/opscrew.local) is missing or was edited.",
  ];
}

function upgradesDetails(facts: HostFacts): string[] {
  if (!facts.packages.unattendedUpgrades) return ["unattended-upgrades is no longer installed."];
  const out: string[] = [];
  if (!facts.autoUpgrades) out.push("Daily security updates are turned off in apt's settings.");
  if (!facts.autoUpgradesService) out.push("The unattended-upgrades service is disabled.");
  return out;
}

/** How the folders `paths` differ from what OpsCrew set up (deploy:deploy, mode 750). */
function dirDetails(facts: HostFacts, paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const dir = facts.dirs.find((item) => item.path === path);
    if (dir === undefined || dir.kind === "absent") return [`${path} is missing.`];
    if (dir.kind !== "dir") return [`${path} is no longer a directory.`];
    if (dir.owner === "deploy" && dir.group === "deploy" && dir.mode === "750") return [];
    return [
      `${path} is owned by ${dir.owner ?? "?"}:${dir.group ?? "?"} with mode ${dir.mode ?? "?"}; OpsCrew set deploy:deploy and 750.`,
    ];
  });
}

function appRecordDetails(facts: HostFacts, app: string): string[] {
  if (!facts.apps.some((item) => item.name === app)) {
    return [`The app's record /etc/opscrew/apps/${app}.json is missing.`];
  }
  return facts.ready ? [] : ["The setup-finished flag /var/lib/opscrew-ready is missing."];
}

/** The app's own tunnel connector; other apps' connectors are theirs to check. */
function tunnelDetails(facts: HostFacts, step: HostStep, app: string): string[] {
  const tunnel = tunnelOf(facts, app);
  if (step.params.remove === true) {
    return [
      "The app's tunnel connector is still on the server, although the app is served directly now.",
    ];
  }
  if (!tunnel.installed) {
    return [`The tunnel connector's files in ${tunnelDir(app)} are missing.`];
  }
  const out: string[] = [];
  if (tunnel.tunnelId !== null && tunnel.tunnelId !== step.params.tunnelId) {
    out.push("The connector runs for another tunnel than the one OpsCrew created.");
  }
  if (tunnel.composeSha256 !== sha256Hex(String(step.params.compose ?? ""))) {
    out.push("The connector's Compose file was edited.");
  }
  if (!tunnel.secretFile) out.push("The connector's token file is missing.");
  if (!tunnel.running) {
    out.push("The tunnel connector is not running, so the app cannot be reached.");
  }
  return out;
}

function portainerDetails(facts: HostFacts, step: HostStep): string[] {
  const portainer = facts.portainer;
  if (step.params.remove === true) {
    return ["Portainer is still on the server, although it is turned off for this project."];
  }
  if (!portainer.installed) return ["Portainer's files in /srv/opscrew/portainer are missing."];
  const out: string[] = [];
  if (portainer.composeSha256 !== sha256Hex(String(step.params.composeFinal ?? ""))) {
    out.push("Portainer's Compose file was edited.");
  }
  if (!portainer.running) out.push("Portainer is not running.");
  if (portainer.secretFile) out.push("Portainer's one-time password file is still on the server.");
  return out;
}

/** What differs for one step of `app`'s setup plan that is not in place, in plain English. */
function stepDetails(facts: HostFacts, step: HostStep, app: string, applied?: HostPlan): string[] {
  switch (step.id) {
    case "package-repair":
      return ["A package installation stopped part-way (dpkg was interrupted)."];
    case "docker":
      return dockerDetails(facts);
    case "docker-daemon":
      return [
        "/etc/docker/daemon.json with OpsCrew's settings (log rotation, no-new-privileges, live-restore) is missing.",
      ];
    case "deploy-user":
      return deployUserDetails(facts);
    case "deploy-key":
      return deployKeyDetails(facts, step);
    case "sshd":
      return sshdDetails(facts, step);
    case "ufw":
      return ufwDetails(facts, step);
    case "web-filter":
      return webFilterDetails(facts, step, applied);
    case "fail2ban":
      return fail2banDetails(facts);
    case "unattended-upgrades":
      return upgradesDetails(facts);
    case "runtime-dirs":
      return dirDetails(facts, SHARED_DIRS);
    case "app-dirs": {
      const dirs = appDirs(app);
      return dirDetails(facts, [dirs.app, dirs.data]);
    }
    case "app-record":
      return appRecordDetails(facts, app);
    // Only in a teardown: never in the setup plan drift compares with.
    case "edge":
      return [];
    case "tunnel-connector":
      return tunnelDetails(facts, step, app);
    case "portainer":
      return portainerDetails(facts, step);
  }
}

const STARTS_COMPONENTS =
  "Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it starts every component.";

/** A component of the plan that runs as a container: its Compose service and what it is. */
export interface PlannedComponent {
  /** The Compose service: `app`, a worker's name, `cron`, a service's name. */
  service: string;
  /** In words: `the web process`, `the worker`, `the cron jobs`, `MySQL`. */
  what: string;
}

/**
 * The plan's components that run as containers of the app's Compose project (FR-1331): the web
 * process, every enabled worker, the cron jobs when one is enabled, and every enabled service.
 */
export function plannedComponents(plan: DeployPlan): PlannedComponent[] {
  return [
    { service: "app", what: "the web process" },
    ...plan.processes.workers
      .filter((worker) => worker.enabled)
      .map((worker) => ({ service: worker.name, what: "the worker" })),
    ...(plan.processes.cron.some((job) => job.enabled)
      ? [{ service: "cron", what: "the cron jobs" }]
      : []),
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => ({ service: service.name, what: serviceSpec(service.kind).title })),
  ];
}

/**
 * How the app's containers differ from its planned components: a component with no container
 * (once the app was deployed), and a container of a component the plan no longer runs. A
 * container's Compose service is its name without the project (`<app>-`) and the copy number;
 * one-off containers (`docker compose run`, the release command) are left out.
 */
function componentDetails(
  app: string,
  containers: readonly HostFacts["containers"][number][],
  components: readonly PlannedComponent[],
  deployed: boolean,
): string[] {
  const running = new Set(
    containers.flatMap((container) => {
      const service = new RegExp(`^${app}-(.+)-\\d+$`).exec(container.name)?.[1];
      return service === undefined || service.includes("-run-") ? [] : [service];
    }),
  );
  const planned = new Set(components.map((component) => component.service));
  const out: string[] = [];
  if (deployed) {
    for (const { service, what } of components) {
      if (running.has(service)) continue;
      out.push(
        `${upperFirst(what)} (${service}) is in opscrew/plan.yaml but has no container on the server. ${STARTS_COMPONENTS}`,
      );
    }
  }
  for (const service of [...running].sort()) {
    if (planned.has(service) || service === "release") continue;
    out.push(
      `${service} runs on the server but is not a component in opscrew/plan.yaml any more (turned off or removed there): the next deploy removes it.`,
    );
  }
  return out;
}

/**
 * Every difference between the inspected server and what OpsCrew set up: OpsCrew's host record,
 * each step of the setup plan `setup` (planned from the same facts and the desired state) that is
 * not in place, ufw rules and default policies changed since OpsCrew's setup (from its record),
 * OpsCrew's runtime files of the app (with `app.runtimeFiles`), the plan's findings (a blocked
 * step always has one), and the app's containers. Only `app`'s own parts and the shared ones are
 * compared; other OpsCrew apps on the server are theirs to check.
 * `applied` (the last setup plan the user approved) tells a change of Cloudflare's IP ranges from
 * a filter someone changed on the server. Pure; holds no secret and no address.
 */
export function hostDifferences(
  facts: HostFacts,
  setup: HostPlan,
  app: {
    name: string;
    deployed: boolean;
    /** What OpsCrew renders now for the app folder ({@link expectedRuntimeFiles}); unset skips. */
    runtimeFiles?: ExpectedRuntimeFiles;
    /** The plan's components that run as containers ({@link plannedComponents}); unset skips. */
    components?: readonly PlannedComponent[];
  },
  applied?: HostPlan,
): HostDifference[] {
  const out: HostDifference[] = [];
  const record = {
    area: "record" as const,
    title: "OpsCrew's record of its changes (/etc/opscrew/host.json)",
    restoredByProvision: false,
  };
  if (facts.recordDamaged) {
    out.push({
      ...record,
      detail: "is damaged, so `opscrew destroy --undo-host` cannot tell what to put back.",
    });
  } else if (facts.record === null) {
    out.push({
      ...record,
      detail: "is missing, so `opscrew destroy --undo-host` cannot tell what to put back.",
    });
  } else if (!facts.record.apps.includes(app.name)) {
    out.push({ ...record, detail: `does not list the OpsCrew app "${app.name}".` });
  }
  for (const step of setup.steps) {
    const ufwSince = step.id === "ufw" ? ufwSinceSetup(facts, step) : [];
    if (step.state === "change") {
      const details = stepDetails(facts, step, app.name, applied);
      // A default policy OpsCrew set (and the setup plan sets again) is told by ufwSince.
      const shown =
        details.length > 0 || ufwSince.length > 0
          ? details
          : [step.reason ?? "differs from OpsCrew's setup."];
      // A step of provision's host plan: provision puts these back.
      for (const detail of shown) {
        out.push({ area: step.id, title: AREA_TITLES[step.id], detail, restoredByProvision: true });
      }
    }
    // Changes since OpsCrew's setup, from its record, whatever the step's state.
    for (const change of ufwSince) out.push({ area: "ufw", title: AREA_TITLES.ufw, ...change });
    if (step.id === "app-dirs" && app.runtimeFiles !== undefined) {
      for (const detail of runtimeFileDetails(facts, app.name, app.runtimeFiles, app.deployed)) {
        out.push({ area: "app", title: RUNTIME_FILES_TITLE, detail, restoredByProvision: false });
      }
    }
  }
  // What stops provision: it changes nothing on the server until these are fixed.
  for (const finding of setup.findings) {
    out.push({
      area: "server",
      title: "What OpsCrew found",
      detail: `${finding.message} ${finding.hint}`,
      restoredByProvision: false,
    });
  }
  const containers = facts.containers.filter((container) => container.project === app.name);
  if (containers.length > 0 && app.components !== undefined) {
    for (const detail of componentDetails(app.name, containers, app.components, app.deployed)) {
      out.push({ area: "app", title: "The app's components", detail, restoredByProvision: false });
    }
  }
  const stopped = containers.filter((container) => !container.running).map((c) => c.name);
  if (stopped.length > 0) {
    out.push({
      area: "app",
      title: "The app's containers",
      detail: `${listText(stopped)} ${stopped.length === 1 ? "is" : "are"} stopped.`,
      restoredByProvision: false,
    });
  } else if (containers.length === 0 && app.deployed) {
    out.push({
      area: "app",
      title: "The app's containers",
      detail:
        "No container of the app exists on the server; the deploy workflow starts them on its next run.",
      restoredByProvision: false,
    });
  }
  return out;
}

/**
 * Host drift of a server the user owns: connects with the pinned host key (`connectOwnServer`;
 * `--host-key` on the first connection from this computer), inspects the server read-only and
 * compares it with OpsCrew's host record and with the setup the plan describes (the same desired
 * state provision plans from, and the password-login choice of the last applied host plan).
 * Never changes the server; the inspection is audited without the address.
 */
export async function ownHostDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: {
    own?: OwnServerServices;
    hostKey?: string;
    tunnelId?: string;
    /** Reads Cloudflare's current IP ranges (default: Cloudflare's public endpoint). */
    cloudflare?: Pick<CloudflareApi, "getIpRanges"> | null;
  },
): Promise<HostDrift> {
  const deployPublicKey = await readDeployPublicKey(
    deps,
    "cannot compare your server with its setup",
  );
  const { session, facts } = await connectAndInspectOwnServer(deps, {
    hostKey: options.hostKey,
    services: options.own,
    detail: "drift check",
  });
  const setup = await lastHostSetup(deps, plan);
  const passwordLogins = passwordLoginChoice(setup, facts);
  const tunnelId = options.tunnelId ?? tunnelOf(facts, plan.app.name).tunnelId ?? undefined;
  const webSources = await driftWebSources(deps, plan, options.cloudflare, setup, facts);
  const desired = await desiredHost(
    deps,
    {
      session,
      facts,
      target: ownTarget(plan),
      ...(webSources !== undefined ? { webSources } : {}),
    },
    {
      plan,
      deployPublicKey,
      ...(tunnelId !== undefined ? { tunnelId } : {}),
      ...(passwordLogins !== undefined ? { passwordLogins } : {}),
    },
  );
  const contactEmail = (await readRequirements(deps))?.contactEmail;
  const runtimeFiles = expectedRuntimeFiles(
    plan,
    { opscrewVersion: deps.version, ...(contactEmail ? { acmeEmail: contactEmail } : {}) },
    await committedText(deps.paths.root, [renderCompose(plan).path]),
  );
  return {
    differences: hostDifferences(
      facts,
      // Its findings say what stops `opscrew provision`, which puts the setup back.
      planHost(facts, desired, "opscrew provision"),
      {
        name: plan.app.name,
        deployed: plan.deployment.lastDeployAt !== undefined,
        runtimeFiles,
        components: plannedComponents(plan),
      },
      setup,
    ),
  };
}

/**
 * Served directly behind Cloudflare's proxy: Cloudflare's current ranges, so a change of
 * Cloudflare's list shows as drift. When they cannot be read, the comparison uses the ranges of
 * the last applied host plan (or OpsCrew's chain on the server) and says so, instead of reporting
 * a difference nobody made; with neither, the error that Cloudflare could not be read stops.
 */
async function driftWebSources(
  deps: PhaseDeps,
  plan: DeployPlan,
  cloudflare: Pick<CloudflareApi, "getIpRanges"> | null | undefined,
  setup: HostPlan | undefined,
  facts: HostFacts,
): Promise<OwnWebSources | undefined> {
  if (!ownWebFromCloudflare(plan)) return undefined;
  try {
    return await ownWebSources(deps, plan, cloudflare);
  } catch (error) {
    const applied = filterRanges(setup?.steps.find((step) => step.id === "web-filter"));
    const known = applied ?? facts.webFilter.rules4.chain?.sources ?? [];
    if (known.length === 0) throw error;
    deps.reporter.warn(
      "OpsCrew could not read Cloudflare's current IP ranges, so it compared the web filter with the ranges of the last provision. Run `opscrew drift` again when Cloudflare's API is reachable to see whether Cloudflare's list changed.",
    );
    return { ipv4: known };
  }
}
