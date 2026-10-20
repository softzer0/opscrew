import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findExecutable,
  NodeCommandRunner,
  OpsCrewError,
  Redactor,
  resolveProjectPaths,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import { providerProfile } from "../providers";
import { ScriptedRunner } from "../testing";
import {
  assembleAppEnv,
  checkResult,
  describeDiff,
  diffRenderedFiles,
  dotenvLine,
  editCheckText,
  ensureDeployKey,
  ensureStatePassphrase,
  generateEd25519KeyPair,
  ipv6HttpsAnswers,
  parseDotenv,
  parseKeyscan,
  pinHostKey,
  providerConsole,
  randomPassword,
  readDeployPublicKey,
  SshRemoteExec,
  sshArgs,
  summarizeChecks,
  waitForCloudInit,
  waitForPort,
  writeRenderedFiles,
} from "./index";

const temp = () => mkdtemp(join(tmpdir(), "opscrew-shared-"));

describe("check results", () => {
  it("builds a result with only the extras given, edits its texts and summarizes a list", () => {
    const plain = checkResult("tls", "TLS", "high", "pass", "Valid for 80 days.");
    expect(plain).toEqual({
      id: "tls",
      title: "TLS",
      severity: "high",
      status: "pass",
      message: "Valid for 80 days.",
    });
    const named = checkResult("dns", "DNS for nas", "high", "fail", "nas is public.", {
      remediation: "Hide nas.",
      target: "nas",
    });
    expect(editCheckText(named, (text) => text.replaceAll("nas", "your host"))).toEqual({
      ...named,
      title: "DNS for your host",
      message: "your host is public.",
      remediation: "Hide your host.",
      target: "your host",
    });
    const warning = checkResult("x", "X", "low", "warn", "Hm.");
    expect(summarizeChecks([plain, named, warning, warning])).toBe(
      "1 passed, 1 failed, 2 warnings, 0 skipped",
    );
  });

  it("probes port 443 on IPv6 only when this computer has an IPv6 route", async () => {
    const tried: string[] = [];
    const connect = async (host: string, port: number) => {
      tried.push(`${host}:${port}`);
      return false;
    };
    expect(await ipv6HttpsAnswers("2001:db8::10", connect, 1000, async () => false)).toBe(
      undefined,
    );
    expect(tried).toEqual([]);
    expect(await ipv6HttpsAnswers("2001:db8::10", connect, 1000, async () => true)).toBe(false);
    expect(tried).toEqual(["2001:db8::10:443"]);
  });
});

