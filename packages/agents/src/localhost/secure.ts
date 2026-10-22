/**
 * `opscrew secure` for the localhost target (FR-1508): only what applies to a local stack, read
 * with this computer's Docker and files: the edge on 127.0.0.1 only, the containers hardened as
 * OpsCrew runs them, the local CA's key and the env files readable by the user alone, and the app's
 * leaf certificate. A server's hardening does not apply here, and the report says so.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "@opscrew/contracts";
import { exists, listText, upperFirst } from "@opscrew/core";
import { EDGE_PROJECT } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { checkResult } from "../shared";
import { caFiles, leafState } from "./ca";
import { projectObjects } from "./docker";
import { appFolder, composeProject, computer, type LocalhostServices } from "./services";
import { servedSite } from "./site";

/** What `opscrew secure` says of this computer, whose own security stays the user's. */
export const LOCAL_SECURE_NOTES = [
  "OpsCrew does not harden this computer: a server's checks (its SSH settings, firewall, fail2ban, automatic security updates and kernel settings) do not apply to a local stack, and this computer's own security stays yours.",
  "OpsCrew does not back up the app's data volumes on this computer.",
] as const;

/** Why `opscrew secure` probes no port of this computer. */
export const LOCAL_PROBES_SKIPPED =
  "OpsCrew probes no port of this computer from outside: the stack listens on 127.0.0.1 only, which the checks above confirm.";

/** One container as `docker inspect` describes what could reach beyond it. */
interface Inspected {
  name: string;
  privileged: boolean;
  /** Shares the host's network or process namespace. */
  hostNamespace: boolean;
  noNewPrivileges: boolean;
  dockerSocket: boolean;
}

