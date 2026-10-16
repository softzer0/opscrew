/**
 * The CLI side of the tests for a server the user already owns (`target.provider: own`): a command
 * runner for resolved binaries answering `ssh-keyscan` and `ssh`, the admin login's shell, the
 * services provision, design, destroy and Portainer take (wired to `@opscrew/agents/testing`'s
 * fake host adapter, engine, GitHub, Cloudflare and Zero Trust), the recorded login and a home
 * directory. Tests only: no network, no real server.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type OwnServerConnectionInput,
  type OwnServerServices,
  type ProvisionServices,
  recordOwnServer,
} from "@opscrew/agents";
import {
  ED25519,
  type FakeEngine,
  type FakeGitHub,
  type FakeHostServer,
  fakeZeroTrust,
  OWN_IPV4,
  ownCloudflare,
} from "@opscrew/agents/testing";
import type { CommandOptions, CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import type { TempProject } from "./harness";

/** The admin login's shell: answers the test login (`true`); nothing else may run on it. */
function fakeAdminShell(host = OWN_IPV4): RemoteExec {
  return {
    host,
    run: async (command) =>
      command === "true"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `unexpected command in a test: ${command}` },
  };
}

/**
 * Real git; `ssh-keyscan` answers with the fake server's host key (`ED25519`, named `[host]:port`
 * on other ports than 22, like the real tool); `ssh` succeeds; anything else reports "not found".
 * Commands arrive as the CLI resolved them (absolute paths, `.exe` on Windows).
 */
export class OwnRunner implements CommandRunner {
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
      const host = args[args.length - 1] as string;
      const port = Number(args[args.indexOf("-p") + 1] ?? 22);
      const shown = port === 22 ? host : `[${host}]:${port}`;
      return {
        exitCode: 0,
        stdout: `# ${host}:${port} SSH-2.0-OpenSSH_9.6\n${shown} ssh-ed25519 ${ED25519}\n`,
        stderr: "",
      };
    }
    if (name === "ssh") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** The own-server services: the fake host adapter, the admin shell and the home directory. */
export function ownServices(host: FakeHostServer, home: string): OwnServerServices {
  return {
    host,
    remote: () => fakeAdminShell(),
    verifyLogin: async () => true,
    homeDir: home,
  };
}

/** Provision fakes for an own server: engine, GitHub, Cloudflare (with its account) and the host. */
export function ownProvisionServices(
  engine: FakeEngine,
  github: FakeGitHub,
  own: OwnServerServices,
): ProvisionServices {
  return {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own,
    zeroTrust: fakeZeroTrust(),
  };
}

/** Records how OpsCrew reaches the server (`.opscrew/server.json` → `own`), as the interview does. */
export async function recordOwnLogin(
  project: TempProject,
  login: Partial<OwnServerConnectionInput> = {},
): Promise<void> {
  const paths = resolveProjectPaths(project.root, { env: project.env });
  await recordOwnServer(paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
    ...login,
  } as OwnServerConnectionInput);
}

/** A home directory for `~/` key paths (holds nothing). */
export async function fakeHome(project: TempProject): Promise<string> {
  const home = path.join(project.dir, "home");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "README"), "no keys here; tests use the SSH agent\n");
  return home;
}