describe("Ed25519 deploy keys", () => {
  it("produces OpenSSH public and private keys", () => {
    const pair = generateEd25519KeyPair("opscrew-deploy@test");
    expect(pair.publicKeyOpenSsh).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* opscrew-deploy@test$/,
    );
    expect(pair.privateKeyOpenSsh.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(pair.privateKeyOpenSsh.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(pair.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const body = Buffer.from(pair.privateKeyOpenSsh.split("\n").slice(1, -2).join(""), "base64");
    expect(body.subarray(0, 15).toString("binary")).toBe("openssh-key-v1\0");
  });

  it.skipIf(!findExecutable("ssh-keygen"))("is readable by ssh-keygen", async () => {
    const dir = await temp();
    const pair = generateEd25519KeyPair("opscrew-deploy@test");
    const file = join(dir, "id_ed25519");
    await writeFile(file, pair.privateKeyOpenSsh, { mode: 0o600 });
    const result = await new NodeCommandRunner().run(findExecutable("ssh-keygen") as string, [
      "-y",
      "-f",
      file,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split(" ").slice(0, 2)).toEqual(
      pair.publicKeyOpenSsh.split(" ").slice(0, 2),
    );
  });

  it("creates the project key and passphrase once and reuses them", async () => {
    const root = await temp();
    const paths = resolveProjectPaths(root, { env: { OPSCREW_HOME: join(root, "home") } });
    const redactor = new Redactor();
    const reused = new Redactor();
    const first = await ensureDeployKey(paths, redactor);
    const second = await ensureDeployKey(paths, reused);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.publicKeyOpenSsh).toBe(first.publicKeyOpenSsh);
    // The private half is registered with the redactor wherever the key is made or read again.
    expect(redactor.redact(first.privateKeyOpenSsh)).not.toContain(first.privateKeyOpenSsh);
    expect(reused.redact(second.privateKeyOpenSsh)).not.toContain(second.privateKeyOpenSsh);
    const passphrase = await ensureStatePassphrase(paths);
    expect(passphrase.length).toBeGreaterThanOrEqual(32);
    expect(await ensureStatePassphrase(paths)).toBe(passphrase);
  });

  it("reads the deploy key's public half, or stops plainly when it is not on this computer", async () => {
    const root = await temp();
    const paths = resolveProjectPaths(root, { env: { OPSCREW_HOME: join(root, "home") } });
    const error = await readDeployPublicKey(
      { paths },
      "cannot compare your server with its setup",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The project's deploy key is not on this computer, so OpsCrew cannot compare your server with its setup. Nothing was checked.",
    );
    expect((error as OpsCrewError).hint).toBe(
      `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${paths.files.deployKey} and ${paths.files.deployKeyPub}, then try again.`,
    );
    const key = await ensureDeployKey(paths, new Redactor());
    expect(await readDeployPublicKey({ paths }, "cannot compare")).toBe(key.publicKeyOpenSsh);
  });

  it("generates URL-safe passwords", () => {
    const password = randomPassword(40);
    expect(password).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(randomPassword()).not.toBe(randomPassword());
  });
});

describe("SshRemoteExec", () => {
  it("connects as deploy with the pinned host key and no prompts", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 0, stdout: "ok\n", stderr: "" }));
    const remote = new SshRemoteExec({
      host: "203.0.113.10",
      keyFile: "k",
      knownHostsFile: "kh",
      runner,
    });
    expect((await remote.run("uptime")).stdout).toBe("ok\n");
    const call = runner.calls[0];
    expect(call?.command).toBe("ssh");
    expect(call?.args).toEqual([
      ...sshArgs({ host: "203.0.113.10", keyFile: "k", knownHostsFile: "kh" }),
      "uptime",
    ]);
    expect(call?.args).toContain("StrictHostKeyChecking=yes");
    expect(call?.args).toContain("BatchMode=yes");
    expect(call?.args).toContain("deploy@203.0.113.10");
  });

  it("sends secrets through stdin, never on the command line", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const remote = new SshRemoteExec({
      host: "203.0.113.10",
      keyFile: "k",
      knownHostsFile: "kh",
      runner,
    });
    const secret = fakeSecret("generic-password");
    await remote.run("cat > /tmp/x", { input: secret });
    await remote.run("uptime");
    expect(runner.calls[0]?.options?.input).toBe(secret);
    expect(runner.calls[0]?.args.join(" ")).not.toContain(secret);
    expect(runner.calls[1]?.options).not.toHaveProperty("input");
  });
});

describe("waiting for the server", () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it("waits for the SSH port", async () => {
    const c = clock();
    let attempts = 0;
    const open = await waitForPort("h", 22, {
      timeoutMs: 60_000,
      intervalMs: 5000,
      ...c,
      connect: async () => ++attempts >= 3,
    });
    expect(open).toBe(true);
    expect(attempts).toBe(3);
    expect(
      await waitForPort("h", 22, {
        timeoutMs: 10_000,
        intervalMs: 5000,
        ...clock(),
        connect: async () => false,
      }),
    ).toBe(false);
  });

  it("waits for cloud-init and tolerates connection errors while booting", async () => {
    let n = 0;
    const remote = {
      host: "h",
      async run() {
        n++;
        if (n === 1) throw new Error("connection refused");
        return { exitCode: 0, stdout: n >= 3 ? "ready\n" : "waiting\n", stderr: "" };
      },
    };
    expect(
      await waitForCloudInit(remote, { timeoutMs: 60_000, intervalMs: 10_000, ...clock() }),
    ).toBe(true);
    expect(n).toBe(3);
  });

  it("pins a new host key, reuses it, and refuses a changed key without confirmation", async () => {
    const dir = await temp();
    const knownHostsFile = join(dir, "known_hosts");
    const keyA = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const keyB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let current = keyA;
    const runner = new ScriptedRunner(() => ({
      exitCode: 0,
      stdout: `# h:22 SSH-2.0-OpenSSH_9.6\n203.0.113.10 ${current}\n`,
      stderr: "",
    }));

    const first = await pinHostKey({ host: "203.0.113.10", knownHostsFile, runner });
    expect(first).toMatchObject({ created: true, changed: false });
    expect(await readFile(knownHostsFile, "utf8")).toBe(`203.0.113.10 ${keyA}\n`);
    expect(await pinHostKey({ host: "203.0.113.10", knownHostsFile, runner })).toMatchObject({
      created: false,
      changed: false,
    });

    current = keyB;
    await expect(
      pinHostKey({ host: "203.0.113.10", knownHostsFile, runner }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      hint: expect.stringContaining("your cloud provider's console"),
    });
    await expect(
      pinHostKey({
        host: "203.0.113.10",
        knownHostsFile,
        runner,
        console: providerConsole(providerProfile("digitalocean")),
      }),
    ).rejects.toMatchObject({
      hint: expect.stringContaining(
        "Check in the DigitalOcean console (https://cloud.digitalocean.com/)",
      ),
    });
    const replaced = await pinHostKey({
      host: "203.0.113.10",
      knownHostsFile,
      runner,
      confirmChangedKey: async () => true,
    });
    expect(replaced.changed).toBe(true);
    expect(await readFile(knownHostsFile, "utf8")).toBe(`203.0.113.10 ${keyB}\n`);
  });

  it("parses ssh-keyscan output", () => {
    expect(parseKeyscan("# comment\n\nh ssh-ed25519 AAAA\nbroken\n")).toEqual([
      "h ssh-ed25519 AAAA",
    ]);
  });
});