/** `docker inspect` of `names`, read-only; none when Docker does not answer. */
async function inspect(deps: Pick<PhaseDeps, "runner">, names: readonly string[]) {
  if (names.length === 0) return [];
  const result = await deps.runner.run(
    "docker",
    [
      "inspect",
      "--format",
      "{{.Name}}|{{.HostConfig.Privileged}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.PidMode}}|{{json .HostConfig.SecurityOpt}}|{{range .Mounts}}{{.Source}} {{end}}",
      ...names,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line): Inspected => {
      const [name = "", privileged, network, pid, options = "", mounts = ""] = line.split("|");
      return {
        name: name.replace(/^\//, ""),
        privileged: privileged === "true",
        hostNamespace: network === "host" || pid === "host",
        noNewPrivileges: /no-new-privileges(:true)?"/.test(options),
        dockerSocket: mounts.includes("docker.sock"),
      };
    });
}

/** The file's mode bits, or `undefined` when it does not exist. */
async function mode(file: string): Promise<number | undefined> {
  return (await stat(file).catch(() => undefined))?.mode;
}

/**
 * The localhost target's security checks, read-only. On Windows, where files have no POSIX modes,
 * the two file checks say they do not apply.
 */
export async function localSecurityChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LocalhostServices = {},
): Promise<CheckResult[]> {
  const windows = computer(deps, services).platform === "win32";
  const app = await projectObjects(deps, composeProject(plan));
  const edge = await projectObjects(deps, EDGE_PROJECT);
  const checks: CheckResult[] = [];

  const published = [...app.containers, ...edge.containers].flatMap((container) =>
    container.ports
      .split(",")
      .map((port) => port.trim())
      .filter((port) => port.includes("->") && !port.startsWith("127.0.0.1:"))
      .map((port) => `${container.name} ${port}`),
  );
  checks.push(
    checkResult(
      "local-loopback",
      "Only this computer reaches the stack (127.0.0.1)",
      "high",
      published.length === 0 ? "pass" : "fail",
      published.length === 0
        ? "Every published port is bound to 127.0.0.1."
        : `Published beyond 127.0.0.1: ${listText(published)}.`,
      published.length === 0
        ? {}
        : { remediation: "Run `opscrew provision`: it starts the stack on 127.0.0.1 again." },
    ),
  );

  const inspected = await inspect(
    deps,
    [...app.containers, ...edge.containers].map((container) => container.name),
  );
  const loose = inspected.flatMap((c) => [
    ...(c.privileged ? [`${c.name} is privileged`] : []),
    ...(c.hostNamespace ? [`${c.name} shares the host's network or processes`] : []),
    ...(c.dockerSocket ? [`${c.name} has the Docker socket`] : []),
    ...(c.noNewPrivileges ? [] : [`${c.name} may gain new privileges`]),
  ]);
  checks.push(
    inspected.length === 0
      ? checkResult(
          "local-containers",
          "The stack's containers are hardened",
          "high",
          "skip",
          "Nothing of the app runs on this computer, so no container was checked.",
        )
      : checkResult(
          "local-containers",
          "The stack's containers are hardened",
          "high",
          loose.length === 0 ? "pass" : "fail",
          loose.length === 0
            ? `${inspected.length} containers run without privileges, host namespaces or the Docker socket, and cannot gain privileges.`
            : `Not as OpsCrew runs them: ${listText(loose)}.`,
          loose.length === 0
            ? {}
            : {
                remediation: "Run `opscrew provision`: it starts the stack as OpsCrew renders it.",
              },
        ),
  );

  const key = await mode(caFiles(deps.paths).key);
  checks.push(
    windows || key === undefined
      ? checkResult(
          "local-ca-key",
          "Only you can read the local CA's key",
          "high",
          "skip",
          key === undefined
            ? "This computer has no local CA yet."
            : "Windows keeps it in your user folder; POSIX file modes do not apply there.",
        )
      : checkResult(
          "local-ca-key",
          "Only you can read the local CA's key",
          "high",
          (key & 0o077) === 0 ? "pass" : "fail",
          (key & 0o077) === 0
            ? "~/.opscrew/local-ca/ca.key is readable by you alone (0600)."
            : `~/.opscrew/local-ca/ca.key has mode ${(key & 0o777).toString(8)}.`,
          (key & 0o077) === 0 ? {} : { remediation: "Run `chmod 600 ~/.opscrew/local-ca/ca.key`." },
        ),
  );

  const folder = appFolder(deps.paths, plan);
  const envFiles = (await exists(folder))
    ? (await readdir(folder)).filter((name) => name.endsWith(".env") && !name.startsWith("."))
    : [];
  const open: string[] = [];
  for (const name of envFiles) {
    const bits = await mode(join(folder, name));
    if (bits !== undefined && (bits & 0o077) !== 0) open.push(name);
  }
  checks.push(
    windows || envFiles.length === 0
      ? checkResult(
          "local-env-files",
          "Only you can read the app's env files",
          "medium",
          "skip",
          envFiles.length === 0
            ? "The app has no env files on this computer yet."
            : "Windows keeps them in your user folder; POSIX file modes do not apply there.",
        )
      : checkResult(
          "local-env-files",
          "Only you can read the app's env files",
          "medium",
          open.length === 0 ? "pass" : "fail",
          open.length === 0
            ? `${listText(envFiles)} are readable by you alone (0600).`
            : `Readable by others: ${listText(open)}.`,
          open.length === 0
            ? {}
            : {
                remediation:
                  "Run `opscrew provision`: it writes them again, readable by you alone.",
              },
        ),
  );

  const site = await servedSite(deps.paths, plan);
  const leaf = await leafState(deps.paths, plan, site.hostname, deps.clock.now());
  checks.push(
    checkResult(
      "local-certificate",
      "The site's certificate is valid and from OpsCrew's local CA",
      "medium",
      leaf.action === "keep" ? "pass" : "warn",
      leaf.action === "keep"
        ? `${site.hostname}: ${leaf.detail}.`
        : `${site.hostname}: ${upperFirst(leaf.detail)}.`,
      leaf.action === "keep"
        ? {}
        : { remediation: "Run `opscrew provision`: it issues a new one." },
    ),
  );
  return checks;
}
