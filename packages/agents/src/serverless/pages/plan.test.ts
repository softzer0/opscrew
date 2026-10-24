import { GitHubClient } from "@opscrew/connector-github";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type FakePagesOptions, fakeGithubPages, PAGES_REPO } from "../../testing/pages";
import {
  applyPagesPlan,
  describePagesPlan,
  PagesApplyError,
  type PagesPlan,
  pagesPlanDeletes,
  pagesPlanHash,
  planPages,
  planPagesTeardown,
} from "./plan";

const DOMAIN = "docs.example.com";
const COMMAND = "opscrew provision";
const { owner, repo } = PAGES_REPO;

/** The steps from `site` to the site OpsCrew wants. */
function steps(input: Partial<Parameters<typeof planPages>[0]> = {}) {
  return planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false, ...input })
    .steps;
}

const WITH_DOMAIN = { buildType: "workflow", cname: DOMAIN, httpsEnforced: false } as const;

describe("planPages", () => {
  it("turns Pages on with the workflow, then sets the domain, for a repository without Pages", () => {
    expect(steps()).toEqual([{ kind: "create" }, { kind: "set-domain", cname: DOMAIN }]);
  });

  it("shows a site published from a branch as a change to the workflow source", () => {
    expect(steps({ site: { buildType: "legacy", httpsEnforced: false } })).toEqual([
      { kind: "use-workflow" },
      { kind: "set-domain", cname: DOMAIN },
    ]);
    expect(steps({ site: { ...WITH_DOMAIN, buildType: "legacy" } })).toEqual([
      { kind: "use-workflow" },
    ]);
  });

  it("replaces another custom domain, which takes it away from the site", () => {
    const plan = planPages({
      owner,
      repo,
      site: { ...WITH_DOMAIN, cname: "old.example.com" },
      cname: DOMAIN,
      savedAgain: false,
    });
    expect(plan.steps).toEqual([
      { kind: "set-domain", cname: DOMAIN, replaces: "old.example.com" },
    ]);
    expect(pagesPlanDeletes(plan)).toBe(true);
    expect(
      pagesPlanDeletes(
        planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false }),
      ),
    ).toBe(false);
  });

  it("changes nothing while GitHub has not checked the domain's DNS records", () => {
    expect(steps({ site: WITH_DOMAIN })).toEqual([]);
    expect(
      steps({ site: WITH_DOMAIN, health: { dns: "pending", certificate: "pending" } }),
    ).toEqual([]);
    expect(steps({ site: WITH_DOMAIN, health: { dns: "error", certificate: "error" } })).toEqual(
      [],
    );
  });

  it("saves the domain again once the DNS is valid without a certificate, and only once", () => {
    const health = { dns: "ok", certificate: "pending" } as const;
    expect(steps({ site: WITH_DOMAIN, health })).toEqual([
      { kind: "save-domain-again", cname: DOMAIN },
    ]);
    expect(steps({ site: WITH_DOMAIN, health, savedAgain: true })).toEqual([]);
  });

  it("enforces HTTPS once the certificate is issued", () => {
    const health = { dns: "ok", certificate: "issued" } as const;
    expect(steps({ site: WITH_DOMAIN, health })).toEqual([{ kind: "enforce-https" }]);
    expect(steps({ site: { ...WITH_DOMAIN, httpsEnforced: true }, health })).toEqual([]);
  });

  it("compares the domain in any case", () => {
    expect(steps({ site: { ...WITH_DOMAIN, cname: "Docs.Example.com" } })).toEqual([]);
  });
});

describe("pagesPlanHash", () => {
  const plan = planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false });

  it("covers the steps and the site they start from, in canonical JSON", () => {
    const hash = pagesPlanHash(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { steps: plan.steps, site: plan.site, repo, owner } as PagesPlan;
    expect(pagesPlanHash(reordered)).toBe(hash);
    expect(pagesPlanHash({ ...plan, steps: [{ kind: "create" }] })).not.toBe(hash);
    expect(
      pagesPlanHash({
        ...plan,
        site: { enabled: true, buildType: "legacy", httpsEnforced: false },
      }),
    ).not.toBe(hash);
  });
});

