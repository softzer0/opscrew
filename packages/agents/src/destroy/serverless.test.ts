import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest, FetchLike, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { pagesVerificationRootDir } from "@opscrew/iac-templates";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision/run";
import { pagesPlanHash, planPagesTeardown } from "../serverless/pages/plan";
import { pagesVerificationStateFile } from "../shared";
import {
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
} from "../testing";
import {
  createPagesProject,
  fakeGithubPages,
  LoggedGitHub,
  PAGES_REPO,
  PagesEngine,
  type PagesPlanOptions,
  pagesTestPlan,
} from "../testing/pages";
import { createSiteProject, sitePlan, workerCreate, workerPlanJson } from "../testing/serverless";
import { plainState, plainStateResources } from "../testing/state";
import { runDestroy } from "./run";
import type { DestroyPreview } from "./types";

const CF_TOKEN = fakeSecret("cloudflare-token", "destroy-site-main");
const DEPLOY_TOKEN = fakeSecret("cloudflare-token", "destroy-site-deploy");
const GITHUB_TOKEN = fakeSecret("github-token", "destroy-pages");
const API_KEY = fakeSecret("stripe-live-key", "destroy-site-app");
const REDIRECT = "http_request_dynamic_redirect";
const WAF = "http_request_firewall_custom";
/** A value of GitHub's verification record, as its settings page shows one. */
const VERIFICATION = "a1b2c3d4e5f60718293a4b5c6d7e8f";

/** The error `work` stopped with. */
async function failure(work: Promise<unknown>): Promise<OpsCrewError> {
  const error = await work.then(() => undefined).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The kinds of the approvals asked for, in order. */
const kinds = (handler: ScriptedApprovalHandler) => handler.requests.map((r) => r.kind);

/** The request of `kind`, which must be there. */
function request(handler: ScriptedApprovalHandler, kind: ApprovalRequest["kind"]): ApprovalRequest {
  const found = handler.requests.find((r) => r.kind === kind);
  expect(found, kind).toBeDefined();
  return found as ApprovalRequest;
}

/** Writes a state file holding one managed resource, as an apply leaves it. */
async function writeState(file: string, type: string, name: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, plainState([{ mode: "managed", type, name, instances: [{}] }]));
}

/** An app on Cloudflare's hosting (`example.com` with `www`), provisioned with fakes. */
async function cloudflareSite() {
  const plan = sitePlan({ domain: "example.com", www: true, env: ["API_KEY"] });
  const project = await createSiteProject(plan);
  await writeFile(join(project.root, "production.env"), `API_KEY=${API_KEY}\n`);
  const zone = new FakeZone();
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler(() => true),
    fetch: zone.fetch,
  });
  await runProvision(deps, {
    services: {
      engine: async () =>
        new FakeEngine({
          changes: workerCreate(plan),
          planJson: workerPlanJson(plan),
          outputs: { url: "https://example.com" },
        }),
      github: new FakeGitHub(),
      cloudflare: fakeCloudflare(),
      sharedCloudflare: fakeSharedCloudflare(zone),
      sleep: async () => undefined,
    },
  });
  await writeState(tfstateFile(deps.paths), "cloudflare_workers_script", "this");

  /** One destroy run with fakes that log each change in `events`, in order. */
  const destroy = async (
    o: {
      answer?: (r: ApprovalRequest) => boolean;
      confirm?: boolean;
      /** What the state still holds (default: the Worker, its domains and its settings). */
      resources?: ResourceChange[];
    } = {},
  ) => {
    const events: string[] = [];
    const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
    const run = await createTestPhaseDeps({
      root: project.root,
      env,
      runner: projectRunner(),
      approvalHandler: handler,
      fetch: zone.fetch,
    });
    run.redactor.addLiteral(CF_TOKEN, "CLOUDFLARE_API_TOKEN");
    const logged: FetchLike = async (input, init) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") events.push(`cloudflare ${method} ${new URL(String(input)).pathname}`);
      return zone.fetch(input, init);
    };
    const engine = new ScriptedDestroyEngine(
      {
        resources:
          o.resources ?? workerCreate(plan).map((c) => ({ ...c, action: "delete" as const })),
      },
      events,
    );
    const github = new FakeDestroyGitHub(events);
    const previews: DestroyPreview[] = [];
    const result = runDestroy(run, {
      services: {
        engine: async () => engine,
        github,
        cloudflare: fakeCloudflare(),
        sharedCloudflare: new CloudflareClient({
          token: fakeSecret("cloudflare-token", "destroy-shared"),
          fetch: logged,
          sleep: async () => undefined,
        }),
        sleep: async () => undefined,
      },
      confirm: async (preview) => {
        previews.push(preview);
        return o.confirm ?? true;
      },
    });
    return { run, handler, events, engine, github, previews, result };
  };
  return { ...project, plan, zone, deps, destroy };
}

