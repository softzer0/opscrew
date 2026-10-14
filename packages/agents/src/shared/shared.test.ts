import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { providerProfile } from "../providers";
import { ScriptedRunner } from "../testing";
import {
  assembleAppEnv,
  describeDiff,
  diffRenderedFiles,
  dotenvLine,
  ensureDeployKey,
  ensureStatePassphrase,
  generateEd25519KeyPair,
  parseDotenv,
  parseKeyscan,
  pinHostKey,
  providerConsole,
  randomPassword,
  SshRemoteExec,
  sshArgs,
  waitForCloudInit,
  waitForPort,
  writeRenderedFiles,
} from "./index";

const temp = () => mkdtemp(join(tmpdir(), "opscrew-shared-"));

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
    const first = await ensureDeployKey(paths);
    const second = await ensureDeployKey(paths);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.publicKeyOpenSsh).toBe(first.publicKeyOpenSsh);
    const passphrase = await ensureStatePassphrase(paths);
    expect(passphrase.length).toBeGreaterThanOrEqual(32);
    expect(await ensureStatePassphrase(paths)).toBe(passphrase);
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

function plan(
  env: DeployPlan["app"]["env"],
  services = { postgres: true, redis: true },
): DeployPlan {
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
    services,
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
    expect(result.dbEnv).toBe(
      "POSTGRES_USER=app\nPOSTGRES_DB=app\nPOSTGRES_PASSWORD=P4ssw0rdP4ssw0rdP4ssw0rdP4ssw0rd\n",
    );
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
    expect(second.dbEnv).toBe(first.dbEnv);
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
});
