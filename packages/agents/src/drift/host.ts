import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type HostFacts,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
  inspectHost,
  planHost,
  webFilterFacts,
} from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  connectOwnServer,
  desiredHost,
  hostPlanFile,
  type OwnServerServices,
  ownTarget,
} from "../provision";
import { type OwnWebSources, ownWebFromCloudflare, ownWebSources } from "../provision/own";
import type { CloudflareApi } from "../provision/types";

/** One way the user's own server differs from what OpsCrew set up. Never a secret or an address. */
export interface HostDifference {
  /** The host step it belongs to; `record` for OpsCrew's host record, `app` for the app's containers, `server` for other findings. */
  area: HostStepId | "record" | "app" | "server";
  /** What OpsCrew set up, in plain English. */
  title: string;
  /** What differs now, in plain English. */
  detail: string;
}

/** Host drift of a server the user owns (FR-911): every difference found, in host-step order. */
export interface HostDrift {
  differences: HostDifference[];
}

/**
 * The last setup host plan the user approved and OpsCrew applied (`plan.approvals` of kind
 * `host-apply`, newest first, read from `.opscrew/plans/host-<hash>.json`), or `undefined` when
 * none is on this computer. Plans of other purposes (teardown, undo) and plans without the SSH step
 * (an add-on alone) are skipped.
 */
