// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose files and the preload check hold ${…} on purpose.
/**
 * Live end-to-end test for an existing Portainer as a deploy target (feature 010, quickstart
 * "Gated live test", steps 1–6, and the live checks of tasks.md T1008). It creates a throwaway
 * Hetzner server outside OpsCrew (its own SSH key and firewall), installs Portainer CE 2.45.2 on it
 * as "the user's existing Portainer" (admin through the setup token, the local environment, an
 * admin's and a limited user's access tokens), adds a decoy Compose project and a decoy Portainer
 * stack, and drives the built CLI (and once the MCP server) through every web and redeploy mode:
 * updater + tunnel (with a change that deploys by itself and one that rolls back), a registry token
 * replaced through MCP, caddy, proxy (with `verify --url`), the Cloudflare redeploy mode, then
 * `destroy` with and without `--delete-data`, and finally two setups of their own with a loopback
 * and a short Portainer address (OpsCrew refuses another address while its record lists
 * anything), each removed with its data. The server, its key and firewall are always deleted
 * (afterAll), and what OpsCrew created in Cloudflare is removed through the API when `destroy` did
 * not finish. Nothing the test prints contains a token, a secret, the server's address or
 * Portainer's: every line goes through a scrubber. Runs only with OPSCREW_E2E_PORTAINER=1 and the
 * variables in docs/e2e.md ("Your existing Portainer"); costs a few cents of server time.
 *
 * `OPSCREW_E2E_PORTAINER_STEPS` selects the steps: `core` (the default, about 15 minutes) runs steps 1,
 * 2, 3 without its rollback, 8, 9 and 12; `full` (about 2 hours) runs every step and check above.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPOSE_PROJECT_LABEL,
  DEPLOY_BRANCH,
  DEPLOY_REFERENCE,
  inspectCertificate,
  opscrewNames,
  sameCertFingerprint,
} from "@opscrew/connector-portainer";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  Cloudflare,
  type CloudflareAppResources,
  type CloudflareZone,
  canConnect,
  GitHubRepo,
  httpsRequest,
  minutes,
  RootShell,
  sleep,
  type ThrowawayServer,
  waitFor,
} from "./own-cloud";
import {
  approveHashes,
  ed25519FromKeyscan,
  envFileValues,
  failedInitChecks,
  fingerprintFromKeygen,
  ipv6PrefixForms,
  leakedLabels,
  REGION_LOCATIONS,
  removalApproval,
  runHostname,
  Scrubber,
  sshFingerprint,
} from "./own-support";
import {
  branchHead,
  changedRulesets,
  commitDetails,
  createDnsRecord,
  createPortainerServer,
  deletePortainerThrowaway,
  fileAt,
  ghcrPullStatus,
  httpGet,
  jobErrors,
  McpSession,
  PortainerApi,
  packageVisibility,
  portainerAppResources,
  repoInfo,
  rulesetRules,
  runSteps,
  secretNames,
  traceText,
} from "./portainer-cloud";
import {
  appliedStackPlan,
  BUSYBOX_IMAGE,
  CORE_STEPS,
  changedKeys,
  DECOY_PROJECT,
  DECOY_STACK,
  type DeployedImage,
  deployedImage,
  dnsPreloadSource,
  duration,
  ENVIRONMENT_NAME,
  envNames,
  failingDockerfile,
  firewallRules,
  inPass,
  ipv4FromTrace,
  logErrors,
  logLineShape,
  missingPortainerVariables,
  multipartForm,
  NOT_IN_CORE,
  namesDnsRecord,
  opensslFingerprint,
  PASS_ESTIMATE,
  PORTAINER_IMAGE,
  PORTAINER_PORT,
  PORTAINER_VERSION,
  type PortainerAnswers,
  PROBE_STACK,
  PROXY_PORT,
  portainerAnswers,
  portainerPass,
  preloadNodeOptions,
  rollbackOutcome,
  SELF_DEPLOY_TARGET_MS,
  setupTokenFromLogs,
  shortHostMentions,
  shortHostName,
  stackPlanHashOf,
  stepNumber,
  THREE_RUNS_SENTENCE,
  updaterFailures,
  valueShape,
} from "./portainer-support";

// -----------------------------------------------------------------------------------------------
// The helpers, checked on every run (no network).

describe("Portainer live test helpers", () => {
  it("names every missing variable, and OPSCREW_E2E_PORTAINER must be 1", () => {
    expect(missingPortainerVariables({})).toEqual([
      "OPSCREW_E2E_PORTAINER=1",
      "OPSCREW_E2E_HCLOUD_TOKEN",
      "OPSCREW_E2E_GITHUB_REPO",
      "OPSCREW_E2E_GITHUB_TOKEN",
      "OPSCREW_E2E_CLOUDFLARE_TOKEN",
      "OPSCREW_E2E_DOMAIN",
      "OPSCREW_E2E_GHCR_READ_TOKEN",
    ]);
    const all = {
      OPSCREW_E2E_PORTAINER: "1",
      OPSCREW_E2E_HCLOUD_TOKEN: "x",
      OPSCREW_E2E_GITHUB_REPO: "acme/e2e",
      OPSCREW_E2E_GITHUB_TOKEN: "x",
      OPSCREW_E2E_CLOUDFLARE_TOKEN: "x",
      OPSCREW_E2E_DOMAIN: "e2e.example.com",
      OPSCREW_E2E_GHCR_READ_TOKEN: "x",
    };
    expect(missingPortainerVariables(all)).toEqual([]);
    expect(missingPortainerVariables({ ...all, OPSCREW_E2E_PORTAINER: "yes" })).toEqual([
      "OPSCREW_E2E_PORTAINER=1",
    ]);
    expect(missingPortainerVariables({ ...all, OPSCREW_E2E_GHCR_READ_TOKEN: " " })).toEqual([
      "OPSCREW_E2E_GHCR_READ_TOKEN",
    ]);
  });

  it("takes a short host name for the output check, nas by default", () => {
    expect(shortHostName(undefined)).toBe("nas");
    expect(shortHostName(" nas2 ")).toBe("nas2");
    expect(() => shortHostName("portainer")).toThrow(/a word OpsCrew itself prints/);
    for (const bad of [
      "localhost",
      "NAS",
      "nas.local",
      "a",
      "-nas",
      "nas-",
      "a-very-long-host-name",
    ]) {
      expect(() => shortHostName(bad)).toThrow(/OPSCREW_E2E_PORTAINER_SHORT_HOST/);
    }
  });

  it("finds Portainer's setup token in its log, whatever the line's format", () => {
    const token = randomBytes(16).toString("hex");
    const formats = [
      `2026/10/15 10:00AM INF github.com/portainer/portainer/api/cmd/portainer/main.go:612 > setup token generated | token=${token}`,
      `{"level":"info","setup_token":"${token}","message":"Setup token created"}`,
      `Use this setup token to create the administrator: ${token}`,
      `Setup token: ${token}`,
    ];
    for (const line of formats) {
      expect(
        setupTokenFromLogs(`2026/10/15 INF starting Portainer version=2.45.2\n${line}\n`),
      ).toBe(token);
    }
    expect(
      setupTokenFromLogs("2026/10/15 INF starting Portainer | version=2.45.2"),
    ).toBeUndefined();
    expect(setupTokenFromLogs("2026/10/15 INF setup token required | seconds=300")).toBeUndefined();
    const shape = logLineShape(formats[0] as string);
    expect(shape).not.toContain(token);
    expect(shape).toContain("setup token generated");
  });

  it("reads the fingerprint the guide's openssl command prints, in OpsCrew's form", () => {
    const hex = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0"));
    const canonical = `SHA256:${hex.join(":").toUpperCase()}`;
    expect(opensslFingerprint(`sha256 Fingerprint=${hex.join(":").toUpperCase()}\n`)).toBe(
      canonical,
    );
    expect(opensslFingerprint(`SHA256 Fingerprint=${hex.join(":")}`)).toBe(canonical);
    expect(opensslFingerprint("unable to load certificate")).toBeUndefined();
  });

  it("reads the stack plan hash a run showed and the one it applied", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const second = [
      "Stack plan for your Portainer: 3 to change, 0 already in place.",
      `Stack plan hash: ${b}`,
      `Stack plan hash: ${a}`,
      `The stack plan was not approved. Nothing in Portainer was changed.`,
      `  To apply it later without prompts, run: opscrew provision --approve ${a}`,
    ].join("\n");
    expect(stackPlanHashOf(second)).toBe(a);
    expect(approveHashes(second)).toEqual([a]);
    expect(appliedStackPlan(`Applied the stack plan ${a} to your Portainer.`)).toBe(a);
    expect(appliedStackPlan(`Your Portainer already matches the stack plan ${a}`)).toBeUndefined();
    expect(stackPlanHashOf("Nothing to apply.")).toBeUndefined();
  });

  it("recognises the DNS record note of caddy and proxy mode", () => {
    const note =
      "OpsCrew creates no DNS record for e2e-x.example.com: create one yourself that points it at your Portainer host (an A record, …).";
    expect(namesDnsRecord(note, "e2e-x.example.com")).toBe(true);
    expect(namesDnsRecord(note, "shop.example.com")).toBe(false);
  });

  it("reads the image and version the deploy workflow wrote, not the placeholder", () => {
    const digest = randomBytes(32).toString("hex");
    const compose = `services:\n  app:\n    image: ghcr.io/acme/shop@sha256:${digest}\n  caddy:\n    environment:\n      OPSCREW_APP_VERSION: ${digest.slice(0, 12)}\n`;
    expect(deployedImage(compose)).toEqual({
      repository: "ghcr.io/acme/shop",
      digest,
      version: digest.slice(0, 12),
    });
    const placeholder =
      "services:\n  app:\n    image: curlimages/curl:8.23.0@sha256:a134550be58ab783810e613ae96fd253c38f7bdd16d9bf9be350700c7a29ac06\n";
    expect(deployedImage(placeholder)).toBeUndefined();
    expect(deployedImage("image: __OPSCREW_APP_IMAGE__")).toBeUndefined();
  });

  it("reads the test computer's address from Cloudflare's trace and opens Portainer only to it", () => {
    expect(ipv4FromTrace("fl=1\nh=1.1.1.1\nip=192.0.2.44\nts=1\n")).toBe("192.0.2.44");
    expect(ipv4FromTrace("ip=2001:db8::1\n")).toBeUndefined();
    expect(ipv4FromTrace("ip=300.1.1.1\n")).toBeUndefined();
    const rules = firewallRules("192.0.2.44");
    const portainer = rules.find((rule) => rule.port === String(PORTAINER_PORT));
    expect(portainer?.source_ips).toEqual(["192.0.2.44/32"]);
    expect(rules.find((rule) => rule.port === String(PROXY_PORT))?.source_ips).toEqual([
      "192.0.2.44/32",
    ]);
    expect(
      rules.find((rule) => rule.port === "443" && rule.protocol === "tcp")?.source_ips,
    ).toEqual(["0.0.0.0/0", "::/0"]);
    expect(rules.map((rule) => rule.port)).not.toContain("9000");
    expect(rules.map((rule) => rule.port)).not.toContain("8000");
  });

  it("builds a multipart form for Portainer's environment endpoint", () => {
    const form = multipartForm({ Name: ENVIRONMENT_NAME, EndpointCreationType: "1" });
    const boundary = /boundary=(\S+)$/.exec(form.contentType)?.[1] as string;
    expect(form.body).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="Name"\r\n\r\nlocal\r\n--${boundary}\r\nContent-Disposition: form-data; name="EndpointCreationType"\r\n\r\n1\r\n--${boundary}--\r\n`,
    );
  });

  it("counts a short host name only where it is a host name", () => {
    const leaks = [
      "Could not reach https://nas:9443 in time.",
      "your Portainer at nas.",
      "connect to //nas/api",
      "host nas answered",
    ];
    for (const text of leaks) expect(shortHostMentions(text, "nas"), text).toBe(1);
    const fine = [
      "opscrew-shop-nas-tunnel",
      "nasal nasty canasta",
      "nas.local",
      "NAS",
      "portainer.url and the NAS",
      "path/to/nas_backup",
    ];
    for (const text of fine) expect(shortHostMentions(text, "nas"), text).toBe(0);
    expect(shortHostMentions("portainer.url, portainer.web", "portainer")).toBe(0);
    expect(shortHostMentions("opscrew-shop-portainer-tunnel", "portainer")).toBe(0);
    expect(shortHostMentions("https://portainer:9443/api", "portainer")).toBe(1);
  });

  it("describes the shape of a value without any of its contents", () => {
    const secret = fakeSecret("generic-password", "webhook");
    const shape = valueShape({
      DeploymentStatus: [{ Status: 1, Message: "", Time: 1 }],
      AutoUpdate: { Webhook: secret, ForcePullImage: false, Interval: "" },
      GitConfig: null,
    });
    expect(shape).toBe(
      "{ AutoUpdate: { ForcePullImage: boolean, Interval: string, Webhook: string }, DeploymentStatus: 1 × { Message: string, Status: number, Time: number }, GitConfig: null }",
    );
    expect(shape).not.toContain(secret);
    expect(valueShape([])).toBe("[]");
  });

  it("names the keys that changed between two snapshots", () => {
    expect(changedKeys({ a: 1, b: [1], c: "x" }, { a: 1, b: [2], d: true })).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(changedKeys({ a: { x: 1 } }, { a: { x: 1 } })).toEqual([]);
  });

  it("selects the core pass by default and every step only in the full pass", () => {
    expect(portainerPass(undefined)).toBe("core");
    expect(portainerPass(" ")).toBe("core");
    expect(portainerPass("core")).toBe("core");
    expect(portainerPass("FULL")).toBe("full");
    expect(portainerPass("all")).toBeUndefined();
    expect(stepNumber("1b. (optional) pauses")).toBe("1b");
    expect(stepNumber("12. no token")).toBe("12");
    expect(stepNumber("no number")).toBe("");
    const core = ["1", "1b", "2", "3", "8", "9", "12"];
    const others = ["4", "5", "6", "7", "10", "11"];
    for (const step of core) expect(inPass("core", `${step}. a step`), step).toBe(true);
    for (const step of others) expect(inPass("core", `${step}. a step`), step).toBe(false);
    for (const step of [...core, ...others]) expect(inPass("full", step), step).toBe(true);
    expect(inPass("core", "3-rollback")).toBe(false);
    expect(inPass("full", "3-rollback")).toBe(true);
    expect(NOT_IN_CORE).toContain("OPSCREW_E2E_PORTAINER_STEPS=full");
    expect(Object.keys(PASS_ESTIMATE).sort()).toEqual(["core", "full"]);
  });

  it("counts the updater's failed calls and makes a Dockerfile that fails on purpose", () => {
    const line =
      "OpsCrew updater: asking Portainer to redeploy the app failed; trying again in 60 seconds.";
    expect(updaterFailures(`${line}\nok\n${line}\n`)).toBe(2);
    expect(updaterFailures("")).toBe(0);
    const failing = failingDockerfile('FROM node:22-alpine\nCMD ["node", "server.js"]\n');
    expect(failing.startsWith('FROM node:22-alpine\nCMD ["node", "server.js"]\n')).toBe(true);
    expect(failing.trimEnd().split("\n").at(-1)).toMatch(/^CMD \["\/bin\/sh", "-c", ".*exit 1"\]$/);
  });

  it("reads the rollback's outcome from the error lines of the failed job's log", () => {
    const branch = "opscrew-deploy";
    const exit = "Process completed with exit code 1.";
    const wrote = `The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, and Portainer's updater deploys it within about a minute.`;
    const log = [
      '\uFEFF2026-10-16T09:12:01.1234567Z ##[group]Run echo "::error::The deploy failed; ..."',
      `2026-10-16T09:12:01.1234568Z echo "::error::${wrote}"`,
      "2026-10-16T09:12:01.1234569Z ##[endgroup]",
      `2026-10-16T09:12:02.0000001Z ##[error]${wrote}\r`,
      "2026-10-16T09:12:02.0000002Z PORTAINER_TOKEN: ***",
      `2026-10-16T09:12:03.0000003Z ##[error]${exit}`,
      "##[error]An error line without a timestamp",
      "",
    ].join("\n");
    expect(logErrors(log)).toEqual([wrote, exit, "An error line without a timestamp"]);
    expect(logErrors("")).toEqual([]);
    expect(rollbackOutcome(logErrors(log))).toEqual({ ok: true, message: wrote });
    expect(rollbackOutcome([exit, wrote])).toEqual({ ok: true, message: wrote });
    const asked = `The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch and asked Portainer to deploy it.`;
    expect(rollbackOutcome([asked])).toEqual({ ok: true, message: asked });
    for (const message of [
      `The deploy failed and OpsCrew could not write the previous version back to the ${branch} branch. Write it back by hand.`,
      `The deploy failed and the ${branch} branch had no earlier version to restore. Fix the problem and push again.`,
      `The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, but Portainer did not confirm the redeploy (HTTP 500). Redeploy the stack in Portainer.`,
    ]) {
      const outcome = rollbackOutcome([exit, message]);
      expect(outcome.ok, message).toBe(false);
      expect(outcome.message).toContain(message);
    }
    const none = rollbackOutcome([exit]);
    expect(none.ok).toBe(false);
    expect(none.message).toContain(exit);
    expect(rollbackOutcome([]).message).toContain("no error lines");
  });

  it("reads a job log through its redirect without sending the token to the log's host", async () => {
    const token = "e2e-test-token";
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization") });
      if (String(url).startsWith("https://api.github.com/")) {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://logs.example.net/job/7?sig=abc" },
        });
      }
      return new Response("2026-10-16T09:12:02.0000001Z ##[error]boom\n", { status: 200 });
    }) as typeof fetch;
    const github = new GitHubRepo(token, "owner/repo");
    const read = await github.redirectedText("/repos/owner/repo/actions/jobs/7/logs", fetchImpl);
    expect(read.status).toBe(200);
    expect(logErrors(read.text)).toEqual(["boom"]);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/owner/repo/actions/jobs/7/logs",
        auth: `Bearer ${token}`,
      },
      { url: "https://logs.example.net/job/7?sig=abc", auth: null },
    ]);
    const denied = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    expect(await github.redirectedText("/x", denied)).toEqual({ status: 403, text: "" });
  });

  it("lists a container's variables by name and emptiness, never by value", () => {
    const secret = fakeSecret("generic-password", "probe");
    const env = JSON.stringify(["PATH=/bin", `PROBE_SET=${secret}`, "PROBE_EMPTY=", "PROBE_BARE"]);
    const names = envNames(env, "PROBE_");
    expect(names).toEqual([
      { name: "PROBE_BARE", empty: true },
      { name: "PROBE_EMPTY", empty: true },
      { name: "PROBE_SET", empty: false },
    ]);
    expect(JSON.stringify(names)).not.toContain(secret);
  });

  it("writes the interview answers for each Portainer mode", () => {
    const base: PortainerAnswers = {
      domain: "e2e-x.example.com",
      url: "https://192.0.2.10:9443",
      redeploy: "updater",
      web: "tunnel",
    };
    expect(portainerAnswers(base)).toMatchObject({
      provider: "portainer",
      domain: "e2e-x.example.com",
      "portainer.url": "https://192.0.2.10:9443",
      "portainer.environment": ENVIRONMENT_NAME,
      "portainer.redeploy": "updater",
      "portainer.web": "tunnel",
    });
    expect(portainerAnswers(base)).not.toHaveProperty("portainer.port");
    expect(portainerAnswers({ ...base, web: "proxy" })["portainer.port"]).toBe(PROXY_PORT);
    expect(duration(185_400)).toBe("3 min 5 s");
  });

  it("lets a child Node process reach a short host name through the DNS preload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-e2e-preload-"));
    try {
      const preload = join(dir, "short-host-dns.mjs");
      await writeFile(preload, dnsPreloadSource({ "opscrew-e2e-nas": "127.0.0.1" }));
      const script = join(dir, "check.mjs");
      await writeFile(
        script,
        [
          'import net from "node:net";',
          'import dns from "node:dns";',
          "const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1', async () => {",
          "  const { port } = server.address();",
          "  const found = await dns.promises.lookup('opscrew-e2e-nas');",
          "  const socket = net.connect({ host: 'opscrew-e2e-nas', port }, () => {",
          "    console.log(`connected ${found.address}`);",
          "    socket.destroy();",
          "    server.close();",
          "  });",
          "  socket.on('error', (error) => { console.log(`failed ${error.code}`); server.close(); });",
          "});",
        ].join("\n"),
      );
      const result = await new NodeCommandRunner().run(process.execPath, [script], {
        env: {
          ...process.env,
          NODE_OPTIONS: preloadNodeOptions(pathToFileURL(preload).href),
        },
        timeoutMs: 30_000,
      });
      expect(`${result.stdout}${result.stderr}`.trim()).toBe("connected 127.0.0.1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------------------------
// The live run.

const ENV = process.env;
/** The steps this run takes (`OPSCREW_E2E_PORTAINER_STEPS`, `core` by default). */
const PASS = portainerPass(ENV.OPSCREW_E2E_PORTAINER_STEPS) ?? "core";
const MISSING = [
  ...missingPortainerVariables(ENV),
  ...(portainerPass(ENV.OPSCREW_E2E_PORTAINER_STEPS) === undefined
    ? ["OPSCREW_E2E_PORTAINER_STEPS=core or full (unset means core)"]
    : []),
];
const E2E = {
  hcloudToken: ENV.OPSCREW_E2E_HCLOUD_TOKEN ?? "",
  githubRepo: ENV.OPSCREW_E2E_GITHUB_REPO ?? "",
  githubToken: ENV.OPSCREW_E2E_GITHUB_TOKEN ?? "",
  cloudflareToken: ENV.OPSCREW_E2E_CLOUDFLARE_TOKEN ?? "",
  /** Optional: a narrower Cloudflare token OpsCrew uses for the updater + tunnel steps (2–4). */
  cloudflareTunnelToken: ENV.OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN?.trim() || undefined,
  domain: (ENV.OPSCREW_E2E_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, ""),
  ghcrToken: ENV.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "",
  /** Needed only when the throwaway repository is private. */
  repoReadToken: ENV.OPSCREW_E2E_REPO_READ_TOKEN?.trim() || undefined,
  region: ENV.OPSCREW_E2E_REGION?.trim() || "eu-central",
  serverType: ENV.OPSCREW_E2E_PORTAINER_SERVER_TYPE?.trim() || undefined,
  app: ENV.OPSCREW_E2E_APP?.trim() || "nextjs-postgres",
  appEnvFile: ENV.OPSCREW_E2E_APP_ENV,
  shortHost: ENV.OPSCREW_E2E_PORTAINER_SHORT_HOST,
  /** Optional: pause after the setup so the guide's browser and UI steps can be checked by hand. */
  manualMinutes: Number(ENV.OPSCREW_E2E_PORTAINER_MANUAL_MINUTES ?? "0") || 0,
};