describe("describePagesPlan", () => {
  it("says why the domain comes before its DNS records, and ends with the hash", () => {
    const plan = planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false });
    const text = describePagesPlan(plan, pagesPlanHash(plan));
    expect(text).toContain(`Pages plan for the GitHub Pages site of ${owner}/${repo}: 2 to change`);
    expect(text).toContain("published by OpsCrew's deploy workflow");
    expect(text).toContain("no record ever points at GitHub while no site claims the domain");
    expect(text.endsWith(`Pages plan hash: ${pagesPlanHash(plan)}`)).toBe(true);
  });

  it("shows saving the domain again with its second's gap", () => {
    const plan = planPages({
      owner,
      repo,
      site: WITH_DOMAIN,
      cname: DOMAIN,
      health: { dns: "ok", certificate: "pending" },
      savedAgain: false,
    });
    const text = describePagesPlan(plan, pagesPlanHash(plan));
    expect(text).toContain(`✓ Custom domain ${DOMAIN} (already in place)`);
    expect(text).toContain("so GitHub requests the site's certificate");
    expect(text).toContain("about a second apart");
    expect(text).toContain("Verifying the domain in your GitHub settings removes even that");
  });
});

/** A GitHub client on the fake Pages server, and its log. */
function client(options: FakePagesOptions = {}, wrap?: (fetch: FetchLike) => FetchLike) {
  const pages = fakeGithubPages(options);
  const fetch = wrap === undefined ? pages.fetch : wrap(pages.fetch);
  return { pages, api: new GitHubClient({ token: fakeSecret("github-token", "pages"), fetch }) };
}

/** The requests that change the site. */
const changes = (log: readonly string[]) =>
  log.filter((line) => /^pages (POST|PUT|DELETE) /.test(line));