function plan(env: DeployPlan["app"]["env"], run = { postgres: true, redis: true }): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: false,
    },
    services: selfHostedServices(run),
    externalServices: [],
    cost: {
      monthly: { amount: 5.99, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 5.99, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
  });
}

describe("production environment", () => {
  const stripe = fakeSecret("stripe-live-key");
  const env: DeployPlan["app"]["env"] = [
    { name: "DATABASE_URL", secret: true, source: "derived" },
    { name: "SESSION_SECRET", secret: true, source: "generated" },
    { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
    { name: "VITE_PUBLIC_URL", secret: false, source: "user" },
  ];

  it("parses dotenv files", () => {
    const values = parseDotenv(
      '# c\nexport A=1\nB="two words"\nC=\'x\'\nD=val # comment\nE="line\\nnext"\n',
    );
    expect(Object.fromEntries(values)).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "val",
      E: "line\nnext",
    });
  });

  it("quotes values so Compose reads them literally", () => {
    expect(dotenvLine("A", "plain-value_1.2")).toBe("A=plain-value_1.2");
    expect(dotenvLine("A", "has space $HOME")).toBe("A='has space $HOME'");
    expect(dotenvLine("A", "it's $5")).toBe('A="it\'s $$5"');
  });

  it("derives container URLs, generates secrets and splits build-time values", async () => {
    const result = await assembleAppEnv({
      plan: plan(env),
      dotenvText: `DATABASE_URL=postgres://localhost/dev\nSTRIPE_SECRET_KEY=${stripe}\nVITE_PUBLIC_URL=https://shop.example.com\n`,
      password: () => "P4ssw0rdP4ssw0rdP4ssw0rdP4ssw0rd",
    });
    expect(result.values.db).toEqual({
      user: "app",
      name: "app",
      password: "P4ssw0rdP4ssw0rdP4ssw0rdP4ssw0rd",
    });
    expect(result.appEnv).toContain(
      "DATABASE_URL=postgresql://app:P4ssw0rdP4ssw0rdP4ssw0rdP4ssw0rd@db:5432/app",
    );
    expect(result.appEnv).not.toContain("localhost");
    expect(result.appEnv).toContain("REDIS_URL=redis://cache:6379");
    expect(result.appEnv).toContain(`STRIPE_SECRET_KEY=${stripe}`);
    expect(result.appEnv).toContain("SESSION_SECRET=");
    expect(result.appEnv).not.toContain("VITE_PUBLIC_URL");
    expect(result.buildEnv).toBe("VITE_PUBLIC_URL=https://shop.example.com\n");
    expect(result.names).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "SESSION_SECRET",
      "STRIPE_SECRET_KEY",
      "VITE_PUBLIC_URL",
    ]);
    expect(result.names.join(" ")).not.toContain(stripe);
  });

  it("reuses generated values from an earlier run so the database password stays valid", async () => {
    const dotenvText = `STRIPE_SECRET_KEY=${stripe}\nVITE_PUBLIC_URL=https://shop.example.com\n`;
    let counter = 0;
    const password = () => `generated-${++counter}`;
    const first = await assembleAppEnv({ plan: plan(env), dotenvText, password });
    expect(first.generated).toEqual({
      dbPassword: "generated-1",
      env: { SESSION_SECRET: "generated-2" },
    });
    const second = await assembleAppEnv({
      plan: plan(env),
      dotenvText,
      password,
      previous: first.generated,
    });
    expect(second.values.db).toEqual(first.values.db);
    expect(second.appEnv).toBe(first.appEnv);
    expect(counter).toBe(2);
  });

  it("lists missing values in non-interactive mode", async () => {
    await expect(
      assembleAppEnv({ plan: plan(env, { postgres: false, redis: false }), dotenvText: "" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("STRIPE_SECRET_KEY, VITE_PUBLIC_URL"),
    });
  });

  it("asks interactively and honours the answers", async () => {
    const asked: string[] = [];
    const result = await assembleAppEnv({
      plan: plan(env, { postgres: false, redis: false }),
      dotenvText: `STRIPE_SECRET_KEY=${stripe}\n`,
      ask: async (q) => {
        asked.push(`${q.name}:${q.localValueAvailable}`);
        if (q.name === "STRIPE_SECRET_KEY") return { useLocal: true };
        return { skip: true };
      },
    });
    expect(asked).toEqual([
      "DATABASE_URL:false",
      "STRIPE_SECRET_KEY:true",
      "VITE_PUBLIC_URL:false",
    ]);
    expect(result.appEnv).toContain(`STRIPE_SECRET_KEY=${stripe}`);
    expect(result.buildEnv).toBe("\n");
  });
});

