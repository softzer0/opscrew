import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  CLOUDFLARE_RANGES,
  createTestPhaseDeps,
  ScriptedRunner,
} from "../testing";
import { type FakePagesOptions, fakeGithubPages, pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import type { DnsResolver, TlsConnect } from "./net";
import { runVerify } from "./run";
import { WORKER_PATH } from "./serverless";

const NOW = new Date("2026-10-24T12:00:00.000Z");

const HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

interface SiteOptions {
  /** The front page's answer (default 200 with OpsCrew's headers). */
  front?: () => Response;
  /** The Worker's own answer at {@link WORKER_PATH} (default 404 with OpsCrew's headers). */
  worker?: () => Response;
  /** Every request to the site fails as before GitHub has a certificate for it. */
  noCertificate?: boolean;
  /** GitHub's API for the Pages site. */
  pages?: FetchLike;
}

/** The site at `docs.example.com` (and `www.`), and GitHub's API when given. */
function fakeInternet(o: SiteOptions = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, method: init?.method ?? "GET" });
    if (url.host === "api.github.com") {
      if (o.pages === undefined) throw new Error(`unexpected GitHub call ${url.href}`);
      return o.pages(input, init);
    }
    if (o.noCertificate) {
      throw new Error("fetch failed", { cause: new Error("certificate has expired") });
    }
    if (url.pathname === WORKER_PATH) {
      return o.worker?.() ?? new Response("not found", { status: 404, headers: HEADERS });
    }
    return o.front?.() ?? new Response("<!doctype html><p>docs</p>", { headers: HEADERS });
  };
  return { fetch, calls };
}

const resolver = (a: string[], aaaa: string[]): DnsResolver => ({
  resolve4: async () => a,
  resolve6: async () => aaaa,
});
const CLOUDFLARE_DNS = resolver([CLOUDFLARE_IPV4], [CLOUDFLARE_IPV6]);
const PAGES_DNS = resolver(["185.199.108.153", "185.199.111.153"], ["2606:50c0:8000::153"]);

/** A certificate for `names` (default the host asked for), valid until mid-January. */
const certificate =
  (names?: string[], issuer = "Google Trust Services"): TlsConnect =>
  async (host) => ({
    subjectAltNames: names ?? [host],
    validFrom: "2026-10-01T00:00:00.000Z",
    validTo: "2027-01-15T00:00:00.000Z",
    issuer,
  });

async function setup(plan: DeployPlan) {
  const runner = new ScriptedRunner((command, args) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/example-org/example-app.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "unexpected command" },
  );
  const deps = await createTestPhaseDeps({ runner, clock: { now: () => NOW } });
  deps.env.GITHUB_TOKEN = fakeSecret("github-token", "verify-site");
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const before = await readFile(deps.paths.files.plan, "utf8");
  /** The plan is as it was, and verify wrote no runbook or any other file into the repository. */
  const unchanged = async () => {
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(await readdir(join(deps.paths.root, "opscrew"))).toEqual(["plan.yaml"]);
  };
  return { deps, runner, unchanged };
}

const statuses = (checks: { id: string; status: string }[]) =>
  checks.map((check) => [check.id, check.status]);

