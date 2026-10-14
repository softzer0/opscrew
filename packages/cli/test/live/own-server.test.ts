/**
 * Live end-to-end test on a server the user already owns (feature 009, quickstart "Gated live
 * test", steps 1–7). It creates a throwaway Hetzner server outside OpsCrew (the Hetzner API
 * directly, its own SSH key generated at runtime) and treats it as the user's own; OpsCrew never
 * gets the Hetzner token. On it, with a throwaway GitHub repository and a hostname in a Cloudflare
 * zone, the built CLI runs the whole flow: DNS only → re-run → Portainer → the Cloudflare-only
 * filter (with a reboot) → the tunnel (with a merged change) → `destroy --undo-host`. The server
 * and its key are always deleted (afterAll), and what OpsCrew created in Cloudflare is removed
 * through the API when `destroy` did not finish. Nothing the test prints contains the server's
 * address or a secret: every line goes through a scrubber. Runs only with OPSCREW_E2E_OWN_SERVER=1
 * and the variables in docs/e2e.md; costs a few cents of server time.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostKeyFingerprint } from "@opscrew/agents";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  Cloudflare,
  type CloudflareAppResources,
  type CloudflareZone,
  canConnect,
  createThrowawayServer,
  deleteThrowaway,
  GitHubRepo,
  httpsRequest,
  minutes,
  RootShell,
  resolveIpv4,
  sleep,
  type ThrowawayServer,
  waitFor,
} from "./own-cloud";
import {
  addressLinesOutsidePurpose,
  approveHashes,
  ed25519FromKeyscan,
  envFileValues,
  fingerprintFromKeygen,
  hetznerIpv6Address,
  hostPlanHash,
  ipv6PrefixForms,
  leakedLabels,
  missingVariables,
  REGION_LOCATIONS,
  removalApproval,
  Scrubber,
  serverCandidates,
  splitCommand,
  sshFingerprint,
  ufwRulesBeyondSsh,
  webListenersBeyondIpv4,
} from "./own-support";

// -----------------------------------------------------------------------------------------------
// The helpers, checked on every run (no network).

describe("own-server live test helpers", () => {
  it("names every missing variable, and OPSCREW_E2E_OWN_SERVER must be 1", () => {
    expect(missingVariables({})).toEqual([
      "OPSCREW_E2E_OWN_SERVER=1",
      "OPSCREW_E2E_HCLOUD_TOKEN",
      "OPSCREW_E2E_GITHUB_REPO",
      "OPSCREW_E2E_GITHUB_TOKEN",
      "OPSCREW_E2E_CLOUDFLARE_TOKEN",
      "OPSCREW_E2E_DOMAIN",
    ]);
    const all = {
      OPSCREW_E2E_OWN_SERVER: "1",
      OPSCREW_E2E_HCLOUD_TOKEN: "x",
      OPSCREW_E2E_GITHUB_REPO: "acme/e2e",
      OPSCREW_E2E_GITHUB_TOKEN: "x",
      OPSCREW_E2E_CLOUDFLARE_TOKEN: "x",
      OPSCREW_E2E_DOMAIN: "e2e.example.com",
    };
    expect(missingVariables(all)).toEqual([]);
    expect(missingVariables({ ...all, OPSCREW_E2E_OWN_SERVER: "true" })).toEqual([
      "OPSCREW_E2E_OWN_SERVER=1",
    ]);
  });

  it("reads the plan hashes a run names, once each, and the host plan hash", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const output = [
      `    infrastructure (Cloudflare):  ${a}`,
      `    opscrew provision --approve ${a} --approve ${b} --yes`,
      `After this removal is applied (\`opscrew provision --approve ${a}\`, typing the app name)`,
      `Host plan hash: ${b}`,
      `Host plan hash: ${a}`,
    ].join("\n");
    expect(approveHashes(output)).toEqual([a, b]);
    expect(approveHashes("Nothing to apply.")).toEqual([]);
    expect(hostPlanHash(output)).toBe(a);
    expect(hostPlanHash("no plan")).toBeUndefined();
  });

  it("computes SSH fingerprints as OpsCrew and ssh-keygen print them", () => {
    const blob = randomBytes(51).toString("base64");
    expect(sshFingerprint(blob)).toBe(hostKeyFingerprint(blob));
    expect(sshFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const keyscan = `# 192.0.2.10:22 SSH-2.0-OpenSSH_9.6\n192.0.2.10 ssh-rsa AAAAB3Nza\n192.0.2.10 ssh-ed25519 ${blob}\n`;
    expect(ed25519FromKeyscan(keyscan)).toBe(blob);
    expect(ed25519FromKeyscan("# nothing\n")).toBeUndefined();
    const printed = `256 ${sshFingerprint(blob)} root@host (ED25519)\n`;
    expect(fingerprintFromKeygen(printed)).toBe(sshFingerprint(blob));
  });

  it("chooses the cheapest x86 server type in the nearest locations", () => {
    const price = (location: string, gross: string) => ({
      location,
      price_hourly: { gross },
    });
    const types = [
      { name: "cax11", architecture: "arm", memory: 4, prices: [price("nbg1", "0.0050")] },
      {
        name: "cx22",
        architecture: "x86",
        memory: 4,
        deprecation: { announced: "2025-01-01" },
        prices: [price("nbg1", "0.0060")],
      },
      {
        name: "cx23",
        architecture: "x86",
        memory: 4,
        prices: [price("fsn1", "0.0062"), price("nbg1", "0.0062"), price("ash", "0.0010")],
      },
      { name: "cpx11", architecture: "x86", memory: 2, prices: [price("hel1", "0.0070")] },
    ];
    const chosen = serverCandidates(types, REGION_LOCATIONS["eu-central"] ?? []);
    expect(chosen.map((c) => `${c.serverType}@${c.location}`)).toEqual([
      "cx23@nbg1",
      "cx23@fsn1",
      "cpx11@hel1",
    ]);
    expect(serverCandidates(types, ["nbg1", "hel1"], "cpx11")).toEqual([
      { serverType: "cpx11", location: "hel1", hourlyGross: 0.007 },
    ]);
  });

  it("derives the server's IPv6 address from its /64, and the prefix in both forms", () => {
    expect(hetznerIpv6Address("2001:db8:1:2::/64")).toBe("2001:db8:1:2::1");
    expect(ipv6PrefixForms("2001:db8:1:2::/64")).toEqual(["2001:db8:1:2::", "2001:db8:1:2:"]);
  });

  it("takes the values of an app environment file that are long enough to search for", () => {
    const file =
      "# comment\nNAME=short\nMAPBOX_KEY=pk.stand-in-value\n\nMAIL_FROM='ops@example.com'\nEMPTY=\nexport FLAG=\"a quoted value\"\n";
    expect(envFileValues(file)).toEqual(["pk.stand-in-value", "ops@example.com", "a quoted value"]);
  });

  it("stops waiting at once when the abort check reports a problem, and says what it saw last", async () => {
    let seen = "nothing yet";
    await expect(
      waitFor(
        () => `the tunnel (${seen})`,
        60_000,
        async () => undefined,
        1,
        () => {
          seen = "ssh exited";
          return "ssh exited with 255: Permission denied";
        },
      ),
    ).rejects.toThrow("ssh exited with 255: Permission denied");
    await expect(
      waitFor(
        () => `the tunnel (${seen})`,
        5,
        async () => {
          throw new Error("connection refused");
        },
        1,
      ),
    ).rejects.toThrow(/the tunnel \(ssh exited\)\. Last problem: connection refused/);
    await expect(waitFor("a value", 1_000, async () => 42, 1)).resolves.toBe(42);
  });

  it("reads ufw rules beyond SSH", () => {
    const sshOnly = [
      "Status: active",
      "",
      "To                         Action      From",
      "--                         ------      ----",
      "22/tcp                     ALLOW IN    Anywhere                   # opscrew ssh",
      "22/tcp (v6)                ALLOW IN    Anywhere (v6)              # opscrew ssh",
    ].join("\n");
    expect(ufwRulesBeyondSsh(sshOnly)).toEqual({ active: true, rules: 2, others: [] });
    const web = `${sshOnly}\n80/tcp                     ALLOW IN    Anywhere\n443 (v6)                   ALLOW IN    Anywhere (v6)`;
    expect(ufwRulesBeyondSsh(web).others).toHaveLength(2);
    expect(ufwRulesBeyondSsh("Status: inactive").active).toBe(false);
    expect(ufwRulesBeyondSsh(sshOnly.replaceAll("22/tcp", "2222/tcp"), 2222).others).toEqual([]);
  });

  it("finds web listeners on IPv6 or every address in ss output", () => {
    const ss = [
      "tcp   LISTEN 0      4096         0.0.0.0:80        0.0.0.0:*",
      "tcp   LISTEN 0      4096         0.0.0.0:443       0.0.0.0:*",
      "udp   UNCONN 0      0            0.0.0.0:443       0.0.0.0:*",
      "tcp   LISTEN 0      4096            [::]:22           [::]:*",
      "tcp   LISTEN 0      4096       127.0.0.1:9443      0.0.0.0:*",
    ].join("\n");
    expect(webListenersBeyondIpv4(ss)).toEqual([]);
    const open = `${ss}\ntcp   LISTEN 0      4096            [::]:443          [::]:*\ntcp   LISTEN 0 511 *:80 *:*`;
    expect(webListenersBeyondIpv4(open)).toEqual(["[::]:443", "*:80"]);
  });

  it("splits the printed tunnel command, keeping Windows paths", () => {
    const command = String.raw`ssh -p 2222 -i "C:\Users\me\.opscrew\deploy_key" -o UserKnownHostsFile="/home/me/my \"x\"/known_hosts" -N -L 9443:127.0.0.1:9443 deploy@192.0.2.10`;
    expect(splitCommand(command)).toEqual([
      "ssh",
      "-p",
      "2222",
      "-i",
      String.raw`C:\Users\me\.opscrew\deploy_key`,
      "-o",
      'UserKnownHostsFile=/home/me/my "x"/known_hosts',
      "-N",
      "-L",
      "9443:127.0.0.1:9443",
      "deploy@192.0.2.10",
    ]);
    expect(() => splitCommand('ssh "open')).toThrow(/unclosed quote/);
  });

  it("masks the server's address and known secrets, also short ones, and names leaks by label", () => {
    const scrubber = new Scrubber();
    scrubber.add("5.6.7.8", "server-ipv4");
    scrubber.add("2001:db8:1:2:", "server-ipv6");
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=\n-----END";
    scrubber.add(key, "test-private-key");
    scrubber.add("", "ignored");
    const text =
      "ssh deploy@5.6.7.8 and [2001:db8:1:2::1]:22, key line bm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=";
    const masked = scrubber.scrub(text);
    expect(masked).not.toContain("5.6.7.8");
    expect(masked).not.toContain("2001:db8:1:2:");
    expect(masked).not.toContain("bm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=");
    expect(masked).toContain("deploy@[server-ipv4]");
    expect(leakedLabels(text, scrubber.entries())).toEqual([
      "server-ipv4",
      "server-ipv6",
      "test-private-key",
    ]);
    expect(leakedLabels("nothing here", scrubber.entries())).toEqual([]);
    expect(leakedLabels("version 15.6.7.80", scrubber.entries())).toEqual([]);
  });

  it("allows the server's address only in the tunnel command and 'your server at' messages", () => {
    const addresses = ["5.6.7.8", "2001:db8:1:2::1", "2001:db8:1:2::", "2001:db8:1:2:"];
    const output = [
      'ssh -i "/k/deploy_key" -o UserKnownHostsFile="/k/known_hosts" -N -L 9443:127.0.0.1:9443 deploy@5.6.7.8',
      '  "tunnelCommand": "ssh -i \\"/k\\" -N -L 9443:127.0.0.1:9443 deploy@5.6.7.8",',
      "This is OpsCrew's first connection to your server at 5.6.7.8, and its SSH host key must be confirmed.",
      "OpsCrew could not reach SSH on your server at [2001:db8:1:2::1]:22.",
      "Prepared your server (12 changes applied).",
      "version 15.6.7.80",
    ].join("\n");
    expect(addressLinesOutsidePurpose(output, addresses)).toBe(0);
    const leaked = `${output}\nCreated or updated the server at the address 5.6.7.8.\nssh deploy@5.6.7.8`;
    expect(addressLinesOutsidePurpose(leaked, addresses)).toBe(2);
    // An allowed mention does not excuse another one on the same line.
    expect(addressLinesOutsidePurpose("server at 5.6.7.8, also 5.6.7.8", addresses)).toBe(1);
    expect(addressLinesOutsidePurpose("deploy@5.6.7.8 without a tunnel", addresses)).toBe(1);
    expect(
      addressLinesOutsidePurpose(
        "your server at [2001:db8:1:2::1]:22 in 2001:db8:1:2:0:0:0:9",
        addresses,
      ),
    ).toBe(1);
  });

  it("reads the removal plan's approval from T916's --plan-only text", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const removal = [
      "Plan hash (SHA-256):",
      `    ${a}`,
      "Review the plan above. To apply exactly this plan, run:",
      `    opscrew provision --approve ${a} --yes --confirm shop`,
      "This plan deletes or replaces resources, so applying it also needs the app's name: type it when the command asks in a terminal, or keep --confirm shop in the command above in a script.",
      `After this removal is applied, run \`opscrew provision --approve ${b}\` again.`,
    ].join("\n");
    expect(removalApproval(removal)).toEqual({ hashes: [a], app: "shop" });
    expect(
      removalApproval(`    opscrew provision --approve ${a} --approve ${b} --yes`),
    ).toBeUndefined();
    expect(() =>
      removalApproval(
        "This plan deletes or replaces resources, so applying it also needs the app's name: type it.",
      ),
    ).toThrow(/no printed command with --confirm/);
  });
});

// -----------------------------------------------------------------------------------------------
// The live run.

const ENV = process.env;
const MISSING = missingVariables(ENV);
const E2E = {
  hcloudToken: ENV.OPSCREW_E2E_HCLOUD_TOKEN ?? "",
  githubRepo: ENV.OPSCREW_E2E_GITHUB_REPO ?? "",
  githubToken: ENV.OPSCREW_E2E_GITHUB_TOKEN ?? "",
  cloudflareToken: ENV.OPSCREW_E2E_CLOUDFLARE_TOKEN ?? "",
  domain: (ENV.OPSCREW_E2E_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, ""),
  region: ENV.OPSCREW_E2E_REGION?.trim() || "eu-central",
  /** Optional: force a Hetzner server type instead of the cheapest x86 one. */
  serverType: ENV.OPSCREW_E2E_OWN_SERVER_TYPE?.trim() || undefined,
  /** An example under examples/ (default nextjs-postgres). */
  app: ENV.OPSCREW_E2E_APP?.trim() || "nextjs-postgres",
  appEnvFile: ENV.OPSCREW_E2E_APP_ENV,
};