describe.skipIf(!findExecutable("git"))("destroy on Cloudflare's hosting", () => {
  it("removes the www redirect, then the Worker and its custom domains, then the deploy secrets", async () => {
    const site = await cloudflareSite();
    expect(site.zone.opscrewRule(REDIRECT)).toBeDefined();
    const { run, handler, events, engine, github, previews, result } = await site.destroy();
    const outcome = await result;

    // The typed name first, for the Worker's resources and this app's hostnames in the rules.
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      name: "example-app",
      provider: "cloudflare-workers",
      resources: expect.arrayContaining([
        expect.objectContaining({ address: "module.worker.cloudflare_workers_script.this" }),
      ]),
      cloudflarePlan: expect.stringContaining("www.example.com"),
    });
    expect(previews[0]?.confirmPrompt).toBe(
      "Type example-app (the app's name) to remove the app as listed above (anything else cancels)",
    );

    // Every plan approved by its hash with the typed name; nothing changes before both are.
    expect(kinds(handler)).toEqual(["iac-apply", "cloudflare-apply", "github-secrets"]);
    const iac = request(handler, "iac-apply");
    expect(iac).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
    expect(iac.title).toBe(
      "Delete the Worker of example-app and its custom domains on Cloudflare (5 resources to delete)",
    );
    expect(engine.applied.map((a) => a.approval)).toEqual([
      { approvedPlanHash: iac.planHash, allowDestroy: true },
    ]);
    expect(request(handler, "cloudflare-apply")).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "example-app",
    });

    // The order on the fakes' log: the redirect rule, the Worker, then the GitHub secrets.
    const firstRule = events.findIndex((e) => e.startsWith("cloudflare "));
    const lastRule = events.findLastIndex((e) => e.startsWith("cloudflare "));
    const worker = events.indexOf("apply:destroy");
    const firstSecret = events.findIndex((e) => e.startsWith("secret:"));
    expect(firstRule).toBeGreaterThanOrEqual(0);
    expect(lastRule).toBeLessThan(worker);
    expect(worker).toBeLessThan(firstSecret);
    expect(site.zone.opscrewRule(REDIRECT)).toBeUndefined();
    expect(site.zone.opscrewRule(WAF)).toBeUndefined();
    expect(github.deleted.sort()).toEqual([
      "OPSCREW_CLOUDFLARE_ACCOUNT_ID",
      "OPSCREW_CLOUDFLARE_API_TOKEN",
      "OPSCREW_ENV_API_KEY",
    ]);

    // OpsCrew's record, and what remains.
    const plan = await readArtifact("plan", run.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.deployment.url).toBeUndefined();
    expect(plan.approvals.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["iac-apply", "cloudflare-apply"]),
    );
    expect(outcome.secretsRemoved.sort()).toEqual(github.deleted.sort());
    expect(outcome.remaining.join("\n")).toContain("OPSCREW_CLOUDFLARE_DEPLOY_TOKEN");
    expect(outcome.remaining.join("\n")).toContain(
      "opscrew/ and .github/workflows/opscrew-deploy.yml",
    );
    const text = `${run.reporter.text()}\n${JSON.stringify(handler.requests)}\n${JSON.stringify(run.audit.entries)}`;
    for (const secret of [CF_TOKEN, DEPLOY_TOKEN, API_KEY]) expect(text).not.toContain(secret);

    // A second run finds nothing left.
    const again = await site.destroy({ resources: [] });
    expect((await failure(again.result)).message).toBe(
      "Nothing is deployed for this project, so there is nothing to destroy.",
    );
  });

  it("changes nothing when the name is not typed or the Worker's plan is refused", async () => {
    const site = await cloudflareSite();
    const unconfirmed = await site.destroy({ confirm: false });
    expect((await failure(unconfirmed.result)).code).toBe("APPROVAL_REFUSED");
    expect(unconfirmed.handler.requests).toEqual([]);

    const refused = await site.destroy({ answer: (r) => r.kind !== "iac-apply" });
    const error = await failure(refused.result);
    expect(error.message).toBe("The teardown was not approved. Nothing was deleted.");
    expect(kinds(refused.handler)).toEqual(["iac-apply"]);
    for (const run of [unconfirmed, refused]) {
      expect(run.events.filter((e) => !e.startsWith("plan:"))).toEqual([]);
    }
    expect(site.zone.opscrewRule(REDIRECT)).toBeDefined();
  });

  it("deletes nothing when the shared rules' plan is refused after the Worker's was approved", async () => {
    const site = await cloudflareSite();
    const refused = await site.destroy({ answer: (r) => r.kind !== "cloudflare-apply" });
    expect((await failure(refused.result)).code).toBe("APPROVAL_REFUSED");
    expect(kinds(refused.handler)).toEqual(["iac-apply", "cloudflare-apply"]);
    expect(refused.events).not.toContain("apply:destroy");
    expect(refused.events.filter((e) => !e.startsWith("plan:"))).toEqual([]);
    expect(site.zone.opscrewRule(REDIRECT)).toBeDefined();
    expect(refused.github.deleted).toEqual([]);
  });
});