describe("rendered files", () => {
  it("diffs and writes files", async () => {
    const root = await temp();
    const files = [
      { path: "opscrew/runtime/Caddyfile", content: ":80 {}\n", kind: "runtime" as const },
      { path: "opscrew/infra/prod/main.tf", content: "# x\n", kind: "infra" as const },
    ];
    let diff = await diffRenderedFiles(root, files);
    expect(diff.created).toHaveLength(2);
    expect(describeDiff(diff)).toBe("2 new files");
    await writeRenderedFiles(root, files);
    diff = await diffRenderedFiles(root, [
      { ...files[0], content: ":80 {}\r\n" } as (typeof files)[0],
      { ...files[1], content: "# y\n" } as (typeof files)[1],
    ]);
    expect(diff.unchanged.map((f) => f.path)).toEqual(["opscrew/runtime/Caddyfile"]);
    expect(diff.changed.map((f) => f.path)).toEqual(["opscrew/infra/prod/main.tf"]);
    expect(describeDiff({ created: [], changed: [], unchanged: [] })).toBe("no changes");
  });

  it("keeps the newer pins of the committed copy when it writes or compares a file again", async () => {
    const root = await temp();
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const commit = (c: string) => c.repeat(40);
    const path = "opscrew/runtime/compose.yaml";
    const compose = (postgres: string, caddy: string) =>
      `services:\n  db:\n    image: ${postgres}\n  web:\n    image: ${caddy}\n`;
    // Dependabot moved Postgres to a newer digest of the same tag; Caddy's pin is older.
    const committed = compose(`postgres:17-alpine@${digest("b")}`, `caddy:2.10.0@${digest("c")}`);
    await writeRenderedFiles(root, [{ path, content: committed, kind: "runtime" }]);
    const rendered = compose(`postgres:17-alpine@${digest("a")}`, `caddy:2.11.7@${digest("d")}`);
    const kept = compose(`postgres:17-alpine@${digest("b")}`, `caddy:2.11.7@${digest("d")}`);

    const diff = await diffRenderedFiles(root, [{ path, content: rendered, kind: "runtime" }]);
    expect(diff.changed.map((f) => f.content)).toEqual([kept]);
    await writeRenderedFiles(root, [{ path, content: rendered, kind: "runtime" }]);
    expect(await readFile(join(root, path), "utf8")).toBe(kept);

    // A workflow whose action Dependabot moved to a newer release is unchanged.
    const workflow = ".github/workflows/opscrew-deploy.yml";
    const uses = (sha: string, tag: string) => `- uses: actions/checkout@${sha} # ${tag}\n`;
    await writeRenderedFiles(root, [
      { path: workflow, content: uses(commit("e"), "v7.1.0"), kind: "workflow" },
    ]);
    const again = await diffRenderedFiles(root, [
      { path: workflow, content: uses(commit("f"), "v7.0.1"), kind: "workflow" },
    ]);
    expect(again.unchanged.map((f) => f.content)).toEqual([uses(commit("e"), "v7.1.0")]);
  });
});