if (MISSING.length > 0 && ENV.OPSCREW_E2E_PORTAINER === "1") {
  console.warn(
    `OpsCrew E2E (Portainer): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Your existing Portainer").`,
  );
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
const EXAMPLES = join(REPO_ROOT, "examples");
const ADMIN_USER = "admin";
const LIMITED_USER = "opscrew-e2e-limited";

type Web = PortainerAnswers["web"];

interface CliRun {
  exitCode: number;
  stdout: string;
  /** stdout and stderr; may hold anything, so print it only through `scrub`. */
  output: string;
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live end-to-end in your existing Portainer (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live end-to-end in your existing Portainer: examples/${E2E.app} on a throwaway Portainer CE ${PORTAINER_VERSION}`,
  () => {
    const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const appHost = E2E.domain === "" ? "" : runHostname(E2E.domain, runId);
    const startedAt = new Date();
    const runner = new NodeCommandRunner();
    const scrubber = new Scrubber();
    const scrub = scrubber.scrub;
    const github = new GitHubRepo(E2E.githubToken, E2E.githubRepo);
    const cloudflare = new Cloudflare(E2E.cloudflareToken);
    scrubber.add(E2E.hcloudToken, "hetzner-token");
    scrubber.add(E2E.githubToken, "github-token");
    scrubber.add(E2E.cloudflareToken, "cloudflare-token");
    scrubber.add(E2E.cloudflareTunnelToken, "cloudflare-tunnel-token");
    scrubber.add(E2E.ghcrToken, "OPSCREW_GHCR_READ_TOKEN");
    scrubber.add(E2E.repoReadToken, "OPSCREW_REPO_READ_TOKEN");

    /** Raw CLI outputs by (scrubbed) label: never printed, searched at the end. */
    const outputs = new Map<string, string>();
    /** Everything the MCP server sent (results, dialogs, standard error). */
    const mcpTexts: string[] = [];
    /** The latest content of every file in `.opscrew/plans/` (destroy removes the stack plans). */
    const planFiles = new Map<string, string>();
    /** Problems that do not stop the run but fail it at the end. */
    const findings: string[] = [];
    /** The live facts the run observed (the run log of tasks.md T1008). */
    const observations: string[] = [];
    let stopped = false;

    let work = "";
    let repo = "";
    let keyFile = "";
    let knownHostsFile = "";
    let env: Record<string, string | undefined> = {};
    let repoReady = false;
    let repoPrivate = false;
    let owner = "";
    let ownerType = "User";
    let server: ThrowawayServer | undefined;
    let hetznerTouched = false;
    let serverId: number | undefined;
    let keyId: number | undefined;
    let firewallId: number | undefined;
    let root: RootShell | undefined;
    let shortHost = "nas";
    let portainerUrl = "";
    let fingerprint = "";
    let admin: PortainerApi | undefined;
    let adminToken = "";
    let limitedToken = "";
    let limitedUserId = 0;
    let environmentId = 0;
    let decoyStackId = 0;
    let decoysBefore = "";
    let portainerBefore: Record<string, unknown> = {};
    let appName: string | undefined;
    let zone: CloudflareZone | undefined;
    let hostnames: string[] = [];
    let cloudflareBefore: CloudflareAppResources | undefined;
    /** The rules of every zone ruleset that existed before the run (id → name and rules). */
    const rulesetsBefore = new Map<string, { name: string; rules: string | undefined }>();
    let web: Web = "tunnel";
    let recordedVolumes: string[] = [];
    let registryId: number | undefined;
    const testRecords: string[] = [];
    let destroyed = false;
    let tunnel: ChildProcess | undefined;

    const log = (message: string) => console.log(`OpsCrew E2E (Portainer): ${scrub(message)}`);
    const tail = (text: string, lines = 60) =>
      scrub(text).trimEnd().split(/\r?\n/).slice(-lines).join("\n");
    /** Records a live fact for the run log (tasks.md T1008); never a value. */
    const observe = (fact: string) => {
      observations.push(scrub(fact));
      log(`observed: ${fact}`);
    };

    function cleanError(error: unknown): Error {
      const message = error instanceof Error ? error.message : String(error);
      const clean = new Error(scrub(message));
      clean.stack = scrub(error instanceof Error ? (error.stack ?? message) : message);
      return clean;
    }

    if (MISSING.length === 0) {
      log(
        `the ${PASS} pass (OPSCREW_E2E_PORTAINER_STEPS=${PASS}): ${PASS === "full" ? "every step" : `steps ${CORE_STEPS.join(", ")}, step 3 without its rollback`}; expected to take ${PASS_ESTIMATE[PASS]}`,
      );
    }

    /**
     * An ordered step: skipped when it is not in the selected pass, or after an earlier step failed
     * (unless `always`); errors scrubbed.
     */
    function step(title: string, timeoutMs: number, body: () => Promise<void>, always = false) {
      if (!inPass(PASS, title)) {
        it.skip(`${title} (skipped: ${NOT_IN_CORE})`, () => undefined);
        return;
      }
      it(title, { timeout: timeoutMs }, async (context) => {
        if (stopped && !always) context.skip();
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
    const portainer = () => admin as PortainerApi;
    const app = () => appName as string;
    const names = () => opscrewNames(app());
    const paths = () => resolveProjectPaths(repo, { env });
    const readPlan = (): Promise<DeployPlan> =>
      readArtifact("plan", join(repo, "opscrew/plan.yaml"));

    async function git(...args: string[]): Promise<string> {
      const result = await runner.run("git", ["-C", repo, ...args], { env, timeoutMs: minutes(5) });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(-500)}`);
      }
      return result.stdout.trim();
    }

    /** Keeps the latest copy of every saved plan for the leak check. */
    async function snapshotPlans(): Promise<void> {
      const dir = paths().files.plansDir;
      if (!existsSync(dir)) return;
      for (const file of await readdir(dir)) {
        planFiles.set(file, await readFile(join(dir, file), "utf8").catch(() => ""));
      }
    }

    /** Runs the built CLI in the project, non-interactively (`CI=1`), with `overrides` in its env. */
    async function opscrewWith(
      overrides: Record<string, string | undefined>,
      ...args: string[]
    ): Promise<CliRun> {
      log(`running opscrew ${args.join(" ")}`);
      const result = await runner.run(process.execPath, [CLI, ...args], {
        cwd: repo,
        env: { ...env, ...overrides },
        timeoutMs: minutes(30),
      });
      const output = `${result.stdout}\n${result.stderr}`;
      outputs.set(scrub(`#${outputs.size + 1} opscrew ${args.join(" ")}`), output);
      await snapshotPlans();
      if (result.timedOut === true) {
        throw new Error(`opscrew ${args.join(" ")} did not finish in 30 minutes:\n${tail(output)}`);
      }
      return { exitCode: result.exitCode, stdout: result.stdout, output };
    }

    const opscrew = (...args: string[]) => opscrewWith({}, ...args);

    const opscrewOk = (...args: string[]) => opscrewOkWith({}, ...args);

    async function opscrewOkWith(
      overrides: Record<string, string | undefined>,
      ...args: string[]
    ): Promise<CliRun> {
      const result = await opscrewWith(overrides, ...args);
      if (result.exitCode !== 0) {
        throw new Error(
          `opscrew ${args.join(" ")} exited with ${result.exitCode}:\n${tail(result.output)}`,
        );
      }
      return result;
    }

    /** Interview (Portainer, the pinned certificate) then design, checking the plan's target. */
    async function answerAndDesign(
      answers: Omit<PortainerAnswers, "domain">,
      overrides: Record<string, string | undefined> = {},
    ): Promise<void> {
      const file = join(work, "answers.json");
      await writeFile(file, JSON.stringify(portainerAnswers({ ...answers, domain: appHost })));
      const interview = await opscrewWith(
        overrides,
        "interview",
        "--answers",
        file,
        "--portainer-cert",
        fingerprint,
      );
      if (interview.exitCode !== 0) {
        throw new Error(
          `opscrew interview exited with ${interview.exitCode}:\n${tail(interview.output)}`,
        );
      }
      const design = await opscrewWith(overrides, "design");
      if (design.exitCode !== 0) {
        throw new Error(`opscrew design exited with ${design.exitCode}:\n${tail(design.output)}`);
      }
      const plan = await readPlan();
      expect(plan.target, "design planned the user's Portainer as answered").toMatchObject({
        provider: "portainer",
        mode: "portainer-stack",
        environmentId,
        redeploy: answers.redeploy,
        web: answers.web === "proxy" ? { mode: "proxy", port: PROXY_PORT } : { mode: answers.web },
      });
      const local = JSON.parse(await readFile(join(paths().stateDir, "server.json"), "utf8")) as {
        portainer?: { url?: string; certFingerprint?: string; environmentId?: number };
      };
      expect(local.portainer?.url, "server.json keeps Portainer's address").toBe(answers.url);
      expect(
        sameCertFingerprint(local.portainer?.certFingerprint ?? "", fingerprint),
        "server.json pins the confirmed certificate",
      ).toBe(true);
    }

    /**
     * The documented three runs of a script when the stack plan needs a tunnel's token that does
     * not exist yet: `--plan-only` prints only the infrastructure hash (and says so), applying it
     * stops at the stack plan and prints its hash, `--yes` alone never approves that plan, and the
     * third run applies exactly that hash. A deviation is a finding and the generic loop finishes.
     */
    async function threeRuns(
      label: string,
      firstSetup: boolean,
    ): Promise<{ stackHash?: string; output: string }> {
      const first = await opscrewOk("provision", "--plan-only", "--yes");
      const hashes = approveHashes(first.output);
      if (hashes.length !== 1 || !first.output.includes(THREE_RUNS_SENTENCE)) {
        findings.push(
          `${label}: --plan-only printed ${hashes.length} hash(es)${first.output.includes(THREE_RUNS_SENTENCE) ? "" : " and no three-runs note"}, not only the infrastructure hash`,
        );
        return { output: (await provisionUntilDone(label)).output };
      }
      const infra = hashes[0] as string;
      const second = await opscrew("provision", "--approve", infra, "--yes");
      const stackHash = stackPlanHashOf(second.output);
      if (
        second.exitCode === 0 ||
        stackHash === undefined ||
        !approveHashes(second.output).includes(stackHash)
      ) {
        findings.push(
          `${label}: the second run (exit ${second.exitCode}) did not stop at the stack plan with its hash`,
        );
        return { output: (await provisionUntilDone(label)).output };
      }
      log(`${label}: the second run applied the infrastructure and stopped at the stack plan`);
      if (firstSetup) {
        const stacks = await stackNames();
        expect(
          stacks.filter((name) => name.startsWith(names().app)),
          "nothing of the app is in Portainer before the stack plan is approved",
        ).toEqual([]);
      }
      // The deploy branch as the second run left it (a first setup: just created with the
      // placeholder); the later runs must not write it again (T1012: no replace of a placeholder).
      const deployHead = firstSetup
        ? await createdBranchHead(DEPLOY_BRANCH)
        : await branchHead(github, DEPLOY_BRANCH);
      const yesOnly = await opscrew("provision", "--yes");
      expect(yesOnly.exitCode, "--yes alone never approves the stack plan").not.toBe(0);
      if (stackPlanHashOf(yesOnly.output) !== stackHash) {
        findings.push(`${label}: a run with --yes alone showed another stack plan hash`);
      }
      expect(
        await branchHead(github, DEPLOY_BRANCH),
        `${label}: the run with --yes alone left the ${DEPLOY_BRANCH} branch as it was`,
      ).toBe(deployHead);
      const third = await opscrewOk("provision", "--approve", stackHash, "--yes");
      expect(
        appliedStackPlan(third.output),
        `${label}: the third run applies the stack plan the second printed`,
      ).toBe(stackHash);
      expect(
        await branchHead(github, DEPLOY_BRANCH),
        `${label}: the third run left the ${DEPLOY_BRANCH} branch as it was`,
      ).toBe(deployHead);
      observe(
        `${label}: the three script runs worked, with the same stack plan hash on the second and third run`,
      );
      return { stackHash, output: `${first.output}\n${second.output}\n${third.output}` };
    }

    /**
     * `provision --plan-only`, then `provision --approve <each printed hash> --yes` (with
     * `--confirm <app>` when the plan deletes something), following the stack plan's hash when an
     * apply stops at it, until a run finishes. Returns every run's output.
     */
    async function provisionUntilDone(
      label: string,
      overrides: Record<string, string | undefined> = {},
    ): Promise<{ output: string }> {
      const all: string[] = [];
      for (let round = 1; round <= 4; round++) {
        const planned = await opscrewOkWith(overrides, "provision", "--plan-only", "--yes");
        all.push(planned.output);
        const removal = removalApproval(planned.output);
        let hashes = removal?.hashes ?? approveHashes(planned.output);
        const confirm = removal === undefined ? [] : ["--confirm", app()];
        if (removal !== undefined && removal.app !== app()) {
          throw new Error(`The printed command confirms "${removal.app}", not the app's name.`);
        }
        if (hashes.length === 0) {
          log(`${label}: both plans are applied already; finishing provision`);
          all.push((await opscrewOkWith(overrides, "provision", "--yes")).output);
          return { output: all.join("\n") };
        }
        for (let follow = 1; follow <= 3; follow++) {
          const applied = await opscrewWith(
            overrides,
            "provision",
            ...hashes.flatMap((hash) => ["--approve", hash]),
            ...confirm,
            "--yes",
          );
          all.push(applied.output);
          if (applied.exitCode === 0) return { output: all.join("\n") };
          const next = approveHashes(applied.output).filter((hash) => !hashes.includes(hash));
          if (next.length === 0) {
            throw new Error(
              `${label}: opscrew provision --approve … exited with ${applied.exitCode}:\n${tail(applied.output)}`,
            );
          }
          log(`${label}: provision asks for another plan; approving the hash it printed`);
          hashes = next;
        }
      }
      throw new Error(`${label}: opscrew provision did not finish after 4 rounds of plans.`);
    }

    /**
     * Deploys what the last provision prepared: merges its pull request and waits for that run to
     * succeed. Returns false when provision committed nothing (the stacks changed in Portainer
     * directly), so there is nothing to deploy.
     */
    async function deploy(what: string): Promise<number | undefined> {
      const head = await git("rev-parse", "--abbrev-ref", "HEAD");
      const pull = head.startsWith("opscrew/deploy-setup")
        ? await github.openPullRequest(head)
        : undefined;
      if (head.startsWith("opscrew/deploy-setup") && pull === undefined) {
        throw new Error(`provision left ${head} checked out but opened no pull request from it.`);
      }
      if (pull === undefined) {
        if (head !== "main") throw new Error(`provision left ${head} checked out.`);
        log(`provision committed nothing (${what}); nothing to deploy`);
        return undefined;
      }
      log(
        `merging pull request #${pull} (${what}) and waiting for its deploy run (up to 30 minutes)`,
      );
      const sha = await github.merge(pull);
      await git("fetch", "-q", "origin");
      await git("checkout", "-q", "-B", "main", "origin/main");
      const run = await github.waitForDeploy({ headSha: sha });
      const failed = run.jobs.filter((job) => job.conclusion !== "success");
      if (run.conclusion !== "success" || failed.length > 0) {
        throw new Error(
          `The deploy run ${run.id} (${what}) ended ${run.conclusion}; jobs: ${run.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}.`,
        );
      }
      log(`deploy run ${run.id} (${what}) succeeded`);
      return run.id;
    }

    /** The app's health URL for the current web mode (proxy: Caddy on the host's port). */
    async function siteUrl(): Promise<string> {
      const health = (await readPlan()).app.healthPath;
      return web === "proxy"
        ? `http://${ipv4()}:${PROXY_PORT}${health}`
        : `https://${appHost}${health}`;
    }

    /** The version (`X-OpsCrew-Image`) the site answers 200 with, checking Cloudflare per mode. */
    async function siteVersion(): Promise<string> {
      const url = await siteUrl();
      const answer = web === "proxy" ? await httpGet(url) : await httpsRequest(url);
      if (answer.status !== 200) throw new Error(`the site answered ${answer.status}`);
      if (web !== "proxy") {
        const ray = answer.headers["cf-ray"] !== undefined;
        if (ray !== (web === "tunnel")) {
          throw new Error(
            `the site answered ${ray ? "with" : "without"} Cloudflare's cf-ray header`,
          );
        }
      }
      const version = answer.headers["x-opscrew-image"];
      return typeof version === "string" ? version : "";
    }

    /** Waits until the site answers 200 with `version` (any version when undefined). */
    async function waitForSite(version: string | undefined, timeoutMs = minutes(10)) {
      log(`waiting for the site (${web}) to answer${version ? ` with version ${version}` : ""}`);
      await waitFor(
        `the site (${web}) answering 200${version ? ` with ${version}` : ""}`,
        timeoutMs,
        async () => {
          const seen = await siteVersion();
          if (version !== undefined && seen !== version)
            throw new Error(`it runs version ${seen || "(none)"}`);
          return true;
        },
      );
    }

    /** The image the deploy branch runs now. */
    async function deployBranchImage(): Promise<DeployedImage> {
      const compose = await fileAt(github, "compose.yaml", DEPLOY_BRANCH);
      const image = compose === undefined ? undefined : deployedImage(compose);
      if (image === undefined) {
        throw new Error(`The ${DEPLOY_BRANCH} branch does not run an app image yet.`);
      }
      return image;
    }

    /**
     * The head of a branch a product run just created: GitHub's reads can lag a fresh ref for a
     * moment, so this asks again for up to 30 seconds while the branch is absent. Returns
     * `undefined` only when it is still absent then (the caller's assertion reports that). Only for
     * a branch expected to exist: where absence is expected, read once with `branchHead`, since a
     * retry there would only hide a failed deletion.
     */
    async function createdBranchHead(branch: string): Promise<string | undefined> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const head = await branchHead(github, branch);
        if (head !== undefined || Date.now() >= deadline) return head;
        await sleep(2_000);
      }
    }

    /**
     * The deploy branch holds exactly the placeholder: an orphan commit with only `compose.yaml`,
     * which runs no app image. Returns its head.
     */
    async function expectPlaceholderBranch(what: string): Promise<string> {
      const head = await createdBranchHead(DEPLOY_BRANCH);
      expect(head, `${what}: the ${DEPLOY_BRANCH} branch exists`).toBeDefined();
      const commit = await commitDetails(github, head as string);
      expect(
        { parents: commit.parents, paths: commit.paths },
        `${what}: the ${DEPLOY_BRANCH} branch is an orphan holding only compose.yaml`,
      ).toEqual({ parents: 0, paths: ["compose.yaml"] });
      const compose = await fileAt(github, "compose.yaml", DEPLOY_BRANCH);
      expect(
        compose === undefined ? "missing" : deployedImage(compose),
        `${what}: the ${DEPLOY_BRANCH} branch holds the placeholder, not an app image`,
      ).toBeUndefined();
      return head as string;
    }

    /** The items under "What remains:" in a destroy output. */
    function whatRemains(output: string): string[] {
      const lines = output.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim() === "What remains:");
      if (start === -1) return [];
      const items: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (!/^\s+- /.test(line)) break;
        items.push(line.trim());
      }
      return items;
    }

    /**
     * T1012: destroy deleted the deploy branch once the app's stack was gone, said so, and does not
     * list it under what remains. Only the branch's own item ("The opscrew-deploy branch of …")
     * counts: the workflow file `.github/workflows/opscrew-deploy.yml` stays listed among the
     * files that remain.
     */
    async function expectDeployBranchDeleted(output: string, what: string): Promise<void> {
      expect(
        await branchHead(github, DEPLOY_BRANCH),
        `${what}: the ${DEPLOY_BRANCH} branch is deleted`,
      ).toBeUndefined();
      expect(
        output.includes(`Deleted the branch ${DEPLOY_BRANCH}`),
        `${what}: destroy says it deleted the ${DEPLOY_BRANCH} branch`,
      ).toBe(true);
      expect(
        whatRemains(output).filter((item) =>
          item.replace(/^- /, "").startsWith(`The ${DEPLOY_BRANCH} branch of `),
        ),
        `${what}: "What remains" does not list the ${DEPLOY_BRANCH} branch`,
      ).toEqual([]);
    }

    /**
     * Keeps the deploy branch's history in a local ref (`refs/e2e/deploy-<label>`) before destroy
     * deletes it on GitHub, so the leak search still covers every commit the workflow wrote.
     */
    async function keepDeployBranch(label: string): Promise<void> {
      if ((await branchHead(github, DEPLOY_BRANCH)) === undefined) {
        findings.push(
          `there was no ${DEPLOY_BRANCH} branch to keep before ${label}, so its history is not searched`,
        );
        return;
      }
      await git("fetch", "-q", "origin", `+refs/heads/${DEPLOY_BRANCH}:refs/e2e/deploy-${label}`);
    }

    /** The names of every stack in Portainer (admin view). */
    async function stackNames(): Promise<string[]> {
      const stacks = await portainer().ok<{ Name: string }[]>("GET", "/api/stacks", "list stacks");
      return stacks.map((stack) => stack.Name).sort();
    }

    /** A stack by name (admin view), or undefined. */
    async function stackByName(name: string): Promise<Record<string, unknown> | undefined> {
      const stacks = await portainer().ok<Record<string, unknown>[]>(
        "GET",
        "/api/stacks",
        "list stacks",
      );
      const found = stacks.find((stack) => stack.Name === name);
      if (found === undefined) return undefined;
      return portainer().ok<Record<string, unknown>>(
        "GET",
        `/api/stacks/${found.Id}`,
        "read a stack",
      );
    }

    /** The app's containers on the host, with their ids and start times. */
    const appContainers = () =>
      shell().ok(
        `docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${names().app} | sort | xargs -r docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}'`,
      );

    /** The decoys as they are now: their containers and volumes on the host, the decoy stack in Portainer. */
    async function decoys(): Promise<string> {
      const docker = await shell().ok(
        [
          `for p in ${DECOY_PROJECT} ${DECOY_STACK}; do`,
          '  echo "project $p"',
          `  docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=$p | sort | xargs -r docker inspect -f '{{.Name}} {{.Id}} {{.Config.Image}} {{.State.Status}} {{.State.StartedAt}} {{.RestartCount}}'`,
          `  docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=$p | sort`,
          "done",
        ].join("\n"),
      );
      const stack = await portainer().ok<Record<string, unknown>>(
        "GET",
        `/api/stacks/${decoyStackId}`,
        "read the decoy stack",
      );
      const file = await portainer().ok<{ StackFileContent?: string }>(
        "GET",
        `/api/stacks/${decoyStackId}/file`,
        "read the decoy stack's file",
      );
      const kept = Object.fromEntries(
        [
          "Id",
          "Name",
          "Type",
          "EndpointId",
          "Status",
          "Env",
          "UpdateDate",
          "UpdatedBy",
          "CreationDate",
        ].map((key) => [key, stack[key]]),
      );
      return JSON.stringify({ docker, stack: kept, file: file.StackFileContent ?? "" }, null, 1);
    }

    async function expectDecoysUnchanged(after: string): Promise<void> {
      const now = await decoys();
      if (now !== decoysBefore) {
        const before = decoysBefore.split("\n");
        const lines = now.split("\n");
        const differ = [
          ...lines.filter((line) => !before.includes(line)).map((line) => `now: ${line}`),
          ...before.filter((line) => !lines.includes(line)).map((line) => `before: ${line}`),
        ];
        expect(
          differ,
          `the decoy Compose project and the decoy stack are unchanged after ${after}`,
        ).toEqual([]);
      }
      expect(now, `the decoys are exactly as before after ${after}`).toBe(decoysBefore);
      log(`the decoys are unchanged after ${after}`);
    }

    /**
     * What tells whether Portainer redeployed the app's stack, compared but never printed: its
     * `UpdateDate` and `UpdatedBy`, the number of `DeploymentStatus` entries and the deployed
     * commit (`GitConfig.ConfigHash`).
     */
    async function stackMarks(): Promise<Record<string, unknown>> {
      const stack = await stackByName(names().app);
      const status = stack?.DeploymentStatus;
      return {
        UpdateDate: stack?.UpdateDate,
        UpdatedBy: stack?.UpdatedBy,
        DeploymentStatus: Array.isArray(status) ? status.length : 0,
        ConfigHash: (stack?.GitConfig as { ConfigHash?: unknown } | null | undefined)?.ConfigHash,
      };
    }

    /** What "the user's" Portainer holds besides the app: settings, users, environments, registries, stacks. */
    async function portainerState(): Promise<Record<string, unknown>> {
      const users = await portainer().ok<{ Id: number; Username: string; Role: number }[]>(
        "GET",
        "/api/users",
        "list users",
      );
      const endpoints = await portainer().ok<Record<string, unknown>[]>(
        "GET",
        "/api/endpoints",
        "list environments",
      );
      const registries = await portainer().ok<{ Id: number; Name: string; URL: string }[]>(
        "GET",
        "/api/registries",
        "list registries",
      );
      return {
        settings: await portainer().ok("GET", "/api/settings", "read its settings"),
        users: users.map((user) => [user.Id, user.Username, user.Role]),
        endpoints: endpoints.map((item) => [
          item.Id,
          item.Name,
          item.Type,
          item.URL,
          item.UserAccessPolicies,
          item.TeamAccessPolicies,
        ]),
        registries: registries.map((item) => [item.Id, item.Name, item.URL]),
        stacks: (await stackNames()).filter((name) => !name.startsWith("opscrew-")),
      };
    }

    /** The infrastructure outputs (tunnel tokens, the Access service token), read with the engine. */
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

    /** Adds every secret OpsCrew made for the app to the scrubber (missing ones are findings). */
    async function rememberSecrets(outputNames: readonly string[]): Promise<void> {
      const home = paths().projectHomeDir;
      for (const [file, label] of [
        ["portainer-webhook", "portainer-webhook"],
        ["portainer-env.key", "portainer-value-key"],
      ] as const) {
        const path = join(home, file);
        if (existsSync(path)) scrubber.add(await readFile(path, "utf8"), label);
        else
          findings.push(`OpsCrew's ${file} file is missing, so the leak search cannot look for it`);
      }
      if (existsSync(paths().files.statePassphrase)) {
        scrubber.add(await readFile(paths().files.statePassphrase, "utf8"), "state-passphrase");
      }
      if (outputNames.length > 0) {
        const outputsNow = await infraOutputs().catch((error: unknown) => {
          findings.push(`could not read the infrastructure outputs: ${String(error)}`);
          return {} as Record<string, unknown>;
        });
        for (const name of outputNames) {
          const value = outputsNow[name];
          if (typeof value === "string" && value !== "")
            scrubber.add(value, name.replaceAll("_", "-"));
          else
            findings.push(
              `the infrastructure outputs have no ${name}, so the leak search misses it`,
            );
        }
      }
      // The values Portainer holds for the app's stack (read as its administrator, never printed).
      const stack = await stackByName(names().app);
      for (const item of (stack?.Env as { name?: string; value?: string }[] | undefined) ?? []) {
        if (item.value === undefined || item.value.length < 8) continue;
        if (/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|REDIS_URL/.test(item.name ?? "")) {
          scrubber.add(item.value, `stack-env-${item.name}`);
        }
      }
    }

    /** OpsCrew's record of what it created in Portainer (`.opscrew/server.json` → `portainer.created`). */
    async function createdRecord(): Promise<{
      stacks: { id: number; name: string; role: string }[];
      registryId?: number;
      volumes: string[];
    }> {
      const local = JSON.parse(await readFile(join(paths().stateDir, "server.json"), "utf8")) as {
        portainer?: {
          created?: {
            stacks?: { id: number; name: string; role: string }[];
            registryId?: number;
            volumes?: string[];
          };
        };
      };
      const created = local.portainer?.created ?? {};
      return {
        stacks: created.stacks ?? [],
        ...(created.registryId === undefined ? {} : { registryId: created.registryId }),
        volumes: created.volumes ?? [],
      };
    }

    /**
     * Merges a change from its own pull request and waits for its deploy run. On `success` it
     * measures how long the new version took to be live after the workflow wrote it to the deploy
     * branch (quickstart 3: within 5 minutes, with nobody calling Portainer).
     */
    async function mergeChange(
      title: string,
      files: Record<string, string>,
      expected: "success" | "failure",
    ): Promise<{ runId: number; image?: DeployedImage }> {
      await git("fetch", "-q", "origin");
      await git("checkout", "-q", "-B", "main", "origin/main");
      const branch = `e2e/${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}-${runId}`;
      await git("checkout", "-q", "-b", branch);
      for (const [path, content] of Object.entries(files)) {
        await writeFile(join(repo, path), content);
        await git("add", path);
      }
      await git("commit", "-q", "-m", title);
      await git("push", "-q", "-u", "origin", branch);
      const opened = await github.call("POST", `/repos/${E2E.githubRepo}/pulls`, {
        title,
        head: branch,
        base: "main",
        body: "Opened by the OpsCrew Portainer live test.",
      });
      const number = (opened.json as { number?: number } | undefined)?.number;
      if (opened.status !== 201 || number === undefined) {
        throw new Error(`GitHub did not open the pull request "${title}" (HTTP ${opened.status}).`);
      }
      const headBefore = await branchHead(github, DEPLOY_BRANCH);
      log(`merging "${title}" (#${number}) and waiting for its deploy run (up to 30 minutes)`);
      const sha = await github.merge(number);
      await git("fetch", "-q", "origin");
      await git("checkout", "-q", "-B", "main", "origin/main");
      const watch =
        expected === "success" ? watchSelfDeploy(headBefore, title) : Promise.resolve(undefined);
      const [run, image] = await Promise.all([github.waitForDeploy({ headSha: sha }), watch]);
      expect(
        run.conclusion,
        `the deploy run ${run.id} of "${title}": ${run.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}`,
      ).toBe(expected);
      return { runId: run.id, ...(image === undefined ? {} : { image }) };
    }

    /**
     * Waits for the deploy workflow to write a new version to the deploy branch, then for the site
     * to answer with it, and checks the time between the two against SELF_DEPLOY_TARGET_MS.
     */
    async function watchSelfDeploy(
      headBefore: string | undefined,
      what: string,
    ): Promise<DeployedImage> {
      const written = await waitFor(
        `the deploy workflow writing "${what}" to ${DEPLOY_BRANCH}`,
        minutes(30),
        async () => {
          const head = await branchHead(github, DEPLOY_BRANCH);
          return head !== undefined && head !== headBefore ? Date.now() : undefined;
        },
        10_000,
      );
      const image = await deployBranchImage();
      await waitFor(
        `the site answering with the version of "${what}"`,
        minutes(15),
        async () => ((await siteVersion()) === image.version ? true : undefined),
        5_000,
      );
      const took = Date.now() - written;
      if (took >= SELF_DEPLOY_TARGET_MS) {
        findings.push(
          `"${what}" was live ${duration(took)} after the workflow wrote it to ${DEPLOY_BRANCH}, not within ${duration(SELF_DEPLOY_TARGET_MS)} (quickstart 3)`,
        );
      }
      observe(
        `"${what}" was live ${duration(took)} after the deploy workflow wrote it (${web} mode)`,
      );
      return image;
    }

    /** Starts the SSH tunnel that makes Portainer reachable at https://localhost:9443 here. */
    async function openTunnel(): Promise<void> {
      if (await canConnect("127.0.0.1", PORTAINER_PORT, 2_000)) {
        throw new Error(
          `Port ${PORTAINER_PORT} on this computer is already in use; the loopback step needs it for the SSH tunnel to Portainer.`,
        );
      }
      let stderr = "";
      let exited: string | undefined;
      tunnel = spawn(
        "ssh",
        [
          "-i",
          keyFile,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${knownHostsFile}`,
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=15",
          "-N",
          "-L",
          `127.0.0.1:${PORTAINER_PORT}:127.0.0.1:${PORTAINER_PORT}`,
          `root@${ipv4()}`,
        ],
        { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] },
      );
      tunnel.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      tunnel.once("exit", (code, signal) => {
        exited = `exit ${code ?? signal}`;
      });
      await waitFor(
        () =>
          `Portainer through the SSH tunnel (ssh said: ${stderr.trim().slice(-300) || "nothing"})`,
        minutes(2),
        async () => {
          const seen = await inspectCertificate(`https://localhost:${PORTAINER_PORT}`);
          return sameCertFingerprint(seen.fingerprint, fingerprint) ? true : undefined;
        },
        3_000,
        () =>
          exited === undefined
            ? undefined
            : `The SSH tunnel ended (${exited}): ${stderr.trim().slice(-300)}`,
      );
    }

    function closeTunnel(): void {
      tunnel?.kill();
      tunnel = undefined;
    }

    /** The updater container's environment line that holds the webhook URL (never printed). */
    async function updaterWebhookLine(): Promise<string> {
      const lines = await shell().ok(
        `docker ps -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().updater} | head -n 1 | xargs -r docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}'`,
      );
      return lines.split("\n").find((line) => line.startsWith("PORTAINER_WEBHOOK_URL=")) ?? "";
    }

    /**
     * Watches the updater for `seconds`: none of its calls may fail and the app's containers must
     * stay as they are (the deploy branch does not change meanwhile: research R5).
     */
    async function watchUpdater(what: string, seconds = 150): Promise<void> {
      const since = await shell().ok("date +%s");
      const before = await appContainers();
      const marksBefore = await stackMarks();
      log(`watching the updater for ${seconds} seconds (${what})`);
      await sleep(seconds * 1000);
      const logs = await shell().ok(
        `docker ps -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().updater} | head -n 1 | xargs -r -I{} docker logs --since ${since} {} 2>&1`,
      );
      const failures = updaterFailures(logs);
      if (failures > 0)
        findings.push(`${what}: ${failures} of the updater's calls to Portainer failed`);
      else observe(`${what}: every call of the updater to Portainer succeeded for ${seconds} s`);
      const after = await appContainers();
      const marks = changedKeys(marksBefore, await stackMarks());
      if (after !== before) {
        findings.push(
          `${what}: the app's containers were recreated although the deploy branch did not change (R5)`,
        );
      } else if (marks.length > 0) {
        findings.push(
          `${what}: Portainer redeployed the app's stack although the deploy branch did not change (R5; changed: ${marks.join(", ")})`,
        );
      } else {
        observe(
          `${what}: the updater's calls on an unchanged branch did not redeploy the app (R5)`,
        );
      }
    }

    // -------------------------------------------------------------------------------------------

    step(
      `1. creates a throwaway server with Portainer CE ${PORTAINER_VERSION}, an admin, a limited user and the decoys`,
      minutes(40),
      async () => {
        expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
        shortHost = shortHostName(E2E.shortHost);
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

        const info = await repoInfo(github);
        repoPrivate = info.private;
        owner = info.owner;
        ownerType = info.ownerType;
        if (repoPrivate && E2E.repoReadToken === undefined) {
          throw new Error(
            "The throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN (docs/e2e.md).",
          );
        }

        work = await mkdtemp(join(tmpdir(), "opscrew-e2e-portainer-"));
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
          CLOUDFLARE_API_TOKEN: E2E.cloudflareTunnelToken ?? E2E.cloudflareToken,
          OPSCREW_APP_ENV_FILE: join(work, "production.env"),
          OPSCREW_GHCR_READ_TOKEN: E2E.ghcrToken,
          ...(repoPrivate ? { OPSCREW_REPO_READ_TOKEN: E2E.repoReadToken } : {}),
        };
        // OpsCrew never gets a cloud token or an SSH agent here: the Portainer is the user's own.
        for (const name of [
          "HCLOUD_TOKEN",
          "DIGITALOCEAN_TOKEN",
          "DIGITALOCEAN_ACCESS_TOKEN",
          "SSH_AUTH_SOCK",
          "PORTAINER_API_KEY",
          ...(repoPrivate ? [] : ["OPSCREW_REPO_READ_TOKEN"]),
        ]) {
          delete env[name];
        }
        for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];

        const keygen = await runner.run(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-${runId}`, "-f", keyFile],
          { env, timeoutMs: 60_000 },
        );
        if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
        scrubber.add(await readFile(keyFile, "utf8"), "test-private-key");
        const publicKey = (await readFile(`${keyFile}.pub`, "utf8")).trim();

        log(`pushing examples/${E2E.app} to the throwaway repository`);
        await materializeFixture(example, repo);
        const appEnv = E2E.appEnvFile ? await readFile(E2E.appEnvFile, "utf8") : "";
        await writeFile(join(work, "production.env"), appEnv);
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
        await git("commit", "-q", "-m", `e2e: examples/${E2E.app} in your Portainer`);
        await git("push", "-q", "--force", "origin", "main");
        await github.reset();
        repoReady = true;

        const testIpv4 = ipv4FromTrace(await traceText());
        if (testIpv4 === undefined)
          throw new Error("Could not read this computer's public IPv4 address.");
        scrubber.add(testIpv4, "test-computer-ipv4");

        hetznerTouched = true;
        server = await createPortainerServer({
          token: E2E.hcloudToken,
          runId,
          publicKey,
          locations,
          ...(E2E.serverType === undefined ? {} : { forcedType: E2E.serverType }),
          testIpv4,
          onFirewall: (id) => {
            firewallId = id;
          },
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
        root = new RootShell(runner, { host: ipv4(), keyFile, knownHostsFile, env });
        await waitFor(
          "root logging in with the test key",
          minutes(3),
          async () => ((await shell().run("true", 30_000)).exitCode === 0 ? true : undefined),
          5_000,
        );
        expect(
          fingerprintFromKeygen(
            await shell().ok("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"),
          ),
          "the host key on the server matches the scanned key",
        ).toBe(sshFingerprint(hostKey));
        const cloudInit = await shell().run("cloud-init status --wait", minutes(15));
        if (![0, 2].includes(cloudInit.exitCode)) {
          throw new Error(`cloud-init did not finish (exit ${cloudInit.exitCode}).`);
        }

        log("installing Docker with get.docker.com (up to 10 minutes)");
        await shell().ok(
          "curl -fsSL https://get.docker.com -o /root/get-docker.sh && sh /root/get-docker.sh > /root/get-docker.log 2>&1",
          minutes(10),
        );
        observe(
          `Docker ${await shell().ok("docker version --format '{{.Server.Version}}'")} on the Portainer host`,
        );

        // The user's own Compose project, started outside Portainer.
        await shell().ok(
          [
            "mkdir -p /root/e2e-decoy && cat > /root/e2e-decoy/compose.yaml <<'EOF'",
            `name: ${DECOY_PROJECT}`,
            "services:",
            "  sleeper:",
            `    image: ${BUSYBOX_IMAGE}`,
            '    command: ["sh", "-c", "echo decoy > /data/marker; while true; do sleep 3600; done"]',
            "    restart: unless-stopped",
            "    volumes: [decoy_data:/data]",
            "volumes:",
            "  decoy_data: {}",
            "EOF",
            "docker compose -f /root/e2e-decoy/compose.yaml up -d --quiet-pull",
          ].join("\n"),
          minutes(5),
        );

        log(`starting Portainer CE ${PORTAINER_VERSION}`);
        await shell().ok(
          `docker volume create portainer_data >/dev/null && docker run -d --name portainer --restart=always -p ${PORTAINER_PORT}:${PORTAINER_PORT} -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data ${PORTAINER_IMAGE} >/dev/null`,
          minutes(5),
        );
        portainerUrl = `https://${ipv4()}:${PORTAINER_PORT}`;
        scrubber.add(portainerUrl, "portainer-address");
        scrubber.add(`${ipv4()}:${PORTAINER_PORT}`, "portainer-address");
        const seen = await waitFor(
          "Portainer's certificate from this computer (the firewall lets only this computer in)",
          minutes(3),
          async () => inspectCertificate(portainerUrl),
          5_000,
        );
        fingerprint = seen.fingerprint;
        // As the user guide says: read the fingerprint on the Portainer host with openssl.
        const openssl = opensslFingerprint(
          await shell().ok(
            `openssl s_client -connect localhost:${PORTAINER_PORT} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`,
          ),
        );
        expect(openssl, "the guide's openssl command prints a fingerprint").toBeDefined();
        expect(
          sameCertFingerprint(openssl as string, fingerprint),
          "the guide's openssl command shows the fingerprint OpsCrew reads",
        ).toBe(true);
        observe(
          "the user guide's openssl command on the Portainer host shows the same fingerprint OpsCrew reads",
        );

        // Admin initialisation needs the setup token Portainer prints once (research R10).
        const anonymous = new PortainerApi(portainerUrl, fingerprint);
        const setupToken = await waitFor(
          "Portainer's setup token in `docker logs portainer`",
          minutes(1),
          async () => setupTokenFromLogs(await shell().ok("docker logs portainer 2>&1")),
          3_000,
        ).catch(async (error: unknown) => {
          const lines = (await shell().ok("docker logs portainer 2>&1"))
            .split("\n")
            .filter((line) => /setup|token/i.test(line))
            .map(logLineShape);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} Lines that mention it: ${lines.join(" | ") || "none"}.`,
          );
        });
        scrubber.add(setupToken, "portainer-setup-token");
        const adminPassword = randomBytes(24).toString("base64url");
        scrubber.add(adminPassword, "portainer-admin-password");
        // The answer includes the admin's password hash: it is never logged.
        const init = await anonymous.call("POST", "/api/users/admin/init", {
          json: { Username: ADMIN_USER, Password: adminPassword },
          headers: { "X-Setup-Token": setupToken },
        });
        if (init.status !== 200)
          throw new Error(`Portainer refused the admin initialisation (HTTP ${init.status}).`);
        const login = async (username: string, password: string) => {
          const auth = await anonymous.ok<{ jwt?: string }>("POST", "/api/auth", "log in", {
            json: { Username: username, Password: password },
          });
          if (!auth.jwt) throw new Error("Portainer's login answered without a session.");
          scrubber.add(auth.jwt, "portainer-session");
          return auth.jwt;
        };
        const session = anonymous.withSession(await login(ADMIN_USER, adminPassword));

        // A fresh install has no environment: the local Docker host is added (research R10).
        const created = await session.ok<{ Id: number }>(
          "POST",
          "/api/endpoints",
          "add the local environment",
          {
            form: multipartForm({ Name: ENVIRONMENT_NAME, EndpointCreationType: "1" }),
          },
        );
        environmentId = created.Id;
        await waitFor(
          "the local environment's first snapshot",
          minutes(2),
          async () => {
            const environment = await session.ok<{ Snapshots?: unknown[] }>(
              "GET",
              `/api/endpoints/${environmentId}`,
              "read the environment",
            );
            return (environment.Snapshots ?? []).length > 0 ? true : undefined;
          },
          5_000,
        );

        const me = await session.ok<{ Id: number }>("GET", "/api/users/me", "read the admin");
        const adminKey = await session.ok<{ rawAPIKey?: string }>(
          "POST",
          `/api/users/${me.Id}/tokens`,
          "create the admin's token",
          {
            json: { description: "opscrew-e2e admin", password: adminPassword },
          },
        );
        if (!adminKey.rawAPIKey)
          throw new Error("Portainer created the admin's token without returning it.");
        adminToken = adminKey.rawAPIKey;
        scrubber.add(adminToken, "PORTAINER_API_KEY");
        admin = anonymous.withToken(adminToken);
        const version = await portainer().ok<{
          ServerVersion?: string;
          Dependencies?: { ComposeVersion?: string };
        }>("GET", "/api/system/version", "read its version");
        observe(
          `Portainer ${version.ServerVersion ?? "?"} with Compose ${version.Dependencies?.ComposeVersion ?? "?"}`,
        );

        // A limited user (role 2) the administrator gave access to the environment, and its token.
        const limitedPassword = randomBytes(24).toString("base64url");
        scrubber.add(limitedPassword, "portainer-limited-password");
        const limited = await portainer().ok<{ Id: number }>(
          "POST",
          "/api/users",
          "create the limited user",
          {
            json: { Username: LIMITED_USER, Password: limitedPassword, Role: 2 },
          },
        );
        limitedUserId = limited.Id;
        await portainer().ok(
          "PUT",
          `/api/endpoints/${environmentId}`,
          "give the limited user the environment",
          {
            json: { UserAccessPolicies: { [String(limitedUserId)]: { RoleId: 0 } } },
          },
        );
        const limitedSession = anonymous.withSession(await login(LIMITED_USER, limitedPassword));
        const limitedKey = await limitedSession.ok<{ rawAPIKey?: string }>(
          "POST",
          `/api/users/${limitedUserId}/tokens`,
          "create the limited user's token",
          { json: { description: "opscrew-e2e limited", password: limitedPassword } },
        );
        if (!limitedKey.rawAPIKey)
          throw new Error("Portainer created the limited token without returning it.");
        limitedToken = limitedKey.rawAPIKey;
        scrubber.add(limitedToken, "PORTAINER_API_KEY (limited)");
        const visible = await anonymous
          .withToken(limitedToken)
          .ok<{ Id: number }[]>(
            "GET",
            "/api/endpoints",
            "list environments with the limited token",
          );
        expect(
          visible.map((item) => item.Id),
          "the limited token sees the environment",
        ).toContain(environmentId);

        // The user's own Portainer stack.
        const decoy = await portainer().ok<{ Id: number }>(
          "POST",
          `/api/stacks/create/standalone/string?endpointId=${environmentId}`,
          "create the decoy stack",
          {
            json: {
              Name: DECOY_STACK,
              StackFileContent: [
                "services:",
                "  sleeper:",
                `    image: ${BUSYBOX_IMAGE}`,
                '    command: ["sh", "-c", "while true; do sleep 3600; done"]',
                "    restart: unless-stopped",
                "    environment:",
                "      DECOY_VALUE: ${DECOY_VALUE}",
                "    volumes: [decoy_stack_data:/data]",
                "volumes:",
                "  decoy_stack_data: {}",
                "",
              ].join("\n"),
              Env: [{ name: "DECOY_VALUE", value: "the user's own value" }],
            },
            timeoutMs: minutes(5),
          },
        );
        decoyStackId = decoy.Id;
        await waitFor(
          "the decoy stack running",
          minutes(3),
          async () => {
            const stack = await portainer().ok<{ Status?: number }>(
              "GET",
              `/api/stacks/${decoyStackId}`,
              "read the decoy stack",
            );
            return stack.Status === 1 ? true : undefined;
          },
          5_000,
        );

        await probePortainer();

        decoysBefore = await decoys();
        portainerBefore = await portainerState();
        log("Portainer is set up as the user's: admin, limited user, local environment, decoys");
      },
    );

    /**
     * What the adapter assumes about Portainer itself, observed with a short-lived stack of the
     * test's own: whether a bare `NAME:` entry stays unset when the stack has no value for it (and
     * whether a bare entry takes a value from the stack's Env), and whether stopping a stack
     * removes its containers. Every result goes to the run log; none of them stops the run.
     */
    async function probePortainer(): Promise<void> {
      const probe = await portainer().ok<{ Id: number }>(
        "POST",
        `/api/stacks/create/standalone/string?endpointId=${environmentId}`,
        "create the probe stack",
        {
          json: {
            Name: PROBE_STACK,
            StackFileContent: [
              "services:",
              "  probe:",
              `    image: ${BUSYBOX_IMAGE}`,
              '    command: ["sh", "-c", "while true; do sleep 3600; done"]',
              "    environment:",
              "      PROBE_BARE_UNSET:",
              "      PROBE_BARE_SET:",
              "      PROBE_REFERENCED: ${PROBE_REFERENCED_UNSET}",
              "",
            ].join("\n"),
            Env: [{ name: "PROBE_BARE_SET", value: "from the stack's Env" }],
          },
          timeoutMs: minutes(5),
        },
      );
      const containers = () =>
        shell().ok(`docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${PROBE_STACK}`);
      try {
        const id = await waitFor(
          "the probe stack's container",
          minutes(3),
          async () => {
            const found = (await containers()).split("\n")[0]?.trim();
            return found ? found : undefined;
          },
          5_000,
        );
        const seen = envNames(
          await shell().ok(`docker inspect -f '{{json .Config.Env}}' ${id}`),
          "PROBE_",
        );
        const state = (name: string) => {
          const item = seen.find((entry) => entry.name === name);
          return item === undefined
            ? "unset"
            : item.empty
              ? "set to an empty value"
              : "set to a value";
        };
        observe(
          `a bare NAME: entry the stack has no value for is ${state("PROBE_BARE_UNSET")} in the container`,
        );
        observe(
          `a bare NAME: entry the stack's Env has a value for is ${state("PROBE_BARE_SET")} in the container`,
        );
        observe(
          `\${NAME} with no value in the stack's Env is ${state("PROBE_REFERENCED")} in the container`,
        );
        await portainer().ok(
          "POST",
          `/api/stacks/${probe.Id}/stop?endpointId=${environmentId}`,
          "stop the probe stack",
          {
            timeoutMs: minutes(3),
          },
        );
        const removed = await waitFor(
          "the probe stack stopped",
          minutes(2),
          async () => {
            const left = await containers();
            const stack = await portainer().ok<{ Status?: number }>(
              "GET",
              `/api/stacks/${probe.Id}`,
              "read the probe stack",
            );
            return stack.Status === 2 ? left === "" : undefined;
          },
          5_000,
        ).catch(() => undefined);
        observe(
          removed === undefined
            ? "stopping a stack: Portainer did not report it stopped within 2 minutes"
            : removed
              ? "stopping a stack removes its containers"
              : "stopping a stack keeps its containers (stopped)",
        );
      } finally {
        await portainer().call("DELETE", `/api/stacks/${probe.Id}?endpointId=${environmentId}`, {
          timeoutMs: minutes(3),
        });
      }
    }

    step(
      "1b. (optional) pauses so the guide's browser and Portainer UI steps can be checked by hand",
      minutes(Math.max(1, E2E.manualMinutes) + 5),
      async () => {
        if (E2E.manualMinutes <= 0) {
          log(
            "OPSCREW_E2E_PORTAINER_MANUAL_MINUTES is not set: the browser and UI steps of the guide stay unchecked by hand",
          );
          return;
        }
        // Written only on this computer (the run's temporary folder, deleted at the end), never printed.
        const file = join(work, "manual-check.txt");
        await writeFile(
          file,
          [
            `Portainer: ${portainerUrl} (only this computer may reach it)`,
            `Admin: ${ADMIN_USER} / ${scrubber.entries().find((e) => e.label === "portainer-admin-password")?.value ?? ""}`,
            `The fingerprint OpsCrew pins: ${fingerprint}`,
            "Check in a browser: the padlock shows this SHA-256 fingerprint; Registries → Add registry → Custom registry",
            "has the fields the guide names; the environment's Registries page has Manage access.",
            "Look only: do not save, add or change anything in Portainer (the run compares it with how it was).",
            "Delete this file to continue.",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        log(
          `the address and login are in ${file}; delete it to continue (waiting up to ${E2E.manualMinutes} minutes)`,
        );
        await waitFor(
          "the manual check (delete the file to continue)",
          minutes(E2E.manualMinutes),
          async () => (existsSync(file) ? undefined : true),
          5_000,
        ).catch(async () => {
          await rm(file, { force: true });
          log("the manual check timed out; continuing");
        });
        // A look in the UI may have touched something (a login, a setting): compare from here on.
        decoysBefore = await decoys();
        portainerBefore = await portainerState();
      },
    );

    step(
      "2. updater + tunnel: init, interview, design, adapt, the limited token's registry steps, three provision runs, deploy, verify, secure, drift",
      minutes(90),
      async () => {
        const first = await opscrew("init", "--fix");
        const failedBefore = failedInitChecks(first.output);
        if (![0, 1].includes(first.exitCode)) {
          throw new Error(
            `opscrew init failed before the interview (exit ${first.exitCode}):\n${tail(first.output)}`,
          );
        }
        if (failedBefore.length > 0)
          log(`init before the interview: failed checks ${failedBefore.join(", ")}`);
        if ((await git("status", "--porcelain", "--", ".gitignore")) !== "") {
          await git("add", ".gitignore");
          await git("commit", "-q", "-m", "chore: ignore OpsCrew's local files");
          await git("push", "-q", "origin", "main");
        }
        await opscrewOk("analyze", "--no-ai");
        env.PORTAINER_API_KEY = adminToken;
        await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "tunnel" });
        const requirements = await readFile(paths().files.requirements, "utf8");
        expect(
          leakedLabels(requirements, scrubber.entries()),
          "requirements.yaml holds no address or secret",
        ).toEqual([]);
        const init = await opscrew("init");
        const failedAfter = failedInitChecks(init.output);
        if (init.exitCode !== 0 || failedAfter.length > 0) {
          findings.push(
            `opscrew init after the Portainer interview exited with ${init.exitCode}${failedAfter.length > 0 ? `; failed checks: ${failedAfter.join(", ")}` : ""}`,
          );
        }
        const plan = await readPlan();
        appName = plan.app.name;
        expect(plan.target, "the environment's architecture").toMatchObject({ arch: "amd64" });

        zone = await cloudflare.zoneOf(appHost);
        if (appHost !== `${appHost.split(".")[0]}.${zone.name}`) {
          throw new Error(
            `${appHost} is not directly below the Cloudflare zone ${zone.name}. Set OPSCREW_E2E_DOMAIN to a hostname one level below the zone (or the zone itself).`,
          );
        }
        log(`this run serves the app on its own hostname ${appHost}`);
        hostnames = [appHost, `www.${appHost}`, `portainer-${app()}.${zone.name}`];
        cloudflareBefore = await portainerAppResources(cloudflare, zone, app(), hostnames);
        // The rules of the zone's rulesets before the run: compared after destroy and in cleanup.
        for (const ruleset of cloudflareBefore.rulesets ?? []) {
          rulesetsBefore.set(ruleset.id, {
            name: ruleset.name,
            rules: await rulesetRules(cloudflare, zone, ruleset.id).catch(() => undefined),
          });
        }

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
        await github.merge(adaptPull);
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");

        await limitedTokenRegistrySteps();

        const runs = await threeRuns("updater + tunnel, first setup", true);

        // The deploy branch OpsCrew created with the real fine-grained token (createOrphanBranch).
        await expectPlaceholderBranch("the first setup");
        observe(
          "createOrphanBranch with the fine-grained token (Contents: write) made a root commit holding only compose.yaml",
        );

        const record = await createdRecord();
        expect(
          record.stacks.map((stack) => stack.role).sort(),
          "OpsCrew recorded the app and the updater",
        ).toEqual(["app", "updater"]);
        expect(
          record.registryId,
          "with an admin token OpsCrew added the registry entry",
        ).toBeDefined();
        registryId = record.registryId;
        recordedVolumes = record.volumes;
        await rememberSecrets(["tunnel_token"]);
        if (runs.stackHash !== undefined) {
          const saved = planFiles.get(`stack-${runs.stackHash}.json`);
          expect(saved, "the approved stack plan is saved in .opscrew/plans").toBeDefined();
        }

        // What Portainer returns for the app's Git stack (shapes only, never values).
        const stack = await stackByName(names().app);
        expect(stack, "Portainer has the app's stack").toBeDefined();
        const gitConfig = stack?.GitConfig as { ReferenceName?: string } | null | undefined;
        observe(
          gitConfig
            ? `GET /api/stacks/{id} returns GitConfig ${valueShape(gitConfig)}`
            : "GET /api/stacks/{id} returns no GitConfig",
        );
        expect(gitConfig?.ReferenceName, "the app stack follows the deploy branch").toBe(
          DEPLOY_REFERENCE,
        );
        const autoUpdate = stack?.AutoUpdate as
          | { Webhook?: string; ForcePullImage?: boolean }
          | undefined;
        const webhookId = (
          await readFile(join(paths().projectHomeDir, "portainer-webhook"), "utf8")
        ).trim();
        expect(
          autoUpdate?.Webhook === webhookId,
          "the stack's webhook is the one OpsCrew keeps",
        ).toBe(true);
        expect(autoUpdate?.ForcePullImage, "AutoUpdate.ForcePullImage").toBe(false);
        observe(
          `AutoUpdate ${valueShape(autoUpdate)}; DeploymentStatus ${valueShape(stack?.DeploymentStatus)}`,
        );

        await deploy("the first deploy, updater + tunnel");
        web = "tunnel";
        const image = await deployBranchImage();
        await waitForSite(image.version);
        const file = await portainer().ok<{ StackFileContent?: string }>(
          "GET",
          `/api/stacks/${stack?.Id}/file`,
          "read the app stack's file",
        );
        const served = file.StackFileContent?.includes(image.digest) === true;
        if (!served)
          findings.push("GET /api/stacks/{id}/file did not return the Git stack's deployed file");
        else
          observe(
            "GET /api/stacks/{id}/file returns the Git stack's deployed file (with the new image)",
          );

        const volumes = (
          await shell().ok(
            `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().app}`,
          )
        )
          .split("\n")
          .filter(Boolean);
        recordedVolumes = (await createdRecord()).volumes;
        observe(
          `the app's volumes carry ${COMPOSE_PROJECT_LABEL} (${volumes.length} found, ${recordedVolumes.length} recorded)`,
        );
        for (const volume of recordedVolumes) {
          expect(volumes, `the recorded volume ${volume} carries the project label`).toContain(
            volume,
          );
        }

        await ghcrFacts(image);

        await opscrewOk("verify");
        const secure = await opscrewOk("secure");
        expect(secure.output.includes("SECURITY_REPORT.md"), "secure wrote its report").toBe(true);
        await opscrewOk("drift");
        observe("drift's git fetch of the deploy branch worked against the real GitHub remote");
        const again = await opscrewOk("provision", "--plan-only", "--yes");
        expect(
          approveHashes(again.output),
          `a re-run plans nothing:\n${tail(again.output)}`,
        ).toEqual([]);
        expect(again.output, "a re-run says nothing is to apply").toMatch(/Nothing to apply/);
        await expectDecoysUnchanged("the first setup");
      },
    );

    /**
     * FR-1018 with the limited user's token: a private image and no usable ghcr.io entry stop
     * provision before any change with the registry steps; after the user guide's step 1 (as the
     * administrator: a Custom registry for ghcr.io, granted to the user on the environment) the
     * same token gets past that check. The entry is removed again before the admin flow.
     */
    async function limitedTokenRegistrySteps(): Promise<void> {
      const limitedEnv = { PORTAINER_API_KEY: limitedToken };
      const stacksBefore = await stackNames();
      const refused = await opscrewWith(limitedEnv, "provision", "--plan-only", "--yes");
      if (refused.exitCode === 0 || !refused.output.includes("no ghcr.io registry entry")) {
        findings.push(
          `with the limited token and a private image, provision --plan-only exited with ${refused.exitCode} without the registry steps (FR-1018)`,
        );
      } else {
        observe(
          "limited token, private image, no registry entry: provision stopped before any change with the registry steps (FR-1018)",
        );
      }
      expect(await stackNames(), "the refused run changed nothing in Portainer").toEqual(
        stacksBefore,
      );
      const entry = await portainer().ok<{ Id: number }>(
        "POST",
        "/api/registries",
        "add the guide's registry entry",
        {
          json: {
            Name: "ghcr-e2e",
            Type: 3,
            URL: "ghcr.io",
            BaseURL: "",
            Authentication: true,
            Username: owner,
            Password: E2E.ghcrToken,
          },
        },
      );
      try {
        await portainer().ok(
          "PUT",
          `/api/endpoints/${environmentId}/registries/${entry.Id}`,
          "let the limited user use the entry",
          {
            json: {
              UserAccessPolicies: { [String(limitedUserId)]: { RoleId: 0 } },
              TeamAccessPolicies: {},
              Namespaces: [],
            },
          },
        );
        const passed = await opscrewWith(limitedEnv, "provision", "--plan-only", "--yes");
        if (passed.exitCode !== 0) {
          findings.push(
            `after the guide's registry steps, provision --plan-only with the limited token still exited with ${passed.exitCode}`,
          );
        } else {
          observe(
            "after the guide's registry steps (done through the API), the limited token plans the deploy",
          );
        }
      } finally {
        await portainer().call("DELETE", `/api/registries/${entry.Id}`);
      }
    }

    /**
     * GHCR's answers for the registry entry's login: the GitHub owner as the user name (what OpsCrew
     * sends), another user name, and a wrong token. Recorded only; a refused owner is a finding.
     */
    async function ghcrFacts(image: DeployedImage): Promise<void> {
      const repository = image.repository.replace(/^ghcr\.io\//, "");
      const name = repository.split("/").slice(1).join("/");
      const visibility = await packageVisibility(E2E.ghcrToken, owner, ownerType, name).catch(
        () => undefined,
      );
      const asOwner = await ghcrPullStatus(repository, owner, E2E.ghcrToken);
      const asOther = await ghcrPullStatus(repository, "opscrew-e2e-any-user", E2E.ghcrToken);
      const wrong = await ghcrPullStatus(repository, owner, `not-a-token-${randomUUID()}`);
      observe(
        `GHCR (${visibility ?? "visibility unknown"} package): the owner as user name → HTTP ${asOwner}, another user name → HTTP ${asOther}, a wrong token → HTTP ${wrong}`,
      );
      if (asOwner !== 200)
        findings.push(`GHCR refused the GitHub owner as the registry user name (HTTP ${asOwner})`);
      if (visibility === "public")
        observe("the package is public, so the registry user name checks are inconclusive");
    }

    step(
      PASS === "full"
        ? "3. a merged change deploys by itself within 5 minutes; a failing change rolls back"
        : `3. a merged change deploys by itself within 5 minutes (the failing change's rollback: ${NOT_IN_CORE})`,
      minutes(90),
      async () => {
        // Research R5: a webhook call for an unchanged branch does not redeploy.
        const webhookId = (
          await readFile(join(paths().projectHomeDir, "portainer-webhook"), "utf8")
        ).trim();
        const before = await appContainers();
        const marksBefore = await stackMarks();
        const code = await shell().ok(
          `curl -sk -o /dev/null -w '%{http_code}' -X POST https://127.0.0.1:${PORTAINER_PORT}/api/stacks/webhooks/${webhookId}`,
        );
        observe(`a webhook call for the unchanged branch answered HTTP ${code}`);
        await watchUpdater("updater + tunnel, unchanged branch", 120);
        const marks = changedKeys(marksBefore, await stackMarks());
        if ((await appContainers()) === before && marks.length === 0) {
          observe(
            "R5 confirmed: neither a direct webhook call nor the updater redeployed an unchanged branch (containers, UpdateDate, UpdatedBy, DeploymentStatus count and ConfigHash unchanged)",
          );
        } else {
          findings.push(
            `R5: a webhook call for an unchanged branch redeployed the app's stack (${marks.length > 0 ? `changed: ${marks.join(", ")}` : "its containers were recreated"}; the updater must compare the branch head first)`,
          );
        }

        const good = await mergeChange(
          "e2e: a change that deploys by itself",
          { "opscrew-e2e-change.txt": `Deployed by itself in run ${runId}.\n` },
          "success",
        );
        const goodImage = good.image as DeployedImage;

        if (!inPass(PASS, "3-rollback")) {
          // The failing change waits about 10 minutes for its health check before it rolls back.
          log(`the deliberately failing change and its rollback are skipped: ${NOT_IN_CORE}`);
          await expectDecoysUnchanged("the self-deploy");
          return;
        }
        const plan = await readPlan();
        const dockerfile = plan.app.dockerfile;
        const original = await readFile(join(repo, dockerfile), "utf8");
        const failing = await mergeChange(
          "e2e: a deliberately failing change",
          { [dockerfile]: failingDockerfile(original) },
          "failure",
        );
        const steps = await runSteps(github, failing.runId);
        const waited = steps.find((item) => item.step === "Wait until the new version answers");
        expect(waited?.conclusion, "the failing version did not answer").toBe("failure");
        const rollback = steps.find((item) => item.step === "Roll back to the previous version");
        // The rollback step always fails the job by design; its error line says what it did.
        expect(
          rollback?.conclusion === "success" || rollback?.conclusion === "failure",
          `the rollback step ran (conclusion ${String(rollback?.conclusion)})`,
        ).toBe(true);
        // Only the job log's `##[error]` messages are read; the log itself is never printed.
        const outcome = rollbackOutcome(
          await jobErrors(github, failing.runId, "Deploy to Portainer"),
        );
        if (!outcome.ok) throw new Error(scrub(outcome.message));
        observe(`the rollback reported: ${outcome.message}`);
        const head = await branchHead(github, DEPLOY_BRANCH);
        const restored = await commitDetails(github, head as string);
        expect(
          restored.subject,
          `the ${DEPLOY_BRANCH} branch's newest commit is the rollback`,
        ).toBe("Roll back to the previous version");
        expect(
          (await deployBranchImage()).digest,
          "the rollback wrote the previous image back",
        ).toBe(goodImage.digest);
        await waitForSite(goodImage.version, minutes(10));
        const stack = await stackByName(names().app);
        observe(
          `after the rollback the app stack has Status ${String(stack?.Status)}; DeploymentStatus ${valueShape(stack?.DeploymentStatus)}`,
        );
        observe("a deliberately failing change rolled back to the previous version");

        // The revert also changes a file, so its image differs from the one before the failure.
        await mergeChange(
          "e2e: revert the failing change",
          {
            [dockerfile]: original,
            "opscrew-e2e-change.txt": `Reverted in run ${runId}.\n`,
          },
          "success",
        );
        await expectDecoysUnchanged("the self-deploy and the rollback");
      },
    );

    /** Whether OpsCrew's registry entry is granted to the environment (`RegistryAccesses`). */
    async function registryGranted(): Promise<boolean> {
      const entry = await portainer().ok<{ RegistryAccesses?: Record<string, unknown> | null }>(
        "GET",
        `/api/registries/${registryId}`,
        "read OpsCrew's registry entry",
      );
      return Object.keys(entry.RegistryAccesses ?? {}).includes(String(environmentId));
    }

    step(
      "4. an apply through MCP: opscrew_plan and opscrew_apply replace the registry token (the entry stays granted)",
      minutes(45),
      async () => {
        const mcp = await McpSession.start({
          cli: CLI,
          cwd: repo,
          env,
          // The user's answer in the dialog: approve what this step expects, nothing that deletes.
          approve: (message) =>
            !message.includes("WARNING: this change deletes or replaces resources"),
        });
        try {
          const replaceTokens = ["registry"];
          const planned = await mcp.call("opscrew_plan", { projectDir: repo, replaceTokens });
          expect(planned.isError, `opscrew_plan:\n${tail(planned.text)}`).toBe(false);
          const stackHash = planned.data.stackPlanHash;
          expect(typeof stackHash, "opscrew_plan returns the stack plan's hash").toBe("string");
          const applied = await mcp.call("opscrew_apply", {
            projectDir: repo,
            planHash: stackHash,
            replaceTokens,
          });
          expect(applied.isError, `opscrew_apply:\n${tail(applied.text)}`).toBe(false);
          expect(
            mcp.dialogs.some(
              (dialog) => dialog.approved && dialog.message.includes(stackHash as string),
            ),
            "the stack plan was approved in its own dialog",
          ).toBe(true);
          observe(
            `opscrew_apply ran the real provision through MCP (${mcp.dialogs.length} dialog(s)) and replaced the registry token`,
          );
        } finally {
          mcpTexts.push(...mcp.transcript);
          await mcp.close();
        }
        if (await registryGranted()) {
          observe(
            "after a registry token replace through MCP the entry is still granted to the environment",
          );
        } else {
          findings.push(
            "after a registry token replace through MCP the entry is no longer granted to the environment",
          );
        }
        await deploy("the token replace through MCP");
        await waitForSite((await deployBranchImage()).version, minutes(10));
        await expectDecoysUnchanged("the apply through MCP");
      },
    );

    step(
      "5. caddy: the app stack updated in place, the DNS record OpsCrew prints, certificates on 80/443",
      minutes(75),
      async () => {
        // From here on OpsCrew uses the full Cloudflare token (removing the tunnel needs it anyway).
        env.CLOUDFLARE_API_TOKEN = E2E.cloudflareToken;
        if (E2E.cloudflareTunnelToken !== undefined) {
          observe(
            "the updater + tunnel setup (steps 2–4) worked with OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN",
          );
        }
        await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "caddy" });
        const envShape = (stack: Record<string, unknown> | undefined) =>
          JSON.stringify(
            ((stack?.Env as { name?: string }[] | undefined) ?? []).map((item) => item.name).sort(),
          );
        const stackBefore = await stackByName(names().app);
        const provisioned = await provisionUntilDone("caddy");
        expect(
          namesDnsRecord(provisioned.output, appHost),
          "provision names the DNS record to create",
        ).toBe(true);
        const plan = await readPlan();
        const z = zone as CloudflareZone;
        for (const name of plan.dns.www ? [appHost, `www.${appHost}`] : [appHost]) {
          await waitFor(`the tunnel's record on ${name} gone`, minutes(5), async () => {
            const left = await cloudflare.list<{ name: string }>(
              `/zones/${z.id}/dns_records?name=${encodeURIComponent(name)}`,
            );
            return left.length === 0 ? true : undefined;
          });
          testRecords.push(
            await createDnsRecord(cloudflare, z, { type: "A", name, content: ipv4() }),
          );
        }
        log("created the DNS record OpsCrew printed (DNS only, to the server)");
        await deploy("caddy");
        web = "caddy";
        await waitForSite((await deployBranchImage()).version, minutes(15));
        const stack = await stackByName(names().app);
        const keys = ((stack?.Env as { name?: string }[] | undefined) ?? []).map(
          (item) => item.name,
        );
        expect(keys, "the app stack no longer has the tunnel's token").not.toContain(
          "OPSCREW_TUNNEL_TOKEN",
        );
        expect(
          { Id: stack?.Id, CreationDate: stack?.CreationDate },
          "the switch kept the same app stack (not deleted and created again)",
        ).toEqual({ Id: stackBefore?.Id, CreationDate: stackBefore?.CreationDate });
        expect(
          stack?.UpdateDate !== stackBefore?.UpdateDate ||
            envShape(stack) !== envShape(stackBefore),
          "the app stack was changed by the switch (UpdateDate or its variables)",
        ).toBe(true);
        observe(
          "the app stack was updated in place (POST /api/stacks/{id}/git, then PUT …/git/redeploy)",
        );
        expect(await canConnect(ipv4(), 443), "Caddy serves 443 on the host").toBe(true);
        await opscrewOk("verify");
        await opscrewOk("drift");
        const left = await portainerAppResources(cloudflare, z, app(), hostnames);
        expect(
          left.tunnels.map((t) => t.name),
          "the app's tunnel is gone",
        ).toEqual([]);
        await expectDecoysUnchanged("the switch to caddy");
      },
    );

    step("6. proxy: the app on a host port, `verify --url <route>`", minutes(60), async () => {
      // The user points the domain at their own reverse proxy: the record to Caddy goes first, so
      // the deploy workflow's reachability probe does not find the old Caddy on 443.
      const z = zone as CloudflareZone;
      for (const id of testRecords.splice(0)) {
        await cloudflare.call("DELETE", `/zones/${z.id}/dns_records/${id}`);
      }
      await answerAndDesign({
        url: portainerUrl,
        redeploy: "updater",
        web: "proxy",
        port: PROXY_PORT,
      });
      const provisioned = await provisionUntilDone("proxy");
      expect(
        provisioned.output.includes(`port ${PROXY_PORT}`),
        "provision names the port to route to",
      ).toBe(true);
      await deploy("proxy");
      web = "proxy";
      await waitForSite((await deployBranchImage()).version, minutes(10));
      await opscrewOk("verify", "--url", `http://${ipv4()}:${PROXY_PORT}`);
      observe("verify --url with a route on the Portainer host passed");
      await opscrewOk("drift");
      await waitFor(
        "Caddy leaving ports 80 and 443",
        minutes(3),
        async () => ((await canConnect(ipv4(), 443, 3_000)) ? undefined : true),
        5_000,
      );
      await expectDecoysUnchanged("the switch to proxy");
    });

    step(
      "7. Cloudflare redeploys with the tunnel: three runs, a deploy through Access, 404 outside the webhook, a token replace",
      minutes(75),
      async () => {
        const z = zone as CloudflareZone;
        for (const id of testRecords.splice(0)) {
          await cloudflare.call("DELETE", `/zones/${z.id}/dns_records/${id}`);
        }
        await answerAndDesign({ url: portainerUrl, redeploy: "cloudflare", web: "tunnel" });
        await threeRuns("Cloudflare redeploy + tunnel", false);
        await rememberSecrets([
          "tunnel_token",
          "portainer_tunnel_token",
          "deploy_service_token_client_id",
          "deploy_service_token_client_secret",
        ]);
        const runIdDeployed = await deploy("Cloudflare redeploy + tunnel");
        web = "tunnel";
        if (runIdDeployed !== undefined) {
          const asked = (await runSteps(github, runIdDeployed)).find(
            (item) => item.step === "Ask Portainer to deploy the new version",
          );
          expect(asked?.conclusion, "the workflow asked Portainer through Access").toBe("success");
          observe(
            "the deploy workflow reached Portainer's webhook through Access (cloudflared → Portainer with no_tls_verify)",
          );
        }
        await waitForSite((await deployBranchImage()).version, minutes(10));
        const all = await stackNames();
        expect(all, "the updater stack is gone").not.toContain(names().updater);
        expect(all, "the connector stack runs").toContain(names().tunnelConnector);

        const host = `portainer-${app()}.${z.name}`;
        const refused = await waitFor(`${host} behind Cloudflare Access`, minutes(5), async () => {
          const answer = await httpsRequest(`https://${host}/api/system/status`);
          const location = String(answer.headers.location ?? "");
          return [401, 403].includes(answer.status) ||
            (answer.status >= 300 &&
              answer.status < 400 &&
              location.includes("cloudflareaccess.com"))
            ? answer.status
            : undefined;
        });
        observe(
          `Portainer's hostname refuses a request without the service token (HTTP ${refused})`,
        );
        const secret = (label: string) =>
          scrubber.entries().find((entry) => entry.label === label)?.value ?? "";
        const headers = {
          "CF-Access-Client-Id": secret("deploy-service-token-client-id"),
          "CF-Access-Client-Secret": secret("deploy-service-token-client-secret"),
        };
        for (const path of ["/", "/api/system/status", "/api/users/me"]) {
          const answer = await httpsRequest(`https://${host}${path}`, { headers });
          expect(answer.status, `${host}${path} with the service token answers 404`).toBe(404);
        }
        observe(
          "with the service token, Portainer's hostname answers 404 outside /api/stacks/webhooks/",
        );

        await opscrewOk("verify");
        await opscrewOk("secure");
        await opscrewOk("drift");
        const again = await opscrewOk("provision", "--plan-only", "--yes");
        expect(approveHashes(again.output), "a re-run plans nothing").toEqual([]);

        // T1010: replacing the registry (and a private repository's) token keeps the entry granted.
        const replace = ["registry", ...(repoPrivate ? ["repository"] : [])].flatMap((t) => [
          "--replace-token",
          t,
        ]);
        const access = async () =>
          (
            await portainer().ok<{ RegistryAccesses?: Record<string, unknown> }>(
              "GET",
              `/api/registries/${registryId}`,
              "read OpsCrew's registry entry",
            )
          ).RegistryAccesses ?? {};
        const before = await access();
        const planned = await opscrewOk("provision", "--plan-only", ...replace, "--yes");
        const hashes = approveHashes(planned.output);
        expect(hashes.length, "replacing a token plans a change").toBeGreaterThan(0);
        await opscrewOk(
          "provision",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          ...replace,
          "--yes",
        );
        await deploy("the token replace");
        const after = await access();
        const granted = Object.keys(after).includes(String(environmentId));
        if (!granted)
          findings.push(
            "after a registry token replace the entry is no longer granted to the environment",
          );
        else
          observe(
            `after a registry token replace the entry is still granted to the environment (${changedKeys(before, after).length === 0 ? "unchanged" : "access changed"})`,
          );
        await waitForSite((await deployBranchImage()).version, minutes(5));
        await expectDecoysUnchanged("the switch to Cloudflare redeploys and the token replace");
      },
    );

    step(
      "8. destroy keeps the data volumes; Portainer, its settings and the decoys stay",
      minutes(30),
      async () => {
        // In the core pass step 5 did not switch OpsCrew to the full Cloudflare token, and removing
        // the tunnel needs it; in the full pass this is already so.
        if (env.CLOUDFLARE_API_TOKEN !== E2E.cloudflareToken) {
          env.CLOUDFLARE_API_TOKEN = E2E.cloudflareToken;
          observe(
            "the updater + tunnel setup (steps 2 and 3) worked with OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN",
          );
        }
        recordedVolumes = (await createdRecord()).volumes;
        await keepDeployBranch("destroy");
        const removed = await opscrewOk("destroy", "--confirm", app());
        destroyed = true;
        await expectDeployBranchDeleted(removed.output, "destroy");
        observe(
          `destroy deleted the ${DEPLOY_BRANCH} branch once the app's stack was gone (T1012)`,
        );
        const left = (await stackNames()).filter((name) => name.startsWith(names().app));
        expect(left, "no stack of the app is left").toEqual([]);
        if (registryId !== undefined) {
          const entry = await portainer().call("GET", `/api/registries/${registryId}`);
          expect(entry.status, "OpsCrew's registry entry is removed").toBe(404);
        }
        const volumes = (
          await shell().ok(
            `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().app}`,
          )
        )
          .split("\n")
          .filter(Boolean);
        for (const volume of recordedVolumes) {
          expect(volumes, `destroy keeps the data volume ${volume}`).toContain(volume);
        }
        const z = zone as CloudflareZone;
        const resources = await portainerAppResources(cloudflare, z, app(), hostnames);
        const before = cloudflareBefore as CloudflareAppResources;
        const fresh = <T extends { id: string; name: string }>(now: T[], old: T[]) =>
          now.filter((item) => !old.some((o) => o.id === item.id)).map((item) => item.name);
        expect(
          resources.records.map((r) => `${r.type} ${r.name}`),
          "no DNS record of the app is left",
        ).toEqual([]);
        expect(
          fresh(resources.tunnels, before.tunnels),
          PASS === "full" ? "both tunnels are gone" : "the app's tunnel is gone",
        ).toEqual([]);
        expect(fresh(resources.apps, before.apps), "the Access application is gone").toEqual([]);
        expect(fresh(resources.policies, before.policies), "the Access policy is gone").toEqual([]);
        expect(
          fresh(resources.serviceTokens, before.serviceTokens),
          "the service token is gone",
        ).toEqual([]);
        const secrets = await secretNames(github);
        const kept = [
          "OPSCREW_BUILD_ENV",
          "OPSCREW_PORTAINER_WEBHOOK_URL",
          "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
          "OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET",
        ].filter((name) => secrets.includes(name));
        if (kept.length > 0)
          findings.push(`destroy left the deploy secrets ${kept.join(", ")} in GitHub`);
        for (const file of ["portainer-webhook", "portainer-env.key"]) {
          if (existsSync(join(paths().projectHomeDir, file)))
            findings.push(`destroy left OpsCrew's ${file} file`);
        }
        const stackPlans = existsSync(paths().files.plansDir)
          ? (await readdir(paths().files.plansDir)).filter((name) => name.startsWith("stack-"))
          : [];
        if (stackPlans.length > 0)
          findings.push(`destroy left ${stackPlans.length} saved stack plan(s)`);
        findings.push(...(await changedRulesets(cloudflare, z, rulesetsBefore)));
        await expectPortainerIntact("destroy");
        await expectDecoysUnchanged("destroy");
      },
    );

    /** Portainer's settings, users, environments, registries and other stacks are as before the run. */
    async function expectPortainerIntact(after: string): Promise<void> {
      const now = await portainerState();
      const changed = changedKeys(portainerBefore, now);
      const settings = changedKeys(
        portainerBefore.settings as Record<string, unknown>,
        now.settings as Record<string, unknown>,
      );
      if (settings.length > 0)
        findings.push(`Portainer's settings changed after ${after}: ${settings.join(", ")}`);
      expect(
        changed.filter((key) => key !== "settings"),
        `Portainer's users, environments, registries and other stacks are unchanged after ${after}`,
      ).toEqual([]);
      log(`Portainer itself is unchanged after ${after}`);
    }

    step(
      "9. destroy --delete-data removes the data volumes, and nothing else",
      minutes(20),
      async () => {
        const secretsBefore = (await secretNames(github)).sort();
        const removed = await opscrewOk("destroy", "--confirm", app(), "--delete-data");
        // Data only: GitHub is left alone (the branch stays absent, the secrets as they were).
        expect(
          await branchHead(github, DEPLOY_BRANCH),
          `destroy --delete-data leaves the ${DEPLOY_BRANCH} branch absent`,
        ).toBeUndefined();
        expect(
          removed.output.includes(`Deleted the branch ${DEPLOY_BRANCH}`),
          "destroy --delete-data deletes no branch",
        ).toBe(false);
        expect(
          (await secretNames(github)).sort(),
          "destroy --delete-data leaves GitHub's secrets",
        ).toEqual(secretsBefore);
        const volumes = (
          await shell().ok(
            `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().app}`,
          )
        )
          .split("\n")
          .filter(Boolean);
        for (const volume of recordedVolumes) {
          expect(volumes, `--delete-data removes ${volume}`).not.toContain(volume);
        }
        observe(`destroy --delete-data removed the ${recordedVolumes.length} recorded volume(s)`);
        await expectPortainerIntact("destroy --delete-data");
        await expectDecoysUnchanged("destroy --delete-data");
      },
    );

    /**
     * Removes a fresh setup of steps 10 and 11 with its data (`destroy --confirm <app>
     * --delete-data`): no stack and no volume of the app are left, the deploy branch is deleted (its
     * history kept locally as `refs/e2e/deploy-<label>` for the leak search), Portainer and the
     * decoys are as before the run.
     */
    async function removeFreshSetup(
      what: string,
      label: string,
      overrides: Record<string, string | undefined> = {},
    ): Promise<void> {
      await keepDeployBranch(label);
      const removed = await opscrewOkWith(
        overrides,
        "destroy",
        "--confirm",
        app(),
        "--delete-data",
      );
      await expectDeployBranchDeleted(removed.output, `removing ${what}`);
      expect(
        (await stackNames()).filter((name) => name.startsWith(names().app)),
        `no stack of the app is left after removing ${what}`,
      ).toEqual([]);
      const volumes = await shell().ok(
        `docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().app}`,
      );
      expect(volumes, `no volume of the app is left after removing ${what}`).toBe("");
      await expectPortainerIntact(`removing ${what}`);
      await expectDecoysUnchanged(`removing ${what}`);
    }

    step(
      "10. a loopback Portainer address: the updater reaches Portainer through host.docker.internal (a fresh setup, then removed)",
      minutes(60),
      async () => {
        // OpsCrew refuses another address while its record lists anything (T1005), so this runs
        // after destroy --delete-data emptied the record, as a setup of its own.
        await git("fetch", "-q", "origin");
        await git("checkout", "-q", "-B", "main", "origin/main");
        await openTunnel();
        await answerAndDesign({
          url: `https://localhost:${PORTAINER_PORT}`,
          redeploy: "updater",
          web: "proxy",
          port: PROXY_PORT,
        });
        const provisioned = await provisionUntilDone("the loopback address");
        await rememberSecrets([]);
        // destroy deleted the branch (T1012), so the new app stack starts from a new placeholder.
        expect(
          provisioned.output.includes(`Created the branch ${DEPLOY_BRANCH}`),
          `the fresh setup created the ${DEPLOY_BRANCH} branch anew`,
        ).toBe(true);
        expect(
          provisioned.output.includes(`Replaced the branch ${DEPLOY_BRANCH}`),
          `the fresh setup did not replace an earlier ${DEPLOY_BRANCH} branch`,
        ).toBe(false);
        const placeholderHead = await expectPlaceholderBranch("the loopback setup");
        if ((await deploy("the loopback address")) === undefined) {
          // provision opened no pull request: run the deploy workflow on main, as a user would.
          const since = new Date();
          await github.dispatchDeploy();
          const run = await github.waitForDeploy({
            headSha: await git("rev-parse", "HEAD"),
            event: "workflow_dispatch",
            since,
          });
          expect(run.conclusion, `the deploy run ${run.id} on main`).toBe("success");
        }
        web = "proxy";
        const line = await updaterWebhookLine();
        expect(
          line.includes(`://host.docker.internal:${PORTAINER_PORT}/api/stacks/webhooks/`),
          "with a loopback address the updater calls Portainer through host.docker.internal",
        ).toBe(true);
        await waitFor(
          `the deploy workflow writing the app to ${DEPLOY_BRANCH}`,
          minutes(15),
          async () => {
            const head = await branchHead(github, DEPLOY_BRANCH);
            return head !== undefined && head !== placeholderHead ? true : undefined;
          },
          10_000,
        );
        await waitForSite((await deployBranchImage()).version, minutes(10));
        observe(
          "with a loopback Portainer address the updater called Portainer through host.docker.internal",
        );
        await watchUpdater("the loopback address");
        await removeFreshSetup("the loopback setup", "loopback");
      },
    );

    step(
      "11. a short Portainer host name in the output check (a fresh setup, then removed)",
      minutes(45),
      async () => {
        if (tunnel === undefined || tunnel.exitCode !== null) await openTunnel();
        try {
          // The CLI reaches Portainer by a short name (default `nas`) through the SSH tunnel: a DNS
          // preload in its Node process resolves only that name. Containers on the server cannot
          // resolve it, so this setup is never deployed; it is checked, then removed.
          scrubber.add(`https://${shortHost}:${PORTAINER_PORT}`, "portainer-address");
          scrubber.add(`${shortHost}:${PORTAINER_PORT}`, "portainer-address");
          const preload = join(work, "short-host-dns.mjs");
          await writeFile(preload, dnsPreloadSource({ [shortHost]: "127.0.0.1" }));
          const short = {
            NODE_OPTIONS: preloadNodeOptions(pathToFileURL(preload).href, env.NODE_OPTIONS),
          };
          const check = await runner.run(
            process.execPath,
            [
              "-e",
              `require("node:net").connect({ host: ${JSON.stringify(shortHost)}, port: ${PORTAINER_PORT} }).on("connect", function () { console.log("ok"); this.destroy(); }).on("error", (e) => console.log(e.code))`,
            ],
            { env: { ...env, ...short }, timeoutMs: 30_000 },
          );
          expect(
            check.stdout.trim(),
            `the CLI's Node process reaches Portainer as ${shortHost}`,
          ).toBe("ok");
          await answerAndDesign(
            {
              url: `https://${shortHost}:${PORTAINER_PORT}`,
              redeploy: "updater",
              web: "proxy",
              port: PROXY_PORT,
            },
            short,
          );
          await provisionUntilDone("the short host name", short);
          await rememberSecrets([]);
          // Never deployed: the app's stack runs the placeholder, so no app answers. secure and
          // drift run against that stack; their exits are recorded, not judged.
          await expectPlaceholderBranch("the short-host setup");
          const exits: string[] = [];
          for (const command of ["secure", "drift"]) {
            const result = await opscrewWith(short, command);
            exits.push(`${command} exited with ${result.exitCode}`);
          }
          const verified = await opscrewWith(
            short,
            "verify",
            "--url",
            `http://${ipv4()}:${PROXY_PORT}`,
          );
          observe(
            `with Portainer at "${shortHost}" and the placeholder deployed: provision passed, ${exits.join(", ")}; verify --url exited with ${verified.exitCode} (no app is expected to answer)`,
          );
          await removeFreshSetup("the short-host setup", "short-host", short);
        } finally {
          closeTunnel();
        }
      },
    );

    step(
      "12. no token, secret, server address or Portainer address in commits, pull requests, files, CLI output, MCP results or the audit log",
      minutes(10),
      async () => {
        if (!repoReady) return;
        const known = scrubber.entries();
        const secrets = known.filter(
          ({ label }) =>
            !label.startsWith("server-") &&
            label !== "portainer-address" &&
            label !== "test-computer-ipv4",
        );
        const problems: string[] = [];
        // Every known value anywhere; the bare short host name (a common word) only in what OpsCrew
        // itself printed or saved (the app's own files and history may use it as a word), and only
        // when step 11 gave OpsCrew that name (the core pass never does).
        const shortHostRan = inPass(PASS, "11");
        const search = (where: string, text: string, list = known, shortHostToo = shortHostRan) => {
          const found = leakedLabels(text, list);
          if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
          const mentions = shortHostToo ? shortHostMentions(text, shortHost) : 0;
          if (mentions > 0) {
            problems.push(`${where} names the short Portainer host ${mentions} time(s)`);
          }
        };
        await git("fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
        // `--all` also walks refs/e2e/deploy-*: the deploy branches kept before each destroy
        // deleted them on GitHub (step 8, and steps 10 and 11 in the full pass).
        search(
          "the commits (every branch)",
          await git("log", "--all", "-p", "--format=%B"),
          known,
          false,
        );
        for (const pull of await github.pullRequestTexts(startedAt))
          search(`pull request #${pull.number}`, pull.text);
        for (const [label, output] of outputs) search(label, output);
        search("the MCP results", mcpTexts.join("\n"));
        for (const [file, content] of planFiles) search(`.opscrew/plans/${file}`, content);
        const tracked = (await git("ls-files", "-co", "--exclude-standard"))
          .split("\n")
          .filter(Boolean);
        for (const file of tracked) {
          const path = join(repo, file);
          if (!existsSync(path) || statSync(path).size > 1_000_000) continue;
          search(`the file ${file}`, await readFile(path, "utf8"), known, false);
        }
        const local = join(paths().stateDir, "server.json");
        if (existsSync(local))
          search(".opscrew/server.json", await readFile(local, "utf8"), secrets);
        const auditDir = paths().auditDir;
        if (existsSync(auditDir)) {
          for (const file of await readdir(auditDir)) {
            search(`the audit log ${file}`, await readFile(join(auditDir, file), "utf8"));
          }
        }
        for (const label of [
          "PORTAINER_API_KEY",
          "OPSCREW_GHCR_READ_TOKEN",
          "portainer-webhook",
          ...(repoPrivate ? ["OPSCREW_REPO_READ_TOKEN"] : []),
        ]) {
          if (!known.some((entry) => entry.label === label))
            findings.push(`the leak search had no value for ${label}`);
        }
        log(`the leak search covered the ${PASS} pass's commits, outputs, files and audit log`);
        for (const observation of observations) log(`run log: ${observation}`);
        for (const problem of problems) log(`leak: ${problem}`);
        for (const finding of findings) log(`finding: ${finding}`);
        expect(problems, "nothing leaked").toEqual([]);
        expect(findings, "findings of the run").toEqual([]);
      },
      true,
    );

    afterAll(async () => {
      const problems: string[] = [];
      const attempt = async (what: string, body: () => Promise<unknown>) => {
        try {
          const found = await body();
          if (Array.isArray(found)) problems.push(...found);
        } catch (error) {
          problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      closeTunnel();
      // The server, its key and firewall go first and always: they are billed.
      if (hetznerTouched) {
        log("deleting the throwaway server, its SSH key and its firewall");
        await attempt("delete the throwaway server", () =>
          deletePortainerThrowaway({
            token: E2E.hcloudToken,
            runId,
            ...(serverId === undefined ? {} : { serverId }),
            ...(keyId === undefined ? {} : { keyId }),
            ...(firewallId === undefined ? {} : { firewallId }),
          }),
        );
      }
      if (zone !== undefined && appName !== undefined && cloudflareBefore !== undefined) {
        log(
          destroyed
            ? "checking Cloudflare for anything this run created that destroy left"
            : "destroy did not finish: removing what this run created in Cloudflare",
        );
        const z = zone;
        const name = appName;
        const before = cloudflareBefore;
        await attempt("remove the Cloudflare resources", async () =>
          cloudflare.removeCreated(
            z,
            await portainerAppResources(cloudflare, z, name, hostnames),
            before,
            {
              hostnames,
              log,
            },
          ),
        );
        // The zone's own rulesets must have the rules they had before the run (never restored here).
        await attempt("compare the zone's rulesets", () =>
          changedRulesets(cloudflare, z, rulesetsBefore),
        );
      }
      if (repoReady) await attempt("reset the throwaway repository", () => github.reset());
      if (work !== "") await rm(work, { recursive: true, force: true }).catch(() => undefined);
      if (problems.length > 0) {
        throw cleanError(new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`));
      }
      if (hetznerTouched) log("the throwaway server, its SSH key and its firewall are deleted");
    }, minutes(15));
  },
);