export async function lastHostSetup(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "approvals">,
): Promise<HostPlan | undefined> {
  const hashes = plan.approvals
    .filter((approval) => approval.kind === "host-apply")
    .map((approval) => approval.planHash)
    .reverse();
  for (const hash of hashes) {
    const text = await readFile(hostPlanFile(deps.paths, hash), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = HostPlanSchema.safeParse(json);
    if (!parsed.success) continue;
    if (parsed.data.purpose === "setup" && parsed.data.steps.some((step) => step.id === "sshd")) {
      return parsed.data;
    }
  }
  return undefined;
}

/**
 * The user's choice about password logins when OpsCrew set the server up: from the last applied
 * setup plan, else from OpsCrew's own SSH settings file on the server; `undefined` when unknown.
 */
export function passwordLoginChoice(
  setup: HostPlan | undefined,
  facts?: Pick<HostFacts, "sshd">,
): "off" | "keep" | undefined {
  const chosen = setup?.steps.find((step) => step.id === "sshd")?.params.disablePasswords;
  if (chosen === true) return "off";
  if (chosen === false) return "keep";
  const dropIn = facts?.sshd?.dropIn;
  if (dropIn?.startsWith("# Managed by OpsCrew")) {
    return /^\s*PasswordAuthentication\s+no\s*$/im.test(dropIn) ? "off" : "keep";
  }
  return undefined;
}

const AREA_TITLES: Readonly<Record<HostStepId, string>> = {
  "package-repair": "Packages",
  docker: "Docker",
  "docker-daemon": "Docker daemon settings (/etc/docker/daemon.json)",
  "deploy-user": "The deploy user",
  sshd: "SSH settings",
  ufw: "Firewall (ufw)",
  "web-filter": "Web filter (only Cloudflare reaches ports 80 and 443)",
  fail2ban: "Brute-force protection (fail2ban)",
  "unattended-upgrades": "Automatic security updates",
  "runtime-dirs": "Runtime directories (/srv/app and /srv/data)",
  "app-marker": "App marker (/etc/opscrew/app.json)",
  "tunnel-connector": "Cloudflare Tunnel connector",
  portainer: "Portainer",
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function words(list: readonly string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

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
  if (docker.version === null || !(major >= 28)) {
    out.push(`Docker Engine ${docker.version ?? "(unknown version)"} is older than 28.`);
  }
  if (!docker.composePlugin || !docker.buildxPlugin) {
    out.push("The Docker Compose or Buildx plugin is missing.");
  }
  if (!docker.running) out.push("Docker is not running.");
  return out;
}

function deployUserDetails(facts: HostFacts, step: HostStep): string[] {
  const user = facts.deployUser;
  if (user === null) {
    return ["The deploy user no longer exists, so deploys from GitHub Actions cannot log in."];
  }
  const out: string[] = [];
  if (!user.groups.includes("docker"))
    out.push("The deploy user is no longer in the docker group.");
  const key = String(step.params.publicKey ?? "");
  const id = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");
  const hasKey = user.keys.some((line) => id(line) === id(key));
  if (user.keys.length === 0) {
    out.push("The deploy user's authorized_keys no longer holds the deploy key.");
  } else if (!hasKey) {
    out.push("The deploy user's authorized_keys does not hold this project's deploy key.");
  } else if (user.keys.length > 1) {
    out.push(
      `The deploy user's authorized_keys holds ${user.keys.length} keys; OpsCrew set up only the deploy key.`,
    );
  }
  return out;
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
    out.push(`ufw no longer lets SSH in on port ${words(ssh)}.`);
  }
  const web = portList(step.params.webRules);
  if (facts.firewall.ufw === "active" && web.length > 0) {
    out.push(`ufw no longer allows web traffic (${words(web)}).`);
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
  const wf = webFilterFacts(facts);
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

function runtimeDetails(facts: HostFacts): string[] {
  return facts.dirs.flatMap((dir) => {
    if (dir.kind === "absent") return [`${dir.path} is missing.`];
    if (dir.kind !== "dir") return [`${dir.path} is no longer a directory.`];
    if (dir.owner === "deploy" && dir.group === "deploy" && dir.mode === "750") return [];
    return [
      `${dir.path} is owned by ${dir.owner ?? "?"}:${dir.group ?? "?"} with mode ${dir.mode ?? "?"}; OpsCrew set deploy:deploy and 750.`,
    ];
  });
}

function markerDetails(facts: HostFacts): string[] {
  if (facts.marker === null) return ["The marker /etc/opscrew/app.json is missing."];
  return facts.ready ? [] : ["The setup-finished flag /var/lib/opscrew-ready is missing."];
}

function tunnelDetails(facts: HostFacts, step: HostStep): string[] {
  const tunnel = facts.tunnel;
  if (step.params.remove === true) {
    return [
      "The tunnel connector is still on the server, although the app is served directly now.",
    ];
  }
  if (!tunnel.installed) {
    return ["The tunnel connector's files in /srv/opscrew/cloudflared are missing."];
  }
  const out: string[] = [];
  if (tunnel.tunnelId !== null && tunnel.tunnelId !== step.params.tunnelId) {
    out.push("The connector runs for another tunnel than the one OpsCrew created.");
  }
  if (tunnel.composeSha256 !== sha256(String(step.params.compose ?? ""))) {
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
  if (portainer.composeSha256 !== sha256(String(step.params.composeFinal ?? ""))) {
    out.push("Portainer's Compose file was edited.");
  }
  if (!portainer.running) out.push("Portainer is not running.");
  if (portainer.secretFile) out.push("Portainer's one-time password file is still on the server.");
  return out;
}

/** What differs for one step that is not in place, in plain English. */
function stepDetails(facts: HostFacts, step: HostStep, applied?: HostPlan): string[] {
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
      return deployUserDetails(facts, step);
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
      return runtimeDetails(facts);
    case "app-marker":
      return markerDetails(facts);
    case "tunnel-connector":
      return tunnelDetails(facts, step);
    case "portainer":
      return portainerDetails(facts, step);
  }
}

/**
 * Every difference between the inspected server and what OpsCrew set up: OpsCrew's host record,
 * each step of the setup plan `setup` (planned from the same facts and the desired state) that is
 * not in place, the plan's findings (a blocked step always has one), and the app's containers.
 * `applied` (the last setup plan the user approved) tells a change of Cloudflare's IP ranges from
 * a filter someone changed on the server. Pure; holds no secret and no address.
 */
export function hostDifferences(
  facts: HostFacts,
  setup: HostPlan,
  app: { name: string; projectId: string; deployed: boolean },
  applied?: HostPlan,
): HostDifference[] {
  const out: HostDifference[] = [];
  const record = {
    area: "record" as const,
    title: "OpsCrew's record of its changes (/etc/opscrew/host.json)",
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
  } else if (facts.record.app !== app.name) {
    out.push({ ...record, detail: `belongs to the OpsCrew app "${facts.record.app}".` });
  }
  for (const step of setup.steps) {
    if (step.state !== "change") continue;
    const details = stepDetails(facts, step, applied);
    const shown = details.length > 0 ? details : [step.reason ?? "differs from OpsCrew's setup."];
    for (const detail of shown) out.push({ area: step.id, title: AREA_TITLES[step.id], detail });
  }
  for (const finding of setup.findings) {
    out.push({ area: "server", title: "What OpsCrew found", detail: finding.message });
  }
  const containers = facts.containers.filter((container) => container.project === app.name);
  const stopped = containers.filter((container) => !container.running).map((c) => c.name);
  if (stopped.length > 0) {
    out.push({
      area: "app",
      title: "The app's containers",
      detail: `${words(stopped)} ${stopped.length === 1 ? "is" : "are"} stopped.`,
    });
  } else if (containers.length === 0 && app.deployed) {
    out.push({
      area: "app",
      title: "The app's containers",
      detail:
        "No container of the app exists on the server; the deploy workflow starts them on its next run.",
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
  const own = options.own ?? {};
  const deployPublicKey = (
    await readFile(deps.paths.files.deployKeyPub, "utf8").catch(() => "")
  ).trim();
  if (deployPublicKey === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The project's deploy key is not on this computer, so OpsCrew cannot compare your server with its setup. Nothing was checked.",
      {
        hint: `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${deps.paths.files.deployKey} and ${deps.paths.files.deployKeyPub}, then try again.`,
      },
    );
  }
  deps.reporter.step("Connecting to your server");
  const session = await connectOwnServer(deps, {
    ...(options.hostKey !== undefined ? { hostKey: options.hostKey } : {}),
    ...(own.remote !== undefined ? { remote: own.remote } : {}),
    ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
  });
  deps.reporter.step("Inspecting your server (read-only)");
  const facts = own.host?.inspect
    ? await own.host.inspect(session.remote)
    : await inspectHost(session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    target: "own server",
    decision: "allow",
    detail: "drift check",
  });
  const setup = await lastHostSetup(deps, plan);
  const passwordLogins = passwordLoginChoice(setup, facts);
  const tunnelId = options.tunnelId ?? facts.tunnel.tunnelId ?? undefined;
  const webSources = await driftWebSources(deps, plan, options.cloudflare, setup, facts);
  const desired = desiredHost(
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
  return {
    differences: hostDifferences(
      facts,
      planHost(facts, desired),
      {
        name: plan.app.name,
        projectId: deps.paths.projectId,
        deployed: plan.deployment.lastDeployAt !== undefined,
      },
      setup,
    ),
  };
}

/**
 * Served directly behind Cloudflare's proxy: Cloudflare's current ranges, so a change of
 * Cloudflare's list shows as drift. When they cannot be read, the comparison uses the ranges of
 * the last applied host plan (or OpsCrew's chain on the server) and says so, instead of reporting
 * a difference nobody made.
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
  } catch {
    deps.reporter.warn(
      "OpsCrew could not read Cloudflare's current IP ranges, so it compared the web filter with the ranges of the last provision. Run `opscrew drift` again when Cloudflare's API is reachable to see whether Cloudflare's list changed.",
    );
    const applied = filterRanges(setup?.steps.find((step) => step.id === "web-filter"));
    const known = applied ?? webFilterFacts(facts).rules4.chain?.sources ?? [];
    // Nothing known at all: Cloudflare's list cannot be guessed, and the filter is missing anyway.
    return { ipv4: known.length > 0 ? known : ["0.0.0.0/32"] };
  }
}