if (MISSING.length > 0 && ENV.OPSCREW_E2E_OWN_SERVER === "1") {
  console.warn(
    `OpsCrew E2E (own server): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Your own server").`,
  );
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
const EXAMPLES = join(REPO_ROOT, "examples");
const PORTAINER_PORTS = [9443, 9000, 8000];

type Serve = "dns-only" | "proxy" | "tunnel";

interface CliRun {
  exitCode: number;
  stdout: string;
  /** stdout and stderr; may name the server's address, so print it only through `scrub`. */
  output: string;
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live end-to-end on your own server (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live end-to-end on your own server: examples/${E2E.app} on a throwaway Hetzner server`,
  () => {
    const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const startedAt = new Date();
    const runner = new NodeCommandRunner();
    const scrubber = new Scrubber();
    const scrub = scrubber.scrub;
    const github = new GitHubRepo(E2E.githubToken, E2E.githubRepo);
    const cloudflare = new Cloudflare(E2E.cloudflareToken);
    scrubber.add(E2E.hcloudToken, "hetzner-token");
    scrubber.add(E2E.githubToken, "github-token");
    scrubber.add(E2E.cloudflareToken, "cloudflare-token");

    /** Raw CLI outputs by label (never printed; searched for secrets at the end). */
    const outputs = new Map<string, string>();
    /** Problems that do not stop the run but fail it at the end. */
    const findings: string[] = [];
    let stopped = false;

    let work = "";
    let repo = "";
    let keyFile = "";
    let knownHostsFile = "";
    let env: Record<string, string | undefined> = {};
    let repoReady = false;
    let server: ThrowawayServer | undefined;
    /** Set before the first Hetzner call that creates something: the cleanup then always looks. */
    let hetznerTouched = false;
    let serverId: number | undefined;
    let keyId: number | undefined;
    let fingerprint = "";
    let root: RootShell | undefined;
    let ipv6Route = false;
    let appName: string | undefined;
    let zone: CloudflareZone | undefined;
    let hostnames: string[] = [];
    let cloudflareBefore: CloudflareAppResources | undefined;
    let destroyed = false;
    let tunnel: ChildProcess | undefined;

    const log = (message: string) => console.log(`OpsCrew E2E (own server): ${scrub(message)}`);
    const tail = (text: string, lines = 60) =>
      scrub(text).trimEnd().split(/\r?\n/).slice(-lines).join("\n");

    /** A copy of `error` whose message and stack are scrubbed (no assertion diff with raw values). */
    function cleanError(error: unknown): Error {
      const message = error instanceof Error ? error.message : String(error);
      const clean = new Error(scrub(message));
      clean.stack = scrub(error instanceof Error ? (error.stack ?? message) : message);
      return clean;
    }

    /** An ordered step: skipped after an earlier step failed (unless `always`), errors scrubbed. */
    function step(title: string, timeoutMs: number, body: () => Promise<void>, always = false) {
      it(title, { timeout: timeoutMs }, async (context) => {
        if (stopped && !always) context.skip();
        // Also a timeout (which never reaches the catch below) stops the later steps.
        context.onTestFailed(() => {
          stopped = true;
        });
        log(`step: ${title}`);
        try {
          await body();
        } catch (error) {
          stopped = true;
          throw cleanError(error);
        }
      });
    }

    const ipv4 = () => (server as ThrowawayServer).ipv4;
    const shell = () => root as RootShell;
    /** The server's addresses this computer can try (IPv6 only with a route). */
    const ownAddresses = () => [
      ipv4(),
      ...(ipv6Route && server?.ipv6 !== undefined ? [server.ipv6] : []),
    ];

    async function git(...args: string[]): Promise<string> {
      const result = await runner.run("git", ["-C", repo, ...args], { env, timeoutMs: minutes(5) });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(-500)}`);
      }
      return result.stdout.trim();
    }

    /** Runs the built CLI in the project, non-interactively (`CI=1`). */
    async function opscrew(...args: string[]): Promise<CliRun> {
      log(`running opscrew ${args.join(" ")}`);
      const result = await runner.run(process.execPath, [CLI, ...args], {
        cwd: repo,
        env,
        timeoutMs: minutes(30),
      });
      const output = `${result.stdout}\n${result.stderr}`;
      outputs.set(`#${outputs.size + 1} opscrew ${args.join(" ")}`, output);
      if (result.timedOut === true) {
        throw new Error(`opscrew ${args.join(" ")} did not finish in 30 minutes:\n${tail(output)}`);
      }
      return { exitCode: result.exitCode, stdout: result.stdout, output };
    }

    async function opscrewOk(...args: string[]): Promise<CliRun> {
      const result = await opscrew(...args);
      if (result.exitCode !== 0) {
        throw new Error(
          `opscrew ${args.join(" ")} exited with ${result.exitCode}:\n${tail(result.output)}`,
        );
      }
      return result;
    }

    const readPlan = (): Promise<DeployPlan> =>
      readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    const paths = () => resolveProjectPaths(repo, { env });

    /** Interview (own server, root, the test key, `serve`) then design. */
    async function answerAndDesign(serve: Serve, hostKey?: string): Promise<void> {
      const answers = join(work, "answers.json");
      await writeFile(
        answers,
        JSON.stringify({
          provider: "own",
          expectedMonthlyUsers: "<1k",
          budgetMonthly: 20,
          uptime: "best-effort",
          dataCriticality: "important",
          dnsProvider: "cloudflare",
          domain: E2E.domain,
          keepExternalServices: [],
          "server.host": ipv4(),
          "server.port": 22,
          "server.user": "root",
          "server.key": keyFile,
          "server.reachable": true,
          "server.serve": serve,
        }),
      );
      await opscrewOk("interview", "--answers", answers);
      await opscrewOk("design", ...(hostKey === undefined ? [] : ["--host-key", hostKey]));
      const plan = await readPlan();
      if (plan.target.provider !== "own") {
        throw new Error(`design planned ${plan.target.provider}, not the user's own server.`);
      }
    }

    /**
     * `provision --plan-only`, then `provision --approve <each hash> --yes`, until a run finishes.
     * A switch between public and tunnel mode takes two applies; the first one removes the old
     * setup, so it also needs the app's name: `--approve <removal hash> --confirm <app>`.
     */
    async function provisionUntilDone(): Promise<void> {
      let removal: CliRun | undefined;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const planned = await opscrewOk("provision", "--plan-only", "--yes");
        const confirm = removalApproval(planned.output);
        if (confirm !== undefined) {
          if (removal !== undefined) {
            throw new Error(
              `The removal of the old setup was planned again after \`provision --approve … --confirm\`, which said:\n${tail(removal.output)}`,
            );
          }
          if (confirm.app !== appName) {
            throw new Error(`The printed command confirms "${confirm.app}", not the app's name.`);
          }
          removal = await opscrew(
            "provision",
            ...confirm.hashes.flatMap((hash) => ["--approve", hash]),
            "--confirm",
            confirm.app,
            "--yes",
          );
          // The run may go on to the new setup's plan, which is approved in the next round.
          log(`the removal run exited with ${removal.exitCode}:\n${tail(removal.output, 15)}`);
          continue;
        }
        const hashes = approveHashes(planned.output);
        if (hashes.length === 0) {
          log("both plans are applied already; finishing provision");
          await opscrewOk("provision", "--yes");
          return;
        }
        const applied = await opscrew(
          "provision",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          "--yes",
        );
        if (applied.exitCode === 0) return;
        const next = approveHashes(applied.output).filter((hash) => !hashes.includes(hash));
        if (next.length === 0) {
          throw new Error(
            `opscrew provision --approve … exited with ${applied.exitCode}:\n${tail(applied.output)}`,
          );
        }
        log(`provision asks for another plan (${next.join(", ")}); planning again`);
      }
      throw new Error("opscrew provision did not finish after 5 rounds of plans.");
    }

    /**
     * Deploys what the last provision prepared: merges its pull request and waits for that run to
     * succeed. Only when provision stayed on `main` (it committed nothing) is the deploy workflow
     * on main started instead; a deploy branch without an open pull request stops the run.
     */
    async function deploy(what: string): Promise<void> {
      const head = await git("rev-parse", "--abbrev-ref", "HEAD");
      const pull = head.startsWith("opscrew/deploy-setup")
        ? await github.openPullRequest(head)
        : undefined;
      if (head.startsWith("opscrew/deploy-setup") && pull === undefined) {
        throw new Error(
          `provision left ${head} checked out but there is no open pull request from it, so nothing would deploy its changes.`,
        );
      }
      if (pull === undefined && head !== "main") {
        throw new Error(`provision left ${head} checked out, neither main nor a deploy branch.`);
      }
      let run: Awaited<ReturnType<GitHubRepo["waitForDeploy"]>>;
      if (pull !== undefined) {
        log(
          `merging pull request #${pull} (${what}) and waiting for its deploy run (up to 30 minutes)`,
        );
        const sha = await github.merge(pull);
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");
        run = await github.waitForDeploy({ headSha: sha });
      } else {
        log(`provision committed nothing; running the deploy workflow on main (${what})`);
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");
        const since = new Date();
        await github.dispatchDeploy();
        run = await github.waitForDeploy({
          headSha: await git("rev-parse", "HEAD"),
          event: "workflow_dispatch",
          since,
        });
      }
      const failed = run.jobs.filter((job) => job.conclusion !== "success");
      if (run.conclusion !== "success" || failed.length > 0) {
        throw new Error(
          `The deploy run ${run.id} (${what}) ended ${run.conclusion}; jobs: ${run.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}.`,
        );
      }
      log(`deploy run ${run.id} (${what}) succeeded`);
    }

    /** The app's health URL on the test hostname. */
    async function healthUrl(): Promise<string> {
      return `https://${E2E.domain}${(await readPlan()).app.healthPath}`;
    }

    /** Waits until the domain resolves (through 1.1.1.1) to the server itself or to Cloudflare. */
    async function waitForDns(direct: boolean): Promise<void> {
      log(
        `waiting for ${E2E.domain} to point ${direct ? "at the server" : "at Cloudflare"} (up to 10 minutes)`,
      );
      await waitFor(
        `${E2E.domain} pointing ${direct ? "at the server" : "at Cloudflare"}`,
        minutes(10),
        async () => {
          const addresses = await resolveIpv4(E2E.domain);
          if (addresses.length === 0) return undefined;
          return addresses.includes(ipv4()) === direct ? true : undefined;
        },
      );
    }

    /** Waits for 200 on the health path; `throughCloudflare` also wants Cloudflare's `cf-ray`. */
    async function waitForApp(throughCloudflare: boolean, timeoutMs = minutes(10)): Promise<void> {
      const url = await healthUrl();
      log(
        `waiting for ${url} to answer 200${throughCloudflare ? " through Cloudflare" : " from the server"}`,
      );
      await waitFor(`${url} answering 200`, timeoutMs, async () => {
        const answer = await httpsRequest(url);
        if (answer.status !== 200) throw new Error(`${url} answered ${answer.status}.`);
        const ray = answer.headers["cf-ray"] !== undefined;
        if (ray !== throughCloudflare) {
          throw new Error(
            `${url} answered ${throughCloudflare ? "without" : "with"} Cloudflare's cf-ray header.`,
          );
        }
        return true;
      });
    }

    /** Every address/port pair of the server's own addresses that accepts a TCP connection. */
    async function answering(ports: readonly number[], timeoutMs = 5_000): Promise<string[]> {
      const open: string[] = [];
      for (const address of ownAddresses()) {
        for (const port of ports) {
          if (await canConnect(address, port, timeoutMs)) {
            open.push(`${address.includes(":") ? "IPv6" : "IPv4"} port ${port}`);
          }
        }
      }
      return open;
    }

    async function expectNotAnswering(ports: readonly number[], why: string): Promise<void> {
      if (!ipv6Route)
        log("this computer has no IPv6 route: the server's IPv6 address is not tried");
      const open = await answering(ports);
      expect(open, `the server's own address answers on ${open.join(", ")} (${why})`).toEqual([]);
    }

    /** The infrastructure outputs (the tunnel and Access service token), read with the engine. */
    async function infraOutputs(): Promise<Record<string, unknown>> {
      const plan = await readPlan();
      const engine = await selectEngine("auto", { env, runner });
      const engineEnv = { ...env };
      const passphrase = paths().files.statePassphrase;
      if (engine.info.name === "tofu" && existsSync(passphrase)) {
        engineEnv.TF_ENCRYPTION = tofuEncryptionEnv((await readFile(passphrase, "utf8")).trim());
      }
      return engine.output(join(repo, plan.infra.dir), { env: engineEnv });
    }

    async function rememberSecretFile(file: string, label: string): Promise<void> {
      if (existsSync(file)) scrubber.add(await readFile(file, "utf8"), label);
    }

    // -------------------------------------------------------------------------------------------

    step(
      "1. creates a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
        const example = join(EXAMPLES, E2E.app);
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(E2E.app) ||
          !existsSync(example) ||
          !statSync(example).isDirectory()
        ) {
          throw new Error(
            `OPSCREW_E2E_APP="${E2E.app}" is not an example under examples/ (this test deploys examples only).`,
          );
        }
        const locations = REGION_LOCATIONS[E2E.region];
        if (locations === undefined) {
          throw new Error(
            `OPSCREW_E2E_REGION="${E2E.region}" is not one of ${Object.keys(REGION_LOCATIONS).join(", ")}.`,
          );
        }

        work = await mkdtemp(join(tmpdir(), "opscrew-e2e-own-"));
        repo = join(work, "repo");
        const keys = join(work, "keys");
        await mkdir(repo);
        await mkdir(keys);
        keyFile = join(keys, "id_ed25519");
        knownHostsFile = join(keys, "known_hosts");
        const basic = Buffer.from(`x-access-token:${E2E.githubToken}`).toString("base64");
        scrubber.add(basic, "github-basic-auth");
        env = {
          ...process.env,
          CI: "1",
          OPSCREW_HOME: join(work, "home"),
          GITHUB_TOKEN: E2E.githubToken,
          CLOUDFLARE_API_TOKEN: E2E.cloudflareToken,
          OPSCREW_APP_ENV_FILE: join(work, "production.env"),
        };
        // OpsCrew never gets a cloud token here: the server is the user's own. No agent either: the
        // test key (by path) is the only key OpsCrew may use.
        for (const name of [
          "HCLOUD_TOKEN",
          "DIGITALOCEAN_TOKEN",
          "DIGITALOCEAN_ACCESS_TOKEN",
          "SSH_AUTH_SOCK",
        ]) {
          delete env[name];
        }
        for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];

        // The server's own SSH key, generated here and never written to the repository or printed.
        const keygen = await runner.run(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-${runId}`, "-f", keyFile],
          { env, timeoutMs: 60_000 },
        );
        if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
        scrubber.add(await readFile(keyFile, "utf8"), "test-private-key");
        const publicKey = (await readFile(`${keyFile}.pub`, "utf8")).trim();

        // The throwaway repository gets a fresh copy of the example on main, without earlier PRs.
        log(`pushing examples/${E2E.app} to the throwaway repository`);
        await materializeFixture(example, repo);
        const appEnv = E2E.appEnvFile ? await readFile(E2E.appEnvFile, "utf8") : "";
        await writeFile(join(work, "production.env"), appEnv);
        // Stand-in values, but still never to be shown or committed (8+ characters: shorter ones
        // would match ordinary text).
        for (const value of envFileValues(appEnv)) scrubber.add(value, "app-env-value");
        await git("init", "-q", "-b", "main");
        await git("config", "user.name", "OpsCrew E2E");
        await git("config", "user.email", "e2e@example.invalid");
        await git("config", "commit.gpgsign", "false");
        await git(
          "config",
          "http.https://github.com/.extraheader",
          `AUTHORIZATION: basic ${basic}`,
        );
        await git("remote", "add", "origin", `https://github.com/${E2E.githubRepo}.git`);
        await git("add", "-A");
        await git("commit", "-q", "-m", `e2e: examples/${E2E.app} on your own server`);
        await git("push", "-q", "--force", "origin", "main");
        await github.reset();
        repoReady = true;

        ipv6Route = await canConnect("2606:4700:4700::1111", 443, 5_000);
        log(
          ipv6Route
            ? "this computer has an IPv6 route: the server's IPv6 address is probed too"
            : "this computer has no IPv6 route: probes of the server's IPv6 address are skipped",
        );

        hetznerTouched = true;
        server = await createThrowawayServer({
          token: E2E.hcloudToken,
          runId,
          publicKey,
          locations,
          ...(E2E.serverType === undefined ? {} : { forcedType: E2E.serverType }),
          onKey: (id) => {
            keyId = id;
          },
          onServer: (id) => {
            serverId = id;
          },
          log,
        });
        scrubber.add(server.ipv4, "server-ipv4");
        scrubber.add(server.ipv6, "server-ipv6");
        for (const prefix of server.ipv6Network === undefined
          ? []
          : ipv6PrefixForms(server.ipv6Network)) {
          scrubber.add(prefix, "server-ipv6");
        }
        log(`server ${server.name} (${server.serverType} in ${server.location}) runs`);

        log("waiting for the server's SSH host key (up to 5 minutes)");
        const hostKey = await waitFor(
          "the server's SSH host key",
          minutes(5),
          async () => {
            const scan = await runner.run("ssh-keyscan", ["-T", "10", "-t", "ed25519", ipv4()], {
              env,
              timeoutMs: 30_000,
            });
            return ed25519FromKeyscan(scan.stdout);
          },
          5_000,
        );
        await writeFile(knownHostsFile, `${ipv4()} ssh-ed25519 ${hostKey}\n`);
        fingerprint = sshFingerprint(hostKey);
        root = new RootShell(runner, { host: ipv4(), keyFile, knownHostsFile, env });
        log("waiting for root to log in with the test key (up to 3 minutes)");
        await waitFor(
          "root logging in with the test key",
          minutes(3),
          async () => ((await shell().run("true", 30_000)).exitCode === 0 ? true : undefined),
          5_000,
        );
        log("waiting for cloud-init to finish on the server (up to 15 minutes)");
        const cloudInit = await shell().run("cloud-init status --wait", minutes(15));
        // 2: finished with recoverable errors, which a fresh image may report.
        if (![0, 2].includes(cloudInit.exitCode)) {
          throw new Error(
            `cloud-init did not finish (exit ${cloudInit.exitCode}): ${cloudInit.stdout.trim()}`,
          );
        }
        // As the user guide says: check the fingerprint on the server itself.
        const onServer = fingerprintFromKeygen(
          await shell().ok("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"),
        );
        expect(onServer, "the host key fingerprint on the server matches the scanned key").toBe(
          fingerprint,
        );
      },
    );

    step(
      "2. DNS only: interview, design, adapt, provision, deploy, verify, secure and drift",
      minutes(75),
      async () => {
        await opscrewOk("analyze", "--no-ai");
        await answerAndDesign("dns-only", fingerprint);
        const plan = await readPlan();
        appName = plan.app.name;
        expect(plan.dns.provider, "DNS on Cloudflare").toBe("cloudflare");
        expect(plan.dns.proxied, "DNS only: the record is not proxied").toBe(false);

        zone = await cloudflare.zoneOf(E2E.domain);
        hostnames = [
          E2E.domain,
          `www.${E2E.domain}`,
          `ssh-${appName}.${zone.name}`,
          `portainer.${E2E.domain}`,
        ];
        // What was there before this run is never deleted by the cleanup.
        cloudflareBefore = await cloudflare.appResources(zone, appName, hostnames);

        await opscrewOk("adapt", "--no-ai", "--yes");
        const head = await git("rev-parse", "--abbrev-ref", "HEAD");
        const adaptBranch = head.startsWith("opscrew/prepare-deploy")
          ? head
          : (
              await git(
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/opscrew/prepare-deploy*",
              )
            ).split(/\r?\n/)[0];
        const adaptPull = adaptBranch ? await github.openPullRequest(adaptBranch) : undefined;
        if (adaptPull === undefined) throw new Error("adapt opened no pull request.");
        log(`merging the adapt pull request #${adaptPull}`);
        await github.merge(adaptPull);
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");

        await provisionUntilDone();
        await rememberSecretFile(paths().files.deployKey, "deploy-private-key");
        await rememberSecretFile(paths().files.statePassphrase, "state-passphrase");
        await deploy("the first deploy, DNS only");

        await waitForDns(true);
        await waitForApp(false);
        await opscrewOk("verify");
        const secure = await opscrewOk("secure");
        expect(
          secure.output.includes("SECURITY_REPORT.md"),
          `secure wrote its report:\n${tail(secure.output)}`,
        ).toBe(true);
        await opscrewOk("drift");
        await shell().ok("true");
        log("DNS only: deployed, verified, secured, drift-free; root still logs in with its key");
      },
    );

    step("3. re-running provision shows no changes", minutes(20), async () => {
      const planned = await opscrewOk("provision", "--plan-only", "--yes");
      expect(approveHashes(planned.output), `nothing to approve:\n${tail(planned.output)}`).toEqual(
        [],
      );
      expect(
        /Nothing to apply/.test(planned.output),
        `nothing to apply:\n${tail(planned.output)}`,
      ).toBe(true);
    });

    step(
      "4. Portainer: unreachable from outside, working through the printed SSH tunnel",
      minutes(30),
      async () => {
        const planned = await opscrewOk("portainer", "enable", "--plan-only", "--yes");
        const hashes = approveHashes(planned.output);
        expect(
          hashes.length,
          `portainer enable planned something:\n${tail(planned.output)}`,
        ).toBeGreaterThan(0);
        await opscrewOk(
          "portainer",
          "enable",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          "--yes",
        );

        const status = JSON.parse((await opscrewOk("portainer", "status", "--json")).stdout) as {
          enabled: boolean;
          localUrl: string;
          tunnelCommand?: string;
          passwordFile: string;
          passwordFileExists: boolean;
        };
        expect(status.enabled, "Portainer is on").toBe(true);
        expect(status.passwordFileExists, "the password file is on this computer").toBe(true);
        const password = (await readFile(status.passwordFile, "utf8")).trim();
        scrubber.add(password, "portainer-password");

        await expectNotAnswering(PORTAINER_PORTS, "Portainer must listen on the server only");

        const command = splitCommand(status.tunnelCommand ?? "");
        expect(command[0], "the printed tunnel command runs ssh").toBe("ssh");
        log("starting the printed SSH tunnel");
        let stderr = "";
        let exited: string | undefined;
        tunnel = spawn(
          "ssh",
          ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", ...command.slice(1)],
          {
            env: env as NodeJS.ProcessEnv,
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        tunnel.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        tunnel.once("exit", (code, signal) => {
          exited = `exit ${code ?? signal}`;
        });
        tunnel.once("error", (error) => {
          exited = error.message;
        });
        const sshSaid = () => stderr.trim().slice(-300) || "nothing";
        try {
          const local = (path: string) => new URL(path, status.localUrl).toString();
          log("waiting for Portainer through the tunnel (up to 3 minutes)");
          await waitFor(
            () => `Portainer through the tunnel (ssh said: ${sshSaid()})`,
            minutes(3),
            async () =>
              (await httpsRequest(local("/api/system/status"), { insecure: true })).status === 200
                ? true
                : undefined,
            5_000,
            () =>
              exited === undefined
                ? undefined
                : `The SSH tunnel command ended (${exited}); ssh said: ${sshSaid()}`,
          );
          const admin = await httpsRequest(local("/api/users/admin/check"), { insecure: true });
          expect(admin.status, "the admin account exists (204)").toBe(204);
          const login = await httpsRequest(local("/api/auth"), {
            method: "POST",
            insecure: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "admin", password }),
          });
          expect(login.status, "admin logs in with the password OpsCrew generated").toBe(200);
          scrubber.add((JSON.parse(login.body) as { jwt?: string }).jwt, "portainer-session");
        } finally {
          tunnel.kill();
          tunnel = undefined;
        }
        log("Portainer: closed to the internet, working through the tunnel, admin set up");
      },
    );

    step(
      "5. the Cloudflare-only filter: proxied, closed on the server's addresses, also after a reboot",
      minutes(75),
      async () => {
        await answerAndDesign("proxy");
        const redesigned = await readPlan();
        expect(redesigned.dns.proxied, "the record is proxied").toBe(true);
        expect(
          redesigned.portainer?.enabled,
          "re-running the interview and design keeps Portainer on",
        ).toBe(true);
        await provisionUntilDone();
        await deploy("the Cloudflare-only filter");

        const portainer = JSON.parse((await opscrewOk("portainer", "status", "--json")).stdout) as {
          enabled: boolean;
        };
        expect(portainer.enabled, "Portainer is still on after the switch to the filter").toBe(
          true,
        );

        await waitForDns(false);
        await waitForApp(true);
        await expectNotAnswering([80, 443], "only Cloudflare may reach the web ports");
        const listeners = webListenersBeyondIpv4(await shell().ok("ss -ltnuH"));
        expect(listeners, "nothing listens on IPv6 (or every address) on 80/443").toEqual([]);
        await opscrewOk("verify");

        const bootId = await shell().ok("cat /proc/sys/kernel/random/boot_id");
        log(
          "rebooting the server; probing its own addresses until the site answers again (up to 15 minutes)",
        );
        await shell().run("systemctl reboot", 30_000);
        const deadline = Date.now() + minutes(15);
        let rebooted = false;
        for (;;) {
          const open = await answering([80, 443], 3_000);
          expect(
            open,
            `while the server started, its own address answered on ${open.join(", ")}`,
          ).toEqual([]);
          if (!rebooted) {
            const boot = await shell().run("cat /proc/sys/kernel/random/boot_id", 30_000);
            rebooted = boot.exitCode === 0 && boot.stdout.trim() !== bootId;
            if (rebooted) log("the server is back up; waiting for the site through Cloudflare");
          } else {
            const answer = await httpsRequest(await healthUrl()).catch(() => undefined);
            if (answer?.status === 200 && answer.headers["cf-ray"] !== undefined) break;
          }
          if (Date.now() > deadline) {
            throw new Error(
              rebooted
                ? "The site did not answer within 15 minutes of the reboot."
                : "The server did not come back within 15 minutes.",
            );
          }
          await sleep(3_000);
        }
        await expectNotAnswering([80, 443], "the filter is back after the reboot");
        expect(
          webListenersBeyondIpv4(await shell().ok("ss -ltnuH")),
          "after the reboot, still IPv4 only",
        ).toEqual([]);
        // On the server: the filter unit is active and became active no later than Docker.
        const filterActive = await shell().run("systemctl is-active opscrew-web-filter.service");
        expect(filterActive.stdout.trim(), "opscrew-web-filter.service is active").toBe("active");
        const activeSince = async (unit: string) =>
          Number(
            await shell().ok(`systemctl show -p ActiveEnterTimestampMonotonic --value ${unit}`),
          );
        const filterAt = await activeSince("opscrew-web-filter.service");
        const dockerAt = await activeSince("docker.service");
        expect(
          filterAt > 0 && dockerAt > 0,
          `both units have started since the boot (filter ${filterAt}, docker ${dockerAt})`,
        ).toBe(true);
        expect(
          filterAt <= dockerAt,
          `the filter became active before Docker (filter ${filterAt}, docker ${dockerAt})`,
        ).toBe(true);
        await opscrewOk("drift");
        log(
          "Cloudflare-only filter: served through Cloudflare, closed on the server's own addresses, also after a reboot",
        );
      },
    );

    step(
      "6. the tunnel: only SSH open, served through the tunnel, a merged change deploys through Access",
      minutes(90),
      async () => {
        await answerAndDesign("tunnel");
        expect((await readPlan()).target, "tunnel mode").toMatchObject({
          provider: "own",
          access: "tunnel",
        });
        await provisionUntilDone();
        // The leak search needs the tunnel's and the service token's secrets; not finding them is
        // a finding, not a reason to stop the run.
        const outputsNow = await infraOutputs().catch((error: unknown) => {
          findings.push(
            `could not read the infrastructure outputs, so the leak search misses the tunnel token: ${String(error)}`,
          );
          return {} as Record<string, unknown>;
        });
        for (const name of [
          "tunnel_token",
          "deploy_service_token_client_secret",
          "deploy_service_token_client_id",
        ]) {
          const value = outputsNow[name];
          if (typeof value === "string" && value !== "") {
            scrubber.add(value, name.replaceAll("_", "-"));
          } else {
            findings.push(
              `the infrastructure outputs have no ${name}, so the leak search could not look for it`,
            );
          }
        }
        await deploy("the tunnel");

        const ufw = ufwRulesBeyondSsh(await shell().ok("ufw status"));
        expect(ufw.active, "ufw is active").toBe(true);
        expect(ufw.rules, "ufw status lists the SSH rule").toBeGreaterThan(0);
        expect(ufw.others, "ufw allows only SSH").toEqual([]);
        await waitForDns(false);
        await waitForApp(true);
        await expectNotAnswering([80, 443], "the tunnel opens no web port");
        await opscrewOk("verify");
        await opscrewOk("drift");

        const sshHost = `ssh-${appName}.${(zone as CloudflareZone).name}`;
        const access = await waitFor(
          `${sshHost} behind Cloudflare Access`,
          minutes(5),
          async () => {
            const answer = await httpsRequest(`https://${sshHost}/`);
            const location = String(answer.headers.location ?? "");
            return [401, 403].includes(answer.status) ||
              (answer.status >= 300 &&
                answer.status < 400 &&
                location.includes("cloudflareaccess.com"))
              ? answer.status
              : undefined;
          },
        );
        log(`${sshHost} refuses a request without the service token (${access})`);

        // A merged change deploys through the Access-protected SSH hostname: the workflow on main
        // connects to that hostname through `cloudflared access ssh` ...
        const workflow = await readFile(join(repo, (await readPlan()).cicd.workflowPath), "utf8");
        expect(workflow.includes(sshHost), `the deploy workflow on main names ${sshHost}`).toBe(
          true,
        );
        expect(
          workflow.includes("cloudflared access ssh"),
          "the deploy workflow connects through `cloudflared access ssh`",
        ).toBe(true);
        const before = await shell().ok("stat -c %Y /srv/app/.env");
        const since = await shell().ok("date +%s");
        const branch = `e2e/change-${runId}`;
        await git("checkout", "-q", "-b", branch);
        await writeFile(
          join(repo, "opscrew-e2e-change.txt"),
          `Deployed through the tunnel by run ${runId}.\n`,
        );
        await git("add", "opscrew-e2e-change.txt");
        await git("commit", "-q", "-m", "e2e: a change deployed through the tunnel");
        await git("push", "-q", "-u", "origin", branch);
        const opened = await github.call("POST", `/repos/${E2E.githubRepo}/pulls`, {
          title: "e2e: a change deployed through the tunnel",
          head: branch,
          base: "main",
          body: "Opened by the OpsCrew own-server live test.",
        });
        const number = (opened.json as { number?: number } | undefined)?.number;
        if (opened.status !== 201 || number === undefined)
          throw new Error(`GitHub did not open the change's pull request (HTTP ${opened.status}).`);
        log(
          `merging the change #${number} and waiting for its deploy through the tunnel (up to 30 minutes)`,
        );
        const sha = await github.merge(number);
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");
        const run = await github.waitForDeploy({ headSha: sha });
        expect(
          run.conclusion,
          `the change's deploy run ${run.id}: ${run.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}`,
        ).toBe("success");
        const after = await shell().ok("stat -c %Y /srv/app/.env");
        expect(Number(after) > Number(before), "the deploy wrote the server's .env again").toBe(
          true,
        );
        // ... and on the server, the deploy user's logins came from the tunnel connector (local).
        const sshLog = await shell().ok(
          `journalctl -u ssh -u sshd --since @${since} --no-pager -o cat`,
        );
        const logins = sshLog
          .split(/\r?\n/)
          .filter((line) => /Accepted publickey for deploy from /.test(line));
        expect(
          logins.length,
          "sshd logged the deploy user's logins during the deploy",
        ).toBeGreaterThan(0);
        expect(
          logins.every((line) => / from (127\.0\.0\.1|::1) port /.test(line)),
          `every deploy login came through cloudflared on the server (${logins.length} logins; from: ${[
            ...new Set(logins.map((line) => / from (\S+) port /.exec(line)?.[1] ?? "?")),
          ].join(", ")})`,
        ).toBe(true);
        await waitForApp(true, minutes(5));
        log(
          "tunnel: only SSH open, the site served through the tunnel, a merged change deployed through Access",
        );
      },
    );

    step(
      "7. destroy --undo-host removes the app, DNS, tunnel and Access; root still logs in",
      minutes(30),
      async () => {
        const name = appName as string;
        let approve: string[] = [];
        const tried: string[] = [];
        for (let attempt = 1; ; attempt++) {
          const result = await opscrew("destroy", "--confirm", name, "--undo-host", ...approve);
          if (result.exitCode === 0) break;
          const hash = hostPlanHash(result.output);
          if (hash === undefined || tried.includes(hash) || attempt >= 3) {
            throw new Error(
              `opscrew destroy --undo-host exited with ${result.exitCode}:\n${tail(result.output)}`,
            );
          }
          tried.push(hash);
          log(`approving the undo host plan ${hash}`);
          approve = ["--approve", hash];
        }
        destroyed = true;

        const left = await cloudflare.appResources(zone as CloudflareZone, name, hostnames);
        const before = cloudflareBefore as CloudflareAppResources;
        const fresh = <T extends { id: string; name: string }>(now: T[], old: T[]) =>
          now.filter((item) => !old.some((o) => o.id === item.id)).map((item) => item.name);
        expect(
          left.records.map((r) => `${r.type} ${r.name}`),
          "no DNS record of the app is left",
        ).toEqual([]);
        expect(fresh(left.tunnels, before.tunnels), "no tunnel of the app is left").toEqual([]);
        expect(fresh(left.apps, before.apps), "no Access application of the app is left").toEqual(
          [],
        );
        expect(
          fresh(left.policies, before.policies),
          "no Access policy of the app is left",
        ).toEqual([]);
        expect(
          fresh(left.serviceTokens, before.serviceTokens),
          "no service token of the app is left",
        ).toEqual([]);

        await shell().ok("true");
        const containers = await shell().ok(
          `docker ps -aq --filter label=com.docker.compose.project=${name}`,
        );
        expect(containers, "no container of the app is left").toBe("");
        const deployUser = await shell().run("id -u deploy");
        expect(deployUser.exitCode, "the deploy user is removed").not.toBe(0);
        log(
          "destroy --undo-host: app, DNS, tunnel and Access removed; root still logs in with its key",
        );
      },
    );

    step(
      "8. no server address or secret in commits, pull requests, CLI output or the audit log",
      minutes(10),
      async () => {
        if (!repoReady) return;
        const known = scrubber.entries();
        const secrets = known.filter(({ label }) => !label.startsWith("server-"));
        const problems: string[] = [];
        await git("fetch", "-q", "origin");
        const history = await git("log", "--all", "-p", "--format=%B");
        const inHistory = leakedLabels(history, known);
        if (inHistory.length > 0) problems.push(`commits contain: ${inHistory.join(", ")}`);
        for (const pull of await github.pullRequestTexts(startedAt)) {
          const found = leakedLabels(pull.text, known);
          if (found.length > 0)
            problems.push(`pull request #${pull.number} contains: ${found.join(", ")}`);
        }
        // The CLI shows the server's address on purpose only in the Portainer tunnel command and
        // in messages about "your server at <address>"; anywhere else in its output it is a leak.
        const addresses = known
          .filter(({ label }) => label.startsWith("server-"))
          .map(({ value }) => value);
        for (const [label, output] of outputs) {
          const found = leakedLabels(output, secrets);
          if (found.length > 0) problems.push(`${label} printed: ${found.join(", ")}`);
          const lines = addressLinesOutsidePurpose(output, addresses);
          if (lines > 0) problems.push(`${label} printed the server's address on ${lines} line(s)`);
        }
        const auditDir = paths().auditDir;
        if (existsSync(auditDir)) {
          for (const file of await readdir(auditDir)) {
            const found = leakedLabels(await readFile(join(auditDir, file), "utf8"), secrets);
            if (found.length > 0) problems.push(`audit log ${file} contains: ${found.join(", ")}`);
          }
        }
        expect(problems, "nothing leaked").toEqual([]);
        expect(findings, "findings of the run").toEqual([]);
      },
      true,
    );

    afterAll(async () => {
      const problems: string[] = [];
      /** Runs one cleanup action; a thrown error or returned problems are collected, never fatal. */
      const attempt = async (what: string, body: () => Promise<unknown>) => {
        try {
          const found = await body();
          if (Array.isArray(found)) problems.push(...found);
        } catch (error) {
          problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      tunnel?.kill();
      // The throwaway server and its key go first and always: they are billed.
      if (hetznerTouched) {
        log("deleting the throwaway server and its SSH key");
        await attempt("delete the throwaway server", () =>
          deleteThrowaway({
            token: E2E.hcloudToken,
            runId,
            ...(serverId === undefined ? {} : { serverId }),
            ...(keyId === undefined ? {} : { keyId }),
          }),
        );
      }
      // Always, also after a finished destroy (which should have left nothing): only ids that were
      // not there before the run are deleted.
      if (zone !== undefined && appName !== undefined && cloudflareBefore !== undefined) {
        log(
          destroyed
            ? "checking Cloudflare for anything this run created that destroy left"
            : "destroy did not finish: removing what this run created in Cloudflare",
        );
        const z = zone;
        const app = appName;
        const before = cloudflareBefore;
        await attempt("remove the Cloudflare resources", async () =>
          cloudflare.removeCreated(z, await cloudflare.appResources(z, app, hostnames), before),
        );
      }
      if (repoReady) await attempt("reset the throwaway repository", () => github.reset());
      if (work !== "") await rm(work, { recursive: true, force: true }).catch(() => undefined);
      if (problems.length > 0) {
        throw cleanError(new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`));
      }
      if (hetznerTouched) log("the throwaway server and its SSH key are deleted");
    }, minutes(15));
  },
);