describe("opscrew verify on Cloudflare's hosting", () => {
  it("refuses an address to check: the site is checked through its domain", async () => {
    const { deps, unchanged } = await setup(sitePlan({ deployed: true }));
    await expect(runVerify(deps, { url: "https://docs.example.com" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "An address to check is only for an app in your Portainer behind your own reverse proxy; OpsCrew checks this deployment through its domain. Nothing was checked.",
    });
    await unchanged();
  });

  it("checks each hostname's DNS, certificate and answer, and OpsCrew's headers, changing nothing", async () => {
    const { deps, runner, unchanged } = await setup(sitePlan({ www: true, deployed: true }));
    const site = fakeInternet();
    const result = await runVerify(deps, {
      resolver: CLOUDFLARE_DNS,
      fetch: site.fetch,
      tlsConnect: certificate(),
      cloudflareRanges: CLOUDFLARE_RANGES,
    });

    expect(statuses(result.checks)).toEqual([
      ["dns-records", "pass"],
      ["tls-certificate", "pass"],
      ["site-reachable", "pass"],
      ["dns-records-www", "pass"],
      ["tls-certificate", "pass"],
      ["site-reachable", "pass"],
      ["security-headers", "pass"],
    ]);
    expect(result).toMatchObject({ passed: true, url: "https://docs.example.com" });
    expect(result.runbookPath).toBeUndefined();
    expect(result.checks[1]?.message).toContain("issued by Google Trust Services");
    // Only reads of the site: no GitHub, no command, nothing written.
    expect(site.calls.every((call) => call.method === "GET")).toBe(true);
    expect(site.calls.some((call) => call.url.includes("api.github.com"))).toBe(false);
    expect(runner.calls).toEqual([]);
    await unchanged();
    expect((await deps.state.read()).phases.verify?.status).toBe("ok");
    const output = deps.reporter.text();
    expect(output).toContain("https://docs.example.com is live on Cloudflare");
    expect(output).not.toMatch(/server/i);
  });

  it("checks the headers on the Worker's own answers of a server-rendered site", async () => {
    const { deps } = await setup(sitePlan({ render: "ssr", deployed: true }));
    const site = fakeInternet({ worker: () => new Response("<p>rendered</p>") });
    const result = await runVerify(deps, {
      resolver: CLOUDFLARE_DNS,
      fetch: site.fetch,
      tlsConnect: certificate(),
      cloudflareRanges: CLOUDFLARE_RANGES,
    });

    expect(statuses(result.checks).slice(-2)).toEqual([
      ["security-headers", "pass"],
      ["security-headers-worker", "fail"],
    ]);
    const worker = result.checks.at(-1);
    expect(worker?.target).toBe(`https://docs.example.com${WORKER_PATH}`);
    expect(worker?.remediation).toContain("opscrew/cloudflare/headers-entry.js");
    expect(worker?.remediation).toContain("`opscrew provision`");
    expect(result.passed).toBe(false);
    expect(deps.reporter.text()).not.toMatch(/server/i);
  });

  it("says when the Worker still answers with the placeholder, and when DNS leaves Cloudflare", async () => {
    const { deps } = await setup(sitePlan({ deployed: true }));
    const site = fakeInternet({
      front: () => new Response("Not deployed yet", { status: 503 }),
    });
    const result = await runVerify(deps, {
      resolver: resolver(["203.0.113.7"], []),
      fetch: site.fetch,
      tlsConnect: certificate(),
      cloudflareRanges: CLOUDFLARE_RANGES,
    });

    const [dns, , answer, headers] = result.checks;
    expect(dns).toMatchObject({ status: "fail" });
    expect(dns?.message).toContain("203.0.113.7, which is not a Cloudflare address");
    expect(answer).toMatchObject({ status: "fail" });
    expect(answer?.message).toContain("OpsCrew's placeholder");
    expect(answer?.remediation).toContain("deploy-setup pull request");
    expect(headers).toMatchObject({ id: "security-headers", status: "skip" });
    expect((await deps.state.read()).phases.verify?.status).toBe("failed");
    expect(deps.reporter.text()).not.toMatch(/server/i);
  });
});

describe("opscrew verify on GitHub Pages", () => {
  async function verifyPages(
    pages: Omit<FakePagesOptions, "log">,
    o: { resolver?: DnsResolver; tls?: TlsConnect; noCertificate?: boolean } = {},
  ) {
    const s = await setup(pagesTestPlan({ domain: "example.com", www: true }));
    const github = fakeGithubPages(pages);
    const site = fakeInternet({
      pages: github.fetch,
      ...(o.noCertificate ? { noCertificate: true } : {}),
    });
    const result = await runVerify(s.deps, {
      resolver: o.resolver ?? PAGES_DNS,
      fetch: site.fetch,
      tlsConnect: o.tls ?? certificate(undefined, "Let's Encrypt"),
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    return { ...s, github, site, result };
  }
  const SITE = { buildType: "workflow", cname: "example.com", httpsEnforced: true } as const;
  const pagesCheck = (checks: CheckResult[]) => checks.find((c) => c.id === "pages-https");

  it("passes once GitHub issued the certificate and enforces HTTPS, and sets no headers", async () => {
    const { result, deps, github, unchanged } = await verifyPages({ site: SITE, health: "issued" });

    expect(statuses(result.checks)).toEqual([
      ["dns-records", "pass"],
      ["tls-certificate", "pass"],
      ["site-reachable", "pass"],
      ["dns-records-www", "pass"],
      ["tls-certificate", "pass"],
      ["site-reachable", "pass"],
      ["pages-https", "pass"],
      ["security-headers", "skip"],
    ]);
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.message).toContain("resolves to GitHub Pages");
    expect(result.checks.at(-1)?.message).toContain("GitHub Pages cannot set security headers");
    // Read only: the site and its health, never a change.
    expect(github.log).toEqual(["pages GET /pages", "pages GET /pages/health"]);
    await unchanged();
    expect(deps.reporter.text()).not.toMatch(/server/i);
  });

  it("reports a pending certificate, says when to look again and names opscrew provision", async () => {
    const { result, deps, github } = await verifyPages(
      { site: { ...SITE, httpsEnforced: false }, health: "dns-ok" },
      { tls: certificate(["*.github.io", "github.io"], "DigiCert"), noCertificate: true },
    );

    const check = pagesCheck(result.checks);
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.message).toContain("GitHub has not issued the certificate for example.com yet");
    expect(check?.message).toContain("Run `opscrew verify` again in an hour");
    expect(check?.message).toContain("`opscrew provision`");
    // The hostnames' certificate and answer wait for it: warnings, not failures.
    const waiting = result.checks.filter(
      (c) => c.id === "tls-certificate" || c.id === "site-reachable",
    );
    expect(waiting.map((c) => c.status)).toEqual(["warn", "warn", "warn", "warn"]);
    expect(result.checks.some((c) => c.status === "fail")).toBe(false);
    expect(result.passed).toBe(true);
    expect(github.log.some((line) => !line.startsWith("pages GET"))).toBe(false);
    const output = deps.reporter.text();
    expect(output).not.toMatch(/server/i);
    // Set up, not live: the summary says what is missing and what to do.
    expect(output).not.toContain("is live");
    expect(output).toContain(
      "https://example.com is set up on GitHub Pages, but GitHub has not issued its certificate yet",
    );
    expect(output).toContain(
      "Run `opscrew verify` again later; once it is issued, `opscrew provision` enforces HTTPS.",
    );
  });

  it("says what to do when it cannot read the Pages site", async () => {
    const s = await setup(pagesTestPlan({ domain: "example.com" }));
    s.deps.env.GITHUB_TOKEN = undefined;
    const unread = await runVerify(s.deps, {
      resolver: PAGES_DNS,
      fetch: fakeInternet().fetch,
      tlsConnect: certificate(undefined, "Let's Encrypt"),
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    const check = pagesCheck(unread.checks);
    expect(check).toMatchObject({
      status: "warn",
      message: "OpsCrew could not read the GitHub Pages site. No GitHub token is available.",
      remediation: "Set GITHUB_TOKEN or run `gh auth login`, then run `opscrew verify` again.",
    });
  });

  it("reports an issued certificate with HTTPS not enforced yet, and names opscrew provision", async () => {
    const { result, github } = await verifyPages({
      site: { ...SITE, httpsEnforced: false },
      health: "issued",
    });

    const check = pagesCheck(result.checks);
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.message).toContain("HTTPS is not enforced yet");
    expect(check?.remediation).toBe(
      "Run `opscrew provision`: it enforces HTTPS (it shows the Pages plan first).",
    );
    // verify never enforces it itself.
    expect(github.log).toEqual(["pages GET /pages", "pages GET /pages/health"]);
  });

  it("fails when Cloudflare's proxy is on for a hostname, or the site lost its custom domain", async () => {
    const { result } = await verifyPages(
      { site: { ...SITE, cname: "other.example.org" }, health: "issued" },
      { resolver: CLOUDFLARE_DNS },
    );

    const [dns] = result.checks;
    expect(dns).toMatchObject({ status: "fail" });
    expect(dns?.message).toContain("Cloudflare's proxy is on for it");
    expect(dns?.remediation).toContain("grey cloud");
    const check = pagesCheck(result.checks);
    expect(check).toMatchObject({ status: "fail" });
    expect(check?.message).toContain("custom domain other.example.org, not example.com");
    expect(result.passed).toBe(false);
  });
});