/** A site on GitHub Pages, provisioned with fakes (DNS records and the verification record). */
async function pagesSite(options: PagesPlanOptions = {}) {
  const plan = pagesTestPlan(options);
  const project = await createPagesProject(plan);
  const log: string[] = [];
  const pages = fakeGithubPages({ log });
  const engine = new PagesEngine(log, project.root);
  const cloudflare = fakeCloudflare();
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    GITHUB_TOKEN,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  await writeFile(join(project.root, "production.env"), `API_KEY=${API_KEY}\n`);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler(() => true),
    fetch: pages.fetch,
  });
  await runProvision(deps, {
    pagesVerification: VERIFICATION,
    services: {
      engine: async () => engine,
      github: new LoggedGitHub(log),
      cloudflare,
      sleep: async () => undefined,
    },
  });
  // The states the applies left: the site's records, and GitHub's verification record.
  await writeState(tfstateFile(deps.paths), "cloudflare_dns_record", "cname");
  await writeState(pagesVerificationStateFile(deps.paths), "cloudflare_dns_record", "verification");
  const destroyed = await readArtifact("plan", deps.paths.files.plan);

  /** One destroy run; its changes go into the shared `log`. */
  const destroy = async (
    o: { answer?: (r: ApprovalRequest) => boolean; deleteVerification?: boolean } = {},
  ) => {
    log.length = 0;
    const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
    const run = await createTestPhaseDeps({
      root: project.root,
      env,
      runner: projectRunner(),
      approvalHandler: handler,
      fetch: pages.fetch,
    });
    const github = new FakeDestroyGitHub(log);
    const previews: DestroyPreview[] = [];
    const result = runDestroy(run, {
      services: { engine: async () => engine, github, cloudflare },
      confirm: async (preview) => {
        previews.push(preview);
        return true;
      },
      ...(o.deleteVerification === true ? { deleteVerification: true } : {}),
    });
    return { run, handler, github, previews, result };
  };
  return { ...project, plan: destroyed, log, pages, engine, deps, destroy };
}

/** The requests that change GitHub Pages, the IaC applies and the deleted secrets. */
const changes = (log: readonly string[]) =>
  log.filter((line) => /^(pages (POST|PUT|DELETE)|engine apply|secret:)/.test(line));

/** The managed resources the state file holds. */
const held = (file: string) => plainStateResources(file);

