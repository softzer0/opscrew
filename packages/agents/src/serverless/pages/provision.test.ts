import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudflareDnsRecord } from "@opscrew/connector-cloudflare";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { pagesVerificationRootDir } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { runProvision } from "../../provision/run";
import type { ProvisionOptions } from "../../provision/types";
import { pagesVerificationStateFile } from "../../shared";
import {
  createTestPhaseDeps,
  fakeCloudflare,
  opscrewRecord,
  projectRunner,
  ScriptedApprovalHandler,
} from "../../testing";
import {
  createPagesProject,
  type FakePagesOptions,
  fakeGithubPages,
  LoggedGitHub,
  PAGES_REPO,
  PagesEngine,
  type PagesPlanOptions,
  pagesTestPlan,
} from "../../testing/pages";
import { PagesPlanSchema, pagesPlanFile, pagesPlanHash } from "./plan";

const GITHUB_TOKEN = fakeSecret("github-token", "pages-provision");
const CLOUDFLARE_TOKEN = fakeSecret("cloudflare-token", "pages-provision");
/** A value of GitHub's verification record, as its settings page shows one. */
const VERIFICATION = "a1b2c3d4e5f60718293a4b5c6d7e8f";
/** The scheduled check's webhook address: a secret, never shown. */
const WEBHOOK = "https://discord.example.com/api/webhooks/opscrew-alerts-4d2e";
const { owner, repo } = PAGES_REPO;

interface SetupOptions {
  plan?: PagesPlanOptions;
  pages?: Omit<FakePagesOptions, "log">;
  records?: CloudflareDnsRecord[];
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  interactive?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const plan = pagesTestPlan(options.plan);
  const project = await createPagesProject(plan);
  const log: string[] = [];
  const pages = fakeGithubPages({ ...options.pages, log });
  const engine = new PagesEngine(log, project.root);
  const github = new LoggedGitHub(log);
  const cloudflare = fakeCloudflare({ records: options.records ?? [] });
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    GITHUB_TOKEN,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  await writeFile(join(project.root, "production.env"), "");
  /** Makes the deps of one run, with the handler `answer` (default: approve everything). */
  const run = async (
    runOptions: Omit<ProvisionOptions, "services"> & {
      answer?: SetupOptions["answer"];
      ask?: (question: { domain: string; page: string }) => Promise<string>;
      /** This run's clock (default: the test deps' fixed time). */
      now?: Date;
    } = {},
  ) => {
    const { answer, ask, now, ...provision } = runOptions;
    const handler = new ScriptedApprovalHandler(answer ?? options.answer ?? (() => true));
    const deps = await createTestPhaseDeps({
      root: project.root,
      env,
      runner: projectRunner(),
      approvalHandler: handler,
      fetch: pages.fetch,
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
      ...(now !== undefined ? { clock: { now: () => now } } : {}),
    });
    deps.redactor.addLiteral(CLOUDFLARE_TOKEN, "CLOUDFLARE_API_TOKEN");
    const result = runProvision(deps, {
      ...provision,
      services: {
        engine: async () => engine,
        github,
        cloudflare,
        sleep: async () => undefined,
        ...(ask !== undefined ? { askPagesVerification: ask } : {}),
      },
    });
    return { deps, handler, result };
  };
  /** GitHub merges the deploy-setup pull request, and this clone pulls main. */
  const merge = async () => {
    const { git, root, bare } = project;
    const branch = await git(root, "branch", "--show-current");
    if (branch === "main") return;
    await git(bare, "update-ref", "refs/heads/main", await git(root, "rev-parse", "HEAD"));
    await git(bare, "update-ref", "-d", `refs/heads/${branch}`);
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", branch);
  };
  return { ...project, log, pages, engine, github, cloudflare, env, run, merge };
}

/** The requests that change the GitHub Pages site, the IaC applies and the pull request. */
const changes = (log: readonly string[]) =>
  log.filter((line) => /^(pages (POST|PUT|DELETE)|engine apply|github pull request)/.test(line));

/** Every hash-bound approval asked for, as `<kind> <hash>`. */
const hashBound = (requests: readonly ApprovalRequest[]) =>
  requests.flatMap((r) => (r.planHash === undefined ? [] : [`${r.kind} ${r.planHash}`]));

