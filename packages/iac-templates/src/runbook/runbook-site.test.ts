import { describe, expect, it } from "vitest";
import { cloudflarePlan, pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { renderSiteRunbook } from "./index";

const ctx = { opscrewVersion: "0.1.0", owner: "Example-Org" } as const;

/** Nothing of a server: no SSH, Docker, image or server words. */
function expectNoServer(text: string): void {
  expect(text).not.toMatch(/\bssh\b|docker|ghcr|compose|deploy key|the server/i);
}

describe("renderSiteRunbook on Cloudflare's hosting", () => {
  it("covers deploys, status, rollback and destroy of a static site", () => {
    const file = renderSiteRunbook(cloudflarePlan(), ctx);
    const text = file.content;

    expect(file).toMatchObject({ path: "opscrew/RUNBOOK.md", kind: "doc" });
    expect(text).toContain("# Runbook: example-app");
    expect(text).toContain("Run `opscrew verify` to refresh it.");
    expect(text).toContain("| App | https://docs.example.com |");
    expect(text).toContain("the Worker `example-app`");
    expect(text).toContain("`opscrew/cloudflare/wrangler.jsonc`");
    expect(text).toContain("every push to `main` runs `.github/workflows/opscrew-deploy.yml`");
    // The deploy and its automatic rollback.
    expect(text).toContain("20,000 files a version may have on Cloudflare's free plan");
    expect(text).toContain("`opscrew <run id> <sha256>`");
    expect(text).toContain("activates the version that ran before again and the run fails");
    // Status and the rollback by version id, with no build.
    expect(text).toContain("`opscrew status` reads the Worker's deployments from Cloudflare");
    expect(text).toContain("`opscrew promote --to prod --version <id>`");
    expect(text).toContain("within a minute, with no build");
    expect(text).toContain("`--yes` never approves it");
    // Destroy, in its order, and what remains.
    expect(text).toContain("`opscrew destroy`");
    expect(text).toContain("`--confirm example-app`");
    expect(text).toContain("the Worker's custom domains and the Worker");
    expect(text).toContain("its secrets go with it");
    expect(text).toContain("the deploy token you created");
    expect(text).toContain("OpsCrew never deletes tokens");
    // Its deploy secrets in GitHub, by name only.
    expect(text).toContain("`OPSCREW_CLOUDFLARE_API_TOKEN`");
    expect(text).toContain("`OPSCREW_CLOUDFLARE_ACCOUNT_ID`");
    expect(text).toContain("No monthly cost");
    expectNoServer(text);
  });

  it("names the headers wrapper and the app's secrets of a server-rendered site", () => {
    const text = renderSiteRunbook(ssrPlan({ env: ["API_KEY"] }), ctx).content;

    expect(text).toContain("server-rendered by `dist/server/entry.mjs`");
    expect(text).toContain("`opscrew/cloudflare/headers-entry.js`");
    expect(text).toContain("`OPSCREW_ENV_API_KEY`");
    expect(text).toContain("the deploy job gives them to the new version");
    expect(text).toContain("Workers & Pages → the Worker → Logs");
    expectNoServer(text);
  });

  it("names Workers Paid's files per version when the design chose it", () => {
    const plan = ssrPlan();
    const monthly = { amount: 5, currency: "USD" } as const;
    const text = renderSiteRunbook({ ...plan, cost: { ...plan.cost, monthly } }, ctx).content;
    expect(text).toContain("100,000 files a version may have on Cloudflare's Workers Paid plan");
    expect(text).toContain("$5.00 per month");
  });

  it("says that `www` redirects to the domain", () => {
    const plan = cloudflarePlan();
    const text = renderSiteRunbook({ ...plan, dns: { ...plan.dns, www: true } }, ctx).content;
    expect(text).toContain("www.docs.example.com (redirects to docs.example.com)");
    expect(text).toContain("the `www` redirect");
  });

  it("explains promotion by the build's SHA-256 for a promoted environment", () => {
    const text = renderSiteRunbook(ssrPlan({ promotedFrom: "staging", env: ["API_KEY"] }), {
      ...ctx,
      environments: ["prod", "staging"],
    }).content;

    expect(text).toContain("only by `opscrew promote --to prod`");
    expect(text).toContain("the build the `staging` environment runs");
    expect(text).toContain("refuses it unless its SHA-256 matches");
    expect(text).toContain("90 days by default");
    expect(text).toContain("Nothing is rebuilt.");
    // No build of its own: only the deploy job reads the app's values.
    expect(text).toContain("The deploy job gives them to the new version as its secrets.");
    expect(text).not.toContain("The build reads them");
    expect(text).not.toContain("| Build |");
    expect(text).toContain(
      "push it to `main`, let the `staging` environment deploy it, then promote it",
    );
    // Beside other environments, every command names prod.
    expect(text).toContain("`opscrew destroy --env prod`");
    expect(text).toContain("`opscrew promote --to prod --version <id>`");
  });

  it("is the environment's own runbook, with its own commands", () => {
    const file = renderSiteRunbook(cloudflarePlan({ environment: "staging" }), {
      ...ctx,
      environments: ["prod", "staging"],
    });
    expect(file.path).toBe("opscrew/environments/staging/RUNBOOK.md");
    expect(file.content).toContain("`opscrew status --env staging`");
    expect(file.content).toContain("`opscrew promote --to staging --version <id>`");
    expect(file.content).toContain("`opscrew/environments/staging/cloudflare/wrangler.jsonc`");
  });
});

describe("renderSiteRunbook on GitHub Pages", () => {
  it("covers deploys, status, rollback by re-run and destroy in the takeover-safe order", () => {
    const text = renderSiteRunbook(pagesPlan({ env: ["PUBLIC_URL"] }), ctx).content;

    expect(text).toContain("| App | https://docs.example.com |");
    expect(text).toContain("GitHub Pages");
    expect(text).toContain("1 GB");
    expect(text).toContain("DNS only");
    // The build's values are public once in the site.
    expect(text).toContain("`OPSCREW_ENV_PUBLIC_URL`");
    expect(text).toContain("anyone can read");
    // Status and the rollback by re-run.
    expect(text).toContain("`opscrew status` reads the GitHub Pages site");
    expect(text).toContain("`opscrew promote --to prod --version <run id>`");
    expect(text).toContain("builds the site again from that run's commit");
    expect(text).toContain("last 30 days");
    expect(text).toContain(
      "is refused: GitHub Pages has only prod, which builds its own site;\n  roll back with `--version <run id>`.",
    );
    // The manual step and HTTPS.
    expect(text).toContain("https://github.com/settings/pages");
    expect(text).toContain("https://github.com/organizations/Example-Org/settings/pages");
    expect(text).toContain("click **Verify**");
    expect(text).toContain("enforces HTTPS");
    expect(text).toContain("cannot set security headers");
    // Destroy: the records first, then the site; the verification record stays unless asked.
    expect(text).toContain("deletes the site's DNS records first");
    expect(text).toContain("`github-pages` environment");
    expect(text).toContain("`_github-pages-challenge-example-org.docs.example.com`");
    expect(text).toContain("`opscrew destroy --delete-verification`");
    expect(text).not.toContain("Worker");
    expectNoServer(text);
  });

  it("names the owner as a placeholder when the repository is not known", () => {
    const text = renderSiteRunbook(pagesPlan(), { opscrewVersion: "0.1.0" }).content;
    expect(text).toContain("`_github-pages-challenge-<owner>.docs.example.com`");
  });
});
