import { describe, expect, it } from "vitest";
import { sitePlan } from "../testing/serverless";
import { deploySetupPullRequestBody } from "./publish";

describe("the deploy pull request for a site with no server", () => {
  it("Cloudflare: the Worker's shell and domains, its settings, the workflow and the plan", () => {
    const body = deploySetupPullRequestBody(sitePlan(), "1.2.3");
    expect(body).toContain("**example-app**, which Cloudflare serves with no server");
    expect(body).toContain(
      "- `opscrew/infra/prod/` and `opscrew/infra/modules/`: the Worker example-app's shell and a custom domain for each hostname",
    );
    expect(body).toContain("- `opscrew/cloudflare/`: the Worker's settings for Wrangler");
    expect(body).not.toContain("security headers to the pages the Worker renders");
    expect(body).toContain(
      "- `.github/workflows/opscrew-deploy.yml`: builds the site on every push to `main` and uploads it to Cloudflare",
    );
    expect(body).toContain("**Merging this pull request deploys the app to docs.example.com.**");
    expect(body).toContain(
      "- [ ] The Worker's settings in `opscrew/cloudflare/wrangler.jsonc` match what you expect.",
    );
    expect(body).toContain("Opened by OpsCrew 1.2.3.");
    // Nothing about servers.
    expect(body).not.toMatch(/server is|firewall|Docker Compose|IP address|image/);
  });

  it("Cloudflare with server rendering names the headers module; a promoted environment never builds", () => {
    expect(deploySetupPullRequestBody(sitePlan({ render: "ssr" }), "1.2.3")).toContain(
      "and the module that adds OpsCrew's security headers to the pages the Worker renders.",
    );
    const prod = sitePlan({ promotedFrom: "staging" });
    expect(deploySetupPullRequestBody(prod, "1.2.3")).toContain(
      "deploys the build the `staging` environment runs, started with `opscrew promote --to prod` (it never builds)",
    );
  });

  it("GitHub Pages: the DNS records, the verification record, the workflow and the plan, the Verify step and HTTPS, and the terminal step without secrets", () => {
    const body = deploySetupPullRequestBody(sitePlan({ provider: "github-pages" }), "1.2.3", {
      secretsStored: false,
    });
    expect(body).toContain("**example-app**, which GitHub Pages serves with no server");
    expect(body).toContain(
      "the site's DNS records at Cloudflare, all DNS only, since Cloudflare's proxy would stop GitHub from issuing and renewing the site's certificate",
    );
    expect(body).toContain("so no record points at GitHub while no site claims it.");
    expect(body).toContain(
      "- `opscrew/infra/github-pages-verification/`: GitHub's domain verification record, a TXT record in a root of its own",
    );
    expect(body).toContain("publishes it to GitHub Pages.");
    expect(body).toContain(
      "The GitHub Pages site and its DNS records are set up, but OpsCrew has no record",
    );
    expect(body).toContain(
      "One step is yours, because GitHub has no API for it: once the verification record resolves, click Verify next to docs.example.com",
    );
    expect(body).toContain("run `opscrew provision` again then to enforce HTTPS");
    expect(body).toContain(
      "- [ ] The DNS records in the infrastructure code match what you expect.",
    );
    expect(body).not.toMatch(/Worker|wrangler|server is|firewall/);
  });
});
