import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { AGENT_SH, type AgentSettings, renderAgentSettings } from "../agent";
import { renderEnvPhp } from "../env-php";
import { releaseKeyPair, releaseMessage, releaseTrailer, signRelease } from "./release-signing";

/*
 * A hosting account in a temporary folder for the agent's tests (027 T2704): its home folder with
 * the app's folder ~/opscrew/notes-prod/ as plan A leaves it (agent.sh, settings.sh, keys/ with the
 * release key's public half, state/), a local bare repository in place of GitHub (git's own
 * `url.<bare>.insteadOf` in the environment), and the shims of `shims/` first on the PATH: curl
 * (the hostname serving the running release), php (the app's PHP CLI, and the report's PHP
 * binaries under php-root/, where the account's copy of the agent looks for them), ssh, mysqldump,
 * mysql, sleep, and flock where the machine has none. The shims keep their state and logs in $STUB.
 */

/** Runs a program; its standard output, or an error with its output when it fails. */
function run(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(program, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.error ?? ""}${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

/** True when `script` succeeds under bash here. */
function bashSays(script: string): boolean {
  try {
    return spawnSync("bash", ["-c", script], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/** Why the agent can't run here (a program it needs is missing), or undefined. */
export function agentSkipReason(): string | undefined {
  for (const tool of ["bash", "git", "openssl", "ssh-keygen"]) {
    if (!bashSays(`command -v ${tool}`)) return `${tool} is not available`;
  }
  return undefined;
}

/** Whether `ln -s` makes a real symbolic link here (Git for Windows' copies a folder instead). */
export const CAN_LINK = bashSays(
  'd=$(mktemp -d) && mkdir "$d/a" && ln -s a "$d/l" 2>/dev/null && [ -L "$d/l" ]; s=$?; rm -rf "$d"; exit $s',
);

/** Whether flock is on this machine; where it isn't, a shim that grants every lock stands in. */
export const HAS_FLOCK = bashSays("command -v flock");

/** A path as bash on this machine reads it (`/d/x` for `D:\x` under Git for Windows). */
function bashPath(path: string): string {
  const forward = path.replaceAll("\\", "/");
  return process.platform === "win32" ? forward.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : forward;
}

/** A plain PHP app's release: its marker becomes the fake database's state when it migrates. */
export function phpRelease(marker: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "public/index.php": "<?php require __DIR__ . '/../src/app.php';\n",
    "public/.htaccess": "RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^ index.php [L]\n",
    "src/app.php": `<?php echo 'notes ${marker}';\n`,
    "storage/logs/.gitignore": "*\n!.gitignore\n",
    "release-marker": marker,
    ...extra,
  };
}

/** A Laravel app's release (`artisan` at its root). */
export function laravelRelease(marker: string, extra: Record<string, string> = {}): Record<string, string> {
  return phpRelease(marker, { artisan: "<?php // Laravel's console\n", ...extra });
}

export interface PublishOptions {
  run: number;
  attempt?: number;
  /** The environment signed, the account's by default. */
  env?: string;
  /** The private key file that signs, the account's release key by default. */
  key?: string;
  /** The commit message's lines after its title, from the signed `OpsCrew-Release` line. */
  lines?: (trailer: string) => string[];
}

/** `script` with its PHP probe paths under `root`, as the account's copy of the agent has them. */
function probingUnder(root: string, script: string): string {
  const probes = /for bin in [^;]*;/.exec(script)?.[0];
  if (probes === undefined) throw new Error("The agent no longer probes PHP in one for loop");
  return script.replace(probes, probes.replace(/ \/(?=usr\/|opt\/)/g, ` ${root}/`));
}

/** One run's outcome: its exit code and the lines it added to state/agent.log. */
export interface AgentRun {
  status: number | null;
  output: string;
}

export class Account {
  readonly root: string;
  readonly home: string;
  /** The app's folder, ~/opscrew/notes-prod. */
  readonly dir: string;
  readonly stub: string;
  readonly settings: AgentSettings;
  /** The release key pair: the workflow's private key and the account's public key. */
  readonly keys: { key: string; pub: string };
  private readonly remote: string;
  private readonly work: string;
  private readonly bin: string;
  /** Where the account's copy of the agent looks for PHP binaries (php-root/usr/local/bin/php, …). */
  readonly phpRoot: string;
  private readonly gitEnv: NodeJS.ProcessEnv;

  /** `envPhp`: a plain PHP app's shared/env.php, which turns on the prepend lines. */
  constructor(settings: Partial<AgentSettings> = {}, options: { envPhp?: boolean } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "opscrew-agent-")).replaceAll("\\", "/");
    this.home = `${this.root}/home`;
    this.dir = `${this.home}/opscrew/notes-prod`;
    this.stub = `${this.root}/stub`;
    this.remote = `${this.root}/remote.git`;
    this.work = `${this.root}/work`;
    this.bin = `${this.root}/bin`;
    this.phpRoot = `${this.root}/php-root`;
    for (const folder of [`${this.dir}/keys`, `${this.dir}/state`, `${this.dir}/shared`, this.stub, this.bin, this.work]) {
      mkdirSync(folder, { recursive: true });
    }
    this.gitEnv = {
      ...process.env,
      HOME: this.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "OpsCrew",
      GIT_AUTHOR_EMAIL: "opscrew@example.com",
      GIT_COMMITTER_NAME: "OpsCrew",
      GIT_COMMITTER_EMAIL: "opscrew@example.com",
    };

    const shims = ["curl", "php", "ssh", "mysqldump", "mysql", "sleep", "cloudlinux-selector", ...(HAS_FLOCK ? [] : ["flock"])];
    for (const name of shims) this.executable(`${this.bin}/${name}`, shim(name));
    for (const path of ["usr/local/bin/php", "opt/alt/php85/usr/bin/php"]) {
      this.executable(`${this.phpRoot}/${path}`, shim("php"));
    }
    writeFileSync(`${this.stub}/db`, "state=initial\n");

    this.settings = {
      app: "notes",
      environment: "prod",
      hostname: "notes.example.com",
      repository: "acme/notes",
      releaseBranch: "opscrew/release/prod",
      webRoot: "public",
      healthPath: "/",
      appKind: "php",
      phpCli: bashPath(`${this.bin}/php`),
      releaseCommand: "php artisan migrate --force",
      sharedPaths: [".env", "storage"],
      snapshots: true,
      database: "acct_notes",
      ...settings,
    };
    writeFileSync(`${this.dir}/agent.sh`, probingUnder(this.phpRoot, AGENT_SH));
    writeFileSync(`${this.dir}/settings.sh`, renderAgentSettings(this.settings));
    writeFileSync(`${this.dir}/keys/known_hosts`, "");
    writeFileSync(`${this.dir}/shared/.env`, "APP_NAME=notes\n");
    writeFileSync(`${this.dir}/shared/mysql.cnf`, "[client]\nuser=acct_notes\n");
    if (options.envPhp) writeFileSync(`${this.dir}/shared/env.php`, renderEnvPhp(["APP_NAME"]));

    mkdirSync(`${this.root}/keys`);
    this.keys = releaseKeyPair(`${this.root}/keys`);
    writeFileSync(`${this.dir}/keys/release.pub`, readFileSync(this.keys.pub));
    run("git", ["init", "-q", "--bare", this.remote], { env: this.gitEnv });
    run("git", ["init", "-q", this.work], { env: this.gitEnv });
  }

  private executable(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }

  /** Runs the agent once, as cron does: its output appended to state/agent.log. */
  run(): AgentRun {
    const log = `${this.dir}/state/agent.log`;
    const before = existsSync(log) ? readFileSync(log, "utf8").length : 0;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name.toUpperCase() !== "PATH") env[name] = value;
    }
    Object.assign(env, {
      PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: this.home,
      STUB: this.stub,
      APP_DIR: this.dir,
      SERVED: this.settings.webRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${this.remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: `git@github.com:${this.settings.repository}.git`,
    });
    const result = spawnSync("bash", ["-c", 'bash "$1" >> "$2" 2>&1', "_", `${this.dir}/agent.sh`, log], {
      env,
      encoding: "utf8",
    });
    return { status: result.status, output: readFileSync(log, "utf8").slice(before) };
  }

  /** Publishes `files` as a release on the release branch, signed as the workflow signs; its commit. */
  publish(files: Record<string, string>, options: PublishOptions): string {
    for (const entry of readdirSync(this.work)) {
      if (entry !== ".git") rmSync(join(this.work, entry), { recursive: true, force: true });
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.work, path)), { recursive: true });
      writeFileSync(join(this.work, path), content);
    }
    const git = (...args: string[]) => run("git", args, { cwd: this.work, env: this.gitEnv }).trim();
    git("add", "-A", "--force", ".");
    const tree = git("write-tree");
    const attempt = options.attempt ?? 1;
    const env = options.env ?? this.settings.environment;
    const message = releaseMessage(tree, options.run, attempt, env);
    const signature = signRelease(`${this.root}/keys`, options.key ?? this.keys.key, message);
    const trailer = releaseTrailer(options.run, attempt, env, signature);
    const lines = options.lines?.(trailer) ?? [trailer];
    const body = lines.length > 0 ? ["-m", lines.join("\n")] : [];
    const commit = git("commit-tree", tree, "-m", `Release ${options.run}-${attempt}`, ...body);
    git("push", "-q", "--force", this.remote, `${commit}:refs/heads/${this.settings.releaseBranch}`);
    return commit;
  }

  /** A file of the app's folder, or undefined. */
  file(path: string): string | undefined {
    const full = `${this.dir}/${path}`;
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
  }

  /** A stub's file (its log or state), or "". */
  stubFile(name: string): string {
    const full = `${this.stub}/${name}`;
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  }

  /** The key=value file `path` of the app's folder. */
  keyValues(path: string): Record<string, string> {
    const lines = (this.file(path) ?? "").split("\n").filter((line) => line !== "");
    return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  }

  /** The release folders, sorted. */
  releases(): string[] {
    return existsSync(`${this.dir}/releases`) ? readdirSync(`${this.dir}/releases`).sort() : [];
  }

  /** Writes `content` as a request, named by its SHA-256 as the CLI names it; the name. */
  request(content: string, name = createHash("sha256").update(content).digest("hex")): string {
    mkdirSync(`${this.dir}/requests`, { recursive: true });
    writeFileSync(`${this.dir}/requests/${name}.req`, content);
    return name;
  }

  /** Holds the agent's lock with flock until the returned process is killed. */
  async holdLock(): Promise<ChildProcess> {
    const lock = `${this.dir}/state/lock`;
    const holder = spawn("flock", [lock, "sleep", "60"], { stdio: "ignore" });
    for (let i = 0; i < 100 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return holder;
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A shim of the fixtures folder `shims/`. */
function shim(name: string): string {
  return readFileSync(new URL(`./shims/${name}.sh`, import.meta.url), "utf8");
}