describe("applyPagesPlan", () => {
  it("turns Pages on and sets the domain, in order", async () => {
    const { pages, api } = client();
    const plan = planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false });
    const applied = await applyPagesPlan(api, plan, {
      approvedHash: pagesPlanHash(plan),
      command: COMMAND,
    });
    expect(applied).toEqual(["create", "set-domain"]);
    expect(changes(pages.log)).toEqual([
      `pages POST /pages {"build_type":"workflow"}`,
      `pages PUT /pages {"cname":"${DOMAIN}"}`,
    ]);
    expect(pages.state.site).toEqual({
      buildType: "workflow",
      cname: DOMAIN,
      httpsEnforced: false,
    });
  });

  it("switches a site from a branch to the workflow without deleting it", async () => {
    const { pages, api } = client({ site: { ...WITH_DOMAIN, buildType: "legacy" } });
    const site = await api.getPages(owner, repo);
    const plan = planPages({ owner, repo, site, cname: DOMAIN, savedAgain: false });
    await applyPagesPlan(api, plan, { approvedHash: pagesPlanHash(plan), command: COMMAND });
    expect(changes(pages.log)).toEqual([`pages PUT /pages {"build_type":"workflow"}`]);
    expect(pages.state.site).toEqual(WITH_DOMAIN);
  });

  it("saves the domain again: removed, then set straight back", async () => {
    const { pages, api } = client({ site: { ...WITH_DOMAIN }, health: "dns-ok" });
    const plan = planPages({
      owner,
      repo,
      site: await api.getPages(owner, repo),
      cname: DOMAIN,
      health: { dns: "ok", certificate: "pending" },
      savedAgain: false,
    });
    await applyPagesPlan(api, plan, { approvedHash: pagesPlanHash(plan), command: COMMAND });
    expect(changes(pages.log)).toEqual([
      `pages PUT /pages {"cname":null}`,
      `pages PUT /pages {"cname":"${DOMAIN}"}`,
    ]);
    expect(pages.state.site?.cname).toBe(DOMAIN);
  });

  it("refuses a plan that is not the approved one, before any request", async () => {
    const { pages, api } = client();
    const plan = planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false });
    const error = await applyPagesPlan(api, plan, {
      approvedHash: "a".repeat(64),
      command: COMMAND,
    })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PLAN_HASH_MISMATCH");
    expect(pages.log).toEqual([]);
  });

  it("reads the site again and changes nothing when it changed since the plan", async () => {
    const { pages, api } = client({ site: { buildType: "legacy", httpsEnforced: false } });
    // The plan saw no site; someone turned Pages on from a branch since.
    const plan = planPages({ owner, repo, site: undefined, cname: DOMAIN, savedAgain: false });
    const error = (await applyPagesPlan(api, plan, {
      approvedHash: pagesPlanHash(plan),
      command: COMMAND,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("changed after this Pages plan was made: it was off");
    expect(error.message).toContain("on, built from a branch, with no custom domain now");
    expect(error.message).toContain("OpsCrew changed nothing");
    expect(changes(pages.log)).toEqual([]);
  });

  it("stops at HTTPS before the certificate exists, saying what was done", async () => {
    const { api } = client({ site: { ...WITH_DOMAIN }, health: "dns-ok" });
    const plan: PagesPlan = {
      owner,
      repo,
      site: { enabled: true, ...WITH_DOMAIN },
      steps: [{ kind: "enforce-https" }],
    };
    const error = (await applyPagesPlan(api, plan, {
      approvedHash: pagesPlanHash(plan),
      command: COMMAND,
    }).catch((e: unknown) => e)) as PagesApplyError;
    expect(error).toBeInstanceOf(PagesApplyError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("The certificate does not exist yet");
    expect(error.message).toContain("Nothing was changed before it.");
    expect(error.applied).toEqual([]);
  });

  it("says the domain is unclaimed when GitHub removed it and did not take it back", async () => {
    let puts = 0;
    const { api } = client(
      { site: { ...WITH_DOMAIN }, health: "dns-ok" },
      (fetch) => async (url, init) => {
        if (init?.method === "PUT" && ++puts === 2) {
          return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
        }
        return fetch(url, init);
      },
    );
    const plan: PagesPlan = {
      owner,
      repo,
      site: { enabled: true, ...WITH_DOMAIN },
      steps: [{ kind: "save-domain-again", cname: DOMAIN }],
    };
    const error = (await applyPagesPlan(api, plan, {
      approvedHash: pagesPlanHash(plan),
      command: COMMAND,
    }).catch((e: unknown) => e)) as PagesApplyError;
    expect(error).toBeInstanceOf(PagesApplyError);
    expect(error.message).toContain(`GitHub removed the custom domain ${DOMAIN}`);
    expect(error.message).toContain("another GitHub Pages site could take the domain over");
    expect(error.hint).toContain(`Run \`${COMMAND}\` again right away`);
  });
});

describe("the teardown (opscrew destroy)", () => {
  it("removes the domain, then the site, then the github-pages environment, each only while there", () => {
    const teardown = (site: Parameters<typeof planPagesTeardown>[0]["site"], environment = true) =>
      planPagesTeardown({ owner, repo, site, environment }).steps;
    expect(teardown(WITH_DOMAIN)).toEqual([
      { kind: "remove-domain", cname: DOMAIN },
      { kind: "delete-site" },
      { kind: "delete-environment" },
    ]);
    expect(teardown({ buildType: "workflow", httpsEnforced: false })).toEqual([
      { kind: "delete-site" },
      { kind: "delete-environment" },
    ]);
    expect(teardown(undefined)).toEqual([{ kind: "delete-environment" }]);
    expect(teardown(undefined, false)).toEqual([]);
  });

  it("needs allowDestroy and says the DNS records went first", () => {
    const plan = planPagesTeardown({ owner, repo, site: WITH_DOMAIN, environment: true });
    expect(pagesPlanDeletes(plan)).toBe(true);
    const text = describePagesPlan(plan, pagesPlanHash(plan));
    expect(text).toContain(`Pages plan for the GitHub Pages site of ${owner}/${repo}: 3 to change`);
    expect(text).toContain(`Remove the custom domain ${DOMAIN} from the site`);
    expect(text).toContain("no record points at GitHub while no site claims the domain");
    expect(text).toContain(`Turn GitHub Pages off for ${owner}/${repo}`);
    expect(text).toContain("Delete the GitHub environment github-pages");
    expect(text).toContain("DNS records went with the infrastructure plan before this one");
    expect(text.endsWith(`Pages plan hash: ${pagesPlanHash(plan)}`)).toBe(true);
  });

  it("is applied in order, after the site is read again", async () => {
    const { pages, api } = client({ site: { ...WITH_DOMAIN } });
    const plan = planPagesTeardown({
      owner,
      repo,
      site: await api.getPages(owner, repo),
      environment: true,
    });
    const applied = await applyPagesPlan(api, plan, {
      approvedHash: pagesPlanHash(plan),
      command: "opscrew destroy",
    });
    expect(applied).toEqual(["remove-domain", "delete-site", "delete-environment"]);
    expect(changes(pages.log)).toEqual([
      `pages PUT /pages {"cname":null}`,
      "pages DELETE /pages",
      "pages DELETE /environments/github-pages",
    ]);
    expect(pages.state).toMatchObject({ environment: false });
    expect(pages.state.site).toBeUndefined();
  });
});