/** The error `work` stopped with. */
async function failure(work: Promise<unknown>): Promise<OpsCrewError> {
  const error = await work.then(() => undefined).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))("provision on GitHub Pages", () => {
  it("sets up a subdomain in the takeover-safe order, every change approved by its hash", async () => {
    const { root, run, log, engine, pages } = await setup();
    const { deps, handler, result } = await run({ pagesVerification: VERIFICATION });
    const outcome = await result;
    const plan = await readArtifact("plan", deps.paths.files.plan);

    expect(handler.requests.map((r) => r.kind)).toEqual([
      "pages-apply",
      "repo-write",
      "iac-apply",
      "iac-apply",
      "git-push",
      "pull-request",
    ]);
    // The site and its domain at GitHub, then the DNS records, then the verification record,
    // then the workflow's pull request; GitHub's health check never ran without the domain.
    const dnsRoot = plan.infra.dir;
    const verificationRoot = pagesVerificationRootDir(plan);
    expect(changes(log)).toEqual([
      `pages POST /pages {"build_type":"workflow"}`,
      `pages PUT /pages {"cname":"docs.example.com"}`,
      `engine apply ${dnsRoot}`,
      `engine apply ${verificationRoot}`,
      "github pull request",
    ]);
    expect(log.some((line) => line.includes("/pages/health"))).toBe(false);
    expect(pages.state.site).toEqual({
      buildType: "workflow",
      cname: "docs.example.com",
      httpsEnforced: false,
    });

    // Each approval is bound to the plan that was applied.
    const pagesHash = outcome.pagesPlanHash as string;
    const saved = PagesPlanSchema.parse(
      JSON.parse(await readFile(pagesPlanFile(deps.paths, pagesHash), "utf8")),
    );
    expect(pagesPlanHash(saved)).toBe(pagesHash);
    expect(saved.steps).toEqual([
      { kind: "create" },
      { kind: "set-domain", cname: "docs.example.com" },
    ]);
    expect(hashBound(handler.requests)).toEqual([
      `pages-apply ${pagesHash}`,
      `iac-apply ${outcome.planHash}`,
      `iac-apply ${outcome.pagesVerificationPlanHash}`,
    ]);
    expect(engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual([
      outcome.planHash,
      outcome.pagesVerificationPlanHash,
    ]);
    expect(plan.approvals.map((a) => `${a.kind} ${a.planHash}`)).toEqual(
      hashBound(handler.requests),
    );
    // The verification root keeps its own state, which `app remove` reads.
    expect(engine.inits).toEqual([
      { root: dnsRoot, statePath: join(deps.paths.files.tfstateDir, "prod.tfstate") },
      { root: verificationRoot, statePath: pagesVerificationStateFile(deps.paths) },
    ]);
    const tfvars = JSON.parse(
      await readFile(join(root, verificationRoot, "terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ verification: VERIFICATION, github_owner: owner });
    await expect(readFile(join(root, plan.cicd.workflowPath), "utf8")).resolves.toContain(
      "actions/deploy-pages",
    );
    expect(outcome).toMatchObject({ applied: true, prUrl: expect.any(String) });
    expect(plan.deployment.url).toBe("https://docs.example.com");

    // Each change is an audit entry.
    expect(deps.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "pages apply started",
        "pages change create",
        "pages change set-domain",
      ]),
    );
    const text = deps.reporter.text();
    expect(text).toContain(
      `_github-pages-challenge-${owner}.docs.example.com resolves (usually within minutes), open https://github.com/settings/pages and click Verify next to docs.example.com`,
    );
    expect(text).toContain("GitHub checks the DNS records of docs.example.com next");
    expect(`${text}\n${JSON.stringify(deps.audit.entries)}`).not.toContain(GITHUB_TOKEN);
    expect(`${text}\n${JSON.stringify(deps.audit.entries)}`).not.toContain(CLOUDFLARE_TOKEN);
  });

  it("sets up an apex with www: A and AAAA records, and the www CNAME", async () => {
    const { root, run, log } = await setup({ plan: { domain: "example.com", www: true } });
    const { deps, result } = await run({ pagesVerification: VERIFICATION });
    await result;
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const tfvars = JSON.parse(
      await readFile(join(root, plan.infra.dir, "terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ domain: "example.com", apex: true, www: true });
    expect(changes(log).slice(0, 2)).toEqual([
      `pages POST /pages {"build_type":"workflow"}`,
      `pages PUT /pages {"cname":"example.com"}`,
    ]);
  });

  it("switches Pages on from a branch to the workflow source, shown in the plan", async () => {
    const { run, log } = await setup({
      pages: { site: { buildType: "legacy", httpsEnforced: false } },
    });
    const { handler, result } = await run({ pagesVerification: VERIFICATION });
    await result;
    expect(handler.requests[0]?.details).toContain(
      "with OpsCrew's deploy workflow instead of from a branch",
    );
    expect(changes(log).slice(0, 2)).toEqual([
      `pages PUT /pages {"build_type":"workflow"}`,
      `pages PUT /pages {"cname":"docs.example.com"}`,
    ]);
  });

  const OTHER_DOMAIN = {
    buildType: "workflow",
    cname: "old.example.com",
    httpsEnforced: false,
  } as const;

  it("replaces another custom domain only with the typed app name, and a refusal changes nothing", async () => {
    const approved = await setup({ pages: { site: { ...OTHER_DOMAIN } } });
    const first = await approved.run({ pagesVerification: VERIFICATION });
    await first.result;
    const request = first.handler.requests[0];
    expect(request).toMatchObject({
      kind: "pages-apply",
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(request?.details).toContain("It replaces old.example.com");
    expect(approved.pages.state.site?.cname).toBe("docs.example.com");

    const refused = await setup({
      pages: { site: { ...OTHER_DOMAIN } },
      answer: (r) => r.kind !== "pages-apply",
    });
    const error = await failure((await refused.run({ pagesVerification: VERIFICATION })).result);
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toContain("--confirm example-app");
    expect(changes(refused.log)).toEqual([]);
    expect(refused.engine.calls).toEqual([]);
    expect(refused.pages.state.site?.cname).toBe("old.example.com");
  });

  it("keeps the replaced domain claimed while Cloudflare still points it at GitHub Pages", async () => {
    const { run, log, engine } = await setup({
      pages: { site: { ...OTHER_DOMAIN } },
      records: [
        opscrewRecord("old.example.com", "CNAME", "example-org.github.io", { proxied: false }),
      ],
    });
    const { handler, result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Cloudflare still has records that point it at GitHub Pages");
    expect(error.message).toContain("CNAME old.example.com example-org.github.io");
    expect(error.message).toContain("OpsCrew changed nothing");
    expect(error.hint).toContain("`opscrew destroy`");
    expect(error.hint).toContain("delete them in the Cloudflare dashboard");
    expect(handler.requests).toEqual([]);
    expect(changes(log)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("refuses a private repository whose plan has no GitHub Pages, before any change", async () => {
    const { run, log, engine } = await setup({ pages: { private: true, plan: "free" } });
    const { handler, result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("GitHub Pages is not available");
    expect(handler.requests).toEqual([]);
    expect(changes(log)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("refuses a CAA record that doesn't allow Let's Encrypt, naming it", async () => {
    const caa: CloudflareDnsRecord = {
      id: "caa",
      type: "CAA",
      name: "example.com",
      content: '0 issue "digicert.com"',
      ttl: 1,
    };
    const { run, log } = await setup({ records: [caa] });
    const { handler, result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.message).toContain('CAA example.com 0 issue "digicert.com"');
    expect(handler.requests).toEqual([]);
    expect(changes(log)).toEqual([]);
  });

  it("refuses a record proxied by Cloudflare at the site's hostname", async () => {
    const { run, log } = await setup({
      records: [opscrewRecord("docs.example.com", "CNAME", "example-org.github.io")],
    });
    const { result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.message).toContain("(proxied by Cloudflare)");
    expect(changes(log)).toEqual([]);
  });

  it("stops before any change without the verification value, naming the page and the flag", async () => {
    const { run, log } = await setup();
    const { result } = await run();
    const error = await failure(result);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("On https://github.com/settings/pages");
    expect(error.hint).toContain("opscrew provision --pages-verification <value>");
    expect(changes(log)).toEqual([]);
    const wrong = await failure((await run({ pagesVerification: "not a value" })).result);
    expect(wrong.code).toBe("INVALID_INPUT");
  });

  it("asks for the verification value in a terminal, then recovers it on later runs", async () => {
    const { root, run, pages, merge } = await setup({ interactive: true });
    const ask = vi.fn(async () => ` ${VERIFICATION} `);
    await (await run({ ask })).result;
    expect(ask).toHaveBeenCalledWith({
      domain: "docs.example.com",
      page: "https://github.com/settings/pages",
    });
    await merge();
    pages.state.health = "dns-ok";
    const again = vi.fn(async () => "unused");
    const { deps, result } = await run({ ask: again });
    await result;
    expect(again).not.toHaveBeenCalled();
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const tfvars = JSON.parse(
      await readFile(join(root, pagesVerificationRootDir(plan), "terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars.verification).toBe(VERIFICATION);
  });

  it("saves the domain again once GitHub sees the DNS valid, once, then enforces HTTPS", async () => {
    const { run, log, pages, merge } = await setup();
    await (await run({ pagesVerification: VERIFICATION })).result;

    // The pull request is merged; GitHub's check found the records valid, and no certificate came.
    await merge();
    pages.state.health = "dns-ok";
    const second = await run();
    const outcome = await second.result;
    expect(second.handler.requests.map((r) => r.kind)).toContain("pages-apply");
    expect(second.handler.requests[0]?.details).toContain("about a second apart");
    const health = log.findIndex((line) => line.includes("/pages/health"));
    expect(health).toBeGreaterThan(log.indexOf(`pages PUT /pages {"cname":"docs.example.com"}`));
    const sitesChanges = () => changes(log).filter((line) => line.startsWith("pages "));
    expect(sitesChanges().slice(-2)).toEqual([
      `pages PUT /pages {"cname":null}`,
      `pages PUT /pages {"cname":"docs.example.com"}`,
    ]);
    expect(outcome.pagesPlanHash).toBeDefined();
    expect(second.deps.reporter.text()).toContain("GitHub is issuing the certificate");

    // Still no certificate: the domain is not saved once more.
    await merge();
    const third = await run();
    await third.result;
    expect(third.handler.requests.map((r) => r.kind)).not.toContain("pages-apply");
    const waiting = third.deps.reporter.text();
    expect(waiting).toContain("can take up to 24 hours");
    expect(waiting).toContain(
      "If it still has not come a day after OpsCrew saved the domain again, run `opscrew provision` once more: it saves the domain again, which leaves it with no site claiming it for about a second (verifying the domain in your GitHub settings removes that gap).",
    );

    // A day later still none: the next run saves the domain again.
    await merge();
    const dayLater = await run({ now: new Date("2026-10-12T12:00:01.000Z") });
    await dayLater.result;
    expect(dayLater.handler.requests.map((r) => r.kind)).toContain("pages-apply");
    expect(sitesChanges().slice(-2)).toEqual([
      `pages PUT /pages {"cname":null}`,
      `pages PUT /pages {"cname":"docs.example.com"}`,
    ]);

    // The certificate is there: HTTPS is enforced through a Pages plan.
    await merge();
    pages.state.health = "issued";
    const fourth = await run();
    await fourth.result;
    expect(sitesChanges().at(-1)).toBe(`pages PUT /pages {"https_enforced":true}`);
    expect(pages.state.site?.httpsEnforced).toBe(true);
    expect(fourth.deps.reporter.text()).toContain("HTTPS is enforced for docs.example.com");
  });

  it("shows every plan with --plan-only, then applies exactly those by their hashes", async () => {
    const { run, log, engine } = await setup();
    const shown = await run({ planOnly: true, pagesVerification: VERIFICATION });
    const planned = await shown.result;
    expect(changes(log)).toEqual([]);
    expect(engine.applied).toEqual([]);
    const hashes = [
      planned.pagesPlanHash,
      planned.planHash,
      planned.pagesVerificationPlanHash,
    ] as string[];
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(new Set(hashes).size).toBe(3);

    // A script approves the three hashes: anything else is refused.
    const approved = await run({
      approveHashes: hashes,
      answer: (request) =>
        request.planHash === undefined || hashes.includes(request.planHash.toLowerCase()),
    });
    const outcome = await approved.result;
    expect(hashBound(approved.handler.requests)).toEqual([
      `pages-apply ${hashes[0]}`,
      `iac-apply ${hashes[1]}`,
      `iac-apply ${hashes[2]}`,
    ]);
    expect(engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual(hashes.slice(1));
    expect(outcome.applied).toBe(true);
  });

  it("changes nothing when the Pages plan is refused", async () => {
    const { run, log, engine } = await setup({ answer: (r) => r.kind !== "pages-apply" });
    const { result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("Nothing was changed.");
    expect(changes(log)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("says what was applied when the DNS plan is refused after the Pages plan", async () => {
    const { run, log } = await setup({ answer: (r) => r.kind !== "iac-apply" });
    const { result } = await run({ pagesVerification: VERIFICATION });
    const error = await failure(result);
    expect(error.message).toContain("OpsCrew applied the Pages plan");
    expect(changes(log).some((line) => line.startsWith("engine apply"))).toBe(false);
  });

  it("stores the app's values as repository secrets, never showing them", async () => {
    const value = fakeSecret("stripe-live-key", "pages-build");
    const { root, run, github, log } = await setup({ plan: { env: ["SITE_API_TOKEN"] } });
    await writeFile(join(root, "production.env"), `SITE_API_TOKEN=${value}\n`);
    const { deps, handler, result } = await run({ pagesVerification: VERIFICATION });
    await result;
    expect(handler.requests.map((r) => r.kind)).toContain("github-secrets");
    expect(github.secrets.get("OPSCREW_ENV_SITE_API_TOKEN")).toBe(value);
    expect(github.environments.size).toBe(0);
    expect(log.indexOf("github secret OPSCREW_ENV_SITE_API_TOKEN")).toBeLessThan(
      log.indexOf("github pull request"),
    );
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const written = await Promise.all(
      [
        deps.paths.files.plan,
        join(root, plan.cicd.workflowPath),
        join(root, plan.infra.dir, "terraform.tfvars.json"),
        join(root, pagesVerificationRootDir(plan), "terraform.tfvars.json"),
      ].map((file) => readFile(file, "utf8")),
    );
    const everything = [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(handler.requests),
      ...written,
    ].join("\n");
    expect(everything).not.toContain(value);
    expect(everything).not.toContain(GITHUB_TOKEN);
  });

  it("names the account's settings page of an organization's repository", async () => {
    const { run, github } = await setup();
    github.ownerType = "Organization";
    const { result } = await run();
    const error = await failure(result);
    expect(error.hint).toContain(`https://github.com/organizations/${owner}/settings/pages`);
  });

  it("names the repository in the Pages plan's title", async () => {
    const { run } = await setup();
    const { handler, result } = await run({ pagesVerification: VERIFICATION });
    await result;
    expect(handler.requests[0]?.title).toBe(
      `Apply the Pages plan to the GitHub Pages site of ${owner}/${repo} (2 changes)`,
    );
  });

  it("with the scheduled check: its files (HTTPS and certificate only) and its webhook, no key", async () => {
    const s = await setup();
    const file = join(s.root, "opscrew/plan.yaml");
    await writeArtifact("plan", file, {
      ...(await readArtifact("plan", file)),
      observability: { check: { enabled: true, webhook: "discord" } },
    });
    s.env.OPSCREW_CHECK_WEBHOOK = WEBHOOK;
    const { deps, handler, result } = await s.run({ pagesVerification: VERIFICATION });
    await result;
    const config = JSON.parse(await readFile(join(s.root, "opscrew/check/check.json"), "utf8"));
    expect(config.environments).toEqual([
      { key: "example-app/prod", hosts: [{ hostname: "docs.example.com", healthPath: "/" }] },
    ]);
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-check.yml"), "utf8");
    expect(workflow).not.toContain("OPSCREW_CHECK_SSH_KEY");
    expect(s.log).toContain("github secret OPSCREW_CHECK_WEBHOOK");
    expect(s.github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(WEBHOOK);
    expect(s.github.secrets.has("OPSCREW_CHECK_SSH_KEY")).toBe(false);
    expect(handler.requests.map((r) => r.kind)).not.toContain("host-apply");
    const said = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
    expect(said).not.toContain(WEBHOOK);
  });
});