describe.skipIf(!findExecutable("git"))("destroy on GitHub Pages", () => {
  it("removes the DNS records while the site claims the domain, then the site, keeping the verification record", async () => {
    const site = await pagesSite({ env: ["API_KEY"] });
    const dnsRoot = site.plan.infra.dir;
    // What the Pages plan will be, from the site as GitHub reports it now.
    const teardown = planPagesTeardown({
      ...PAGES_REPO,
      site: { buildType: "workflow", cname: "docs.example.com", httpsEnforced: false },
      environment: true,
    });
    const { run, handler, github, previews, result } = await site.destroy();
    const outcome = await result;

    expect(previews[0]).toMatchObject({
      provider: "github-pages",
      pagesChanges: [
        "Remove the custom domain docs.example.com from the site",
        `Turn GitHub Pages off for ${PAGES_REPO.owner}/${PAGES_REPO.repo}`,
        "Delete the GitHub environment github-pages",
      ],
    });
    // No DNS record points at GitHub while no site claims the domain (SC-1605): the records
    // go first, then the domain, the site and its environment; the verification record stays.
    expect(changes(site.log)).toEqual([
      `engine apply -destroy ${dnsRoot}`,
      `pages PUT /pages {"cname":null}`,
      "pages DELETE /pages",
      "pages DELETE /environments/github-pages",
      "secret:OPSCREW_ENV_API_KEY",
    ]);
    expect(site.pages.state).toMatchObject({ environment: false });
    expect(site.pages.state.site).toBeUndefined();
    expect(github.deleted).toEqual(["OPSCREW_ENV_API_KEY"]);

    // Each plan approved by its hash, with allowDestroy and the typed name.
    expect(kinds(handler)).toEqual(["iac-apply", "pages-apply", "github-secrets"]);
    expect(request(handler, "iac-apply")).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(request(handler, "pages-apply")).toMatchObject({
      planHash: pagesPlanHash(teardown),
      allowDestroy: true,
      confirmPhrase: "example-app",
    });
    expect(site.engine.applied.at(-1)?.approval).toEqual({
      approvedPlanHash: request(handler, "iac-apply").planHash,
      allowDestroy: true,
    });

    // The verification record and its state stay, and what remains says how to delete it.
    expect(await held(pagesVerificationStateFile(run.paths))).toEqual([
      "cloudflare_dns_record.verification",
    ]);
    expect(await held(tfstateFile(run.paths))).toEqual([]);
    const remaining = outcome.remaining.join("\n");
    expect(remaining).toContain(
      `GitHub's domain verification record _github-pages-challenge-${PAGES_REPO.owner}.docs.example.com stays`,
    );
    expect(remaining).toContain("opscrew destroy --delete-verification");
    const plan = await readArtifact("plan", run.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.approvals.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["iac-apply", "pages-apply"]),
    );
    const text = `${run.reporter.text()}\n${JSON.stringify(handler.requests)}`;
    for (const secret of [GITHUB_TOKEN, CF_TOKEN, API_KEY]) expect(text).not.toContain(secret);

    // Later, --delete-verification deletes only the verification record; its state then holds
    // nothing, so `opscrew app remove` can go ahead.
    const later = await site.destroy({ deleteVerification: true });
    await later.result;
    expect(changes(site.log)).toEqual([
      `engine apply -destroy ${pagesVerificationRootDir(site.plan)}`,
    ]);
    expect(kinds(later.handler)).toEqual(["iac-apply"]);
    expect(await held(pagesVerificationStateFile(run.paths))).toEqual([]);
    expect(later.run.audit.entries.find((e) => e.action === "destroy")?.detail).toBe(
      "GitHub's verification record for docs.example.com deleted",
    );
  });

  it("with --delete-verification, deletes the verification record last", async () => {
    const site = await pagesSite();
    const { handler, result, run } = await site.destroy({ deleteVerification: true });
    const outcome = await result;
    expect(changes(site.log)).toEqual([
      `engine apply -destroy ${site.plan.infra.dir}`,
      `pages PUT /pages {"cname":null}`,
      "pages DELETE /pages",
      "pages DELETE /environments/github-pages",
      `engine apply -destroy ${pagesVerificationRootDir(site.plan)}`,
    ]);
    // A site without values has no deploy secrets to remove.
    expect(kinds(handler)).toEqual(["iac-apply", "pages-apply", "iac-apply"]);
    const verification = handler.requests[2] as ApprovalRequest;
    expect(verification).toMatchObject({ allowDestroy: true, confirmPhrase: "example-app" });
    expect(verification.title).toBe(
      "Delete GitHub's domain verification record for docs.example.com on Cloudflare (1 resource to delete)",
    );
    expect(await held(pagesVerificationStateFile(run.paths))).toEqual([]);
    expect(outcome.remaining.join("\n")).not.toContain("verification record");
    expect(outcome.destroyed.map((c) => c.address)).toEqual([
      "module.dns.cloudflare_dns_record.cname",
      "cloudflare_dns_record.verification",
    ]);
  });

  it("a refused Pages plan leaves the site claiming the domain, and the next run finishes", async () => {
    const site = await pagesSite();
    const refused = await site.destroy({ answer: (r) => r.kind !== "pages-apply" });
    const error = await failure(refused.result);
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      "The Pages plan was not approved. The DNS records of docs.example.com are deleted; the GitHub Pages site still claims docs.example.com, so no other site can take it over.",
    );
    expect(error.hint).toBe("Run `opscrew destroy` again and type example-app when you are ready.");
    expect(changes(site.log)).toEqual([`engine apply -destroy ${site.plan.infra.dir}`]);
    expect(site.pages.state.site?.cname).toBe("docs.example.com");

    const again = await site.destroy();
    await again.result;
    expect(changes(site.log)).toEqual([
      `pages PUT /pages {"cname":null}`,
      "pages DELETE /pages",
      "pages DELETE /environments/github-pages",
    ]);
    expect(kinds(again.handler)).toEqual(["pages-apply"]);
  });
});
