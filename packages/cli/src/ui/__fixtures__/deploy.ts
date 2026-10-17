/**
 * The CLI side of the deploy command tests (`provision`, `dns`, `secure`, `verify`): a git project
 * from the harness whose GitHub `origin` pushes to a local bare repository, a command runner for
 * resolved binaries, the provision services wired to `@opscrew/agents/testing`'s fakes, a
 * hardened server and a healthy site. Tests only.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProvisionServices } from "@opscrew/agents";
import {
  type FakeEngine,
  type FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  HOST_KEY,
  readyRemote,
  recordTestServer,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  FetchLike,
  RemoteExec,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { git, type TempProject, tempProject } from "./harness";

/** The fakes `provision` and `dns` need: engine, cloud provider, GitHub, Cloudflare, SSH and waits. */
export function provisionServices(
  engine: FakeEngine,
  github: FakeGitHub,
  extra: ProvisionServices = {},
): ProvisionServices {
  return {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    sharedCloudflare: fakeSharedCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    ...extra,
  };
}

/**
 * Real git; `ssh-keyscan` answers with {@link HOST_KEY}; the outside SSH password probe is refused
 * with "publickey" only. Everything else (scanners, `gh`) reports "not found". Commands arrive as
 * the CLI resolved them (absolute paths, `.exe` on Windows).
 */
export class DeployRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly calls: string[][] = [];

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    this.calls.push([name, ...args]);
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    if (name === "ssh" && args.includes("PubkeyAuthentication=no")) {
      return {
        exitCode: 255,
        stdout: "",
        stderr: `deploy@${SERVER_IPV4}: Permission denied (publickey).`,
      };
    }
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** A temp git project with a committed Dockerfile, `opscrew/plan.yaml` and a bare push target. */
export interface DeployProject extends TempProject {
  /** Bare repository that receives pushes to `origin`. */
  bare: string;
}

/**
 * Creates a {@link DeployProject} for `plan` (see {@link writeProjectPlan}); by default the
 * shared test plan without a secret the user supplies.
 */
export async function deployProject(
  plan: DeployPlan = testPlan({ userSecret: false }),
): Promise<DeployProject> {
  const project = await tempProject();
  const bare = path.join(project.dir, "remote.git");
  await git(project.env, project.dir, "init", "-q", "--bare", "-b", "main", bare);
  await git(project.env, project.root, "init", "-q", "-b", "main");
  await git(project.env, project.root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(project.env, project.root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(path.join(project.root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(path.join(project.root, ".gitignore"), ".opscrew/\n.env\n");
  await git(project.env, project.root, "add", "Dockerfile", ".gitignore");
  await git(project.env, project.root, "commit", "-q", "-m", "init");
  await writeProjectPlan(project, plan);
  return { ...project, bare };
}

/**
 * Writes `opscrew/plan.yaml` into `project` and, for a deployed plan, the server's address into
 * its local state, as provision leaves them (`recordTestServer`). Returns the plan file's path.
 */
export async function writeProjectPlan(project: TempProject, plan: DeployPlan): Promise<string> {
  const planFile = path.join(project.root, "opscrew", "plan.yaml");
  await writeArtifact("plan", planFile, plan);
  await recordTestServer(project.root, plan);
  return planFile;
}

/** A hardened Ubuntu server answering the `secure` checks; `passwordAuth` leaves password login on. */
export function fakeServer(options: { passwordAuth?: boolean } = {}): RemoteExec {
  const sshd = [
    `PasswordAuthentication ${options.passwordAuth ? "yes" : "no"}`,
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    "MaxAuthTries 3",
    "X11Forwarding no",
    "AllowUsers deploy",
  ].join("\n");
  const answers: Record<string, string> = {
    "cat /etc/ssh/sshd_config.d/10-opscrew.conf": sshd,
    "systemctl is-active fail2ban": "active",
    "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf": "",
    "systemctl is-enabled unattended-upgrades": "enabled",
    "ss -H -tln": [
      "LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*",
      "LISTEN 0      4096   0.0.0.0:80        0.0.0.0:*",
      "LISTEN 0      4096   0.0.0.0:443       0.0.0.0:*",
      "LISTEN 0      4096   [::]:22           [::]:*",
    ].join("\n"),
    "df -P /":
      "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1         39000000 4200000  33000000      12% /",
    "test -f /var/lib/opscrew-ready && echo yes || echo no": "yes",
    "test -f /var/run/reboot-required && echo yes || echo no": "no",
    "apt list --upgradable 2>/dev/null | grep -ci security || true": "0",
  };
  return {
    host: SERVER_IPV4,
    run: async (command) => {
      const answer = answers[command];
      return answer === undefined
        ? { exitCode: 127, stdout: "", stderr: `unexpected command: ${command}` }
        : { exitCode: 0, stdout: `${answer}\n`, stderr: "" };
    },
  };
}

/** A healthy site behind Cloudflare at https://shop.example.com (redirect, health, headers). */
export function fakeSite(options: { healthStatus?: number } = {}): FetchLike {
  const headers = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  return async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === "https://shop.example.com/") {
      return new Response("<!doctype html><p>shop</p>", { headers });
    }
    if (url === "https://shop.example.com/api/health") {
      return new Response("ok", { status: options.healthStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  };
}
