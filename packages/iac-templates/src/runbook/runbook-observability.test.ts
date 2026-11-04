import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { withPlacement } from "../catalog/__fixtures__/plans";
import { cloudflarePlan, pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { inEnvironment, localhostPlan } from "../workflow/__fixtures__/plans";
import { renderLocalRunbook, renderRunbook, renderSiteRunbook } from "./index";

const IPV4 = "203.0.113.10";
const ctx = testContext({ projectId: "shop-0123456789ab", serverIpv4: IPV4 });
const siteCtx = { opscrewVersion: "0.1.0", owner: "Example-Org" } as const;
const HUB_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`;

/** `plan` with `observability` as `plan.yaml` holds it, through the schema (defaults filled in). */
function observed(plan: DeployPlan, observability: object): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, observability });
}

const CHECK_ON = { check: { enabled: true } } as const;

describe("the runbook's scheduled check", () => {
  it("is absent without the check, on every target", () => {
    const off = { check: { enabled: false } } as const;
    for (const plan of [
      testPlan({ domain: "example.com" }),
      observed(testPlan({ domain: "example.com" }), off),
      observed(testPlan({ provider: "own", domain: "example.com" }), off),
    ]) {
      expect(renderRunbook(plan, ctx).content).not.toContain("## The scheduled check");
    }
    for (const plan of [cloudflarePlan(), observed(pagesPlan(), off)]) {
      expect(renderSiteRunbook(plan, siteCtx).content).not.toContain("## The scheduled check");
    }
  });

  it("says what an opscrew-check issue means, how to pause it, and the disk read over SSH", () => {
    const text = renderRunbook(
      observed(testPlan({ domain: "example.com" }), CHECK_ON),
      ctx,
    ).content;
    expect(text).toContain("## The scheduled check");
    expect(text).toContain("`.github/workflows/opscrew-check.yml` checks this environment");
    expect(text).toContain("**An open issue labelled `opscrew-check`** means a check still fails");
    expect(text).toContain("`opscrew status` shows the check's state and its open issues");
    expect(text).toContain("`gh workflow disable opscrew-check.yml`");
    expect(text).toContain("`gh workflow enable opscrew-check.yml`");
    expect(text).toContain(
      "the server's free disk over SSH, with a key the server lets run only `df`",
    );
    expect(text).toContain("after 60 days without activity");
  });

  it("names this environment in its commands", () => {
    const staging = observed(
      inEnvironment(testPlan({ domain: "example.com" }), { name: "staging" }),
      CHECK_ON,
    );
    const text = renderRunbook(staging, ctx).content;
    expect(text).toContain("`opscrew status --env staging` shows the check's state");
    expect(text).toContain("`opscrew logs --env staging` the app's lines");
  });

  it("says where an own server's disk is read, or why it is not", () => {
    const tunnel = renderRunbook(
      observed(testPlan({ provider: "own", access: "tunnel", domain: "example.com" }), CHECK_ON),
      ctx,
    ).content;
    expect(tunnel).toContain("It reads no disk here: the check's SSH can't pass the tunnel's");
    const ownRunner = renderRunbook(
      observed(
        inEnvironment(testPlan({ provider: "own", access: "tunnel", domain: "example.com" }), {
          runner: "server",
        }),
        CHECK_ON,
      ),
      ctx,
    ).content;
    expect(ownRunner).toContain("read by a job on the server's own runner");
    expect(ownRunner).not.toContain("It reads no disk here");
  });

  it("checks a site's hostnames and certificates, with nothing of a server", () => {
    for (const plan of [ssrPlan(), pagesPlan()]) {
      const text = renderSiteRunbook(observed(plan, CHECK_ON), siteCtx).content;
      expect(text).toContain("## The scheduled check");
      expect(text).toContain("each certificate's days left (an issue below 14).");
      expect(text).not.toMatch(/\bssh\b|docker|disk|the server/i);
    }
  });
});

describe("the runbook's logs", () => {
  it("names `opscrew logs` and `status` when something is wrong", () => {
    for (const plan of [
      testPlan({ domain: "example.com" }),
      testPlan({ provider: "own", domain: "example.com" }),
    ]) {
      const text = renderRunbook(plan, ctx).content;
      expect(text).toContain("3. `opscrew logs` shows the app's latest log lines");
      expect(text).toContain("`opscrew status` its containers' CPU");
    }
  });

  it("names `opscrew logs` for a server-rendered site only", () => {
    expect(renderSiteRunbook(ssrPlan(), siteCtx).content).toContain(
      "3. `opscrew logs` shows the Worker's recent requests",
    );
    for (const plan of [cloudflarePlan(), pagesPlan()]) {
      expect(renderSiteRunbook(plan, siteCtx).content).not.toContain("opscrew logs");
    }
  });

  it("names `opscrew logs` on this computer", () => {
    const text = renderLocalRunbook(localhostPlan(), {
      address: "https://shop.localhost",
      file: "opscrew/RUNBOOK.md",
    }).content;
    expect(text).toContain("- The logs: `opscrew logs` (`--follow` for new lines");
  });
});

describe("the runbook's add-ons", () => {
  const beszel = { enabled: true, version: "0.21.1" } as const;
  const grafana = {
    enabled: true,
    version: "1.21.3",
    metrics: { url: "https://metrics.example.com/api/prom/push", user: "123456" },
    logs: { url: "https://logs.example.com/loki/api/v1/push", user: "654321" },
  } as const;

  it("is absent with the add-ons off", () => {
    const text = renderRunbook(
      observed(testPlan({ domain: "example.com" }), {
        beszel: { ...beszel, enabled: false },
        grafanaCloud: { enabled: false, version: "1.21.3" },
      }),
      ctx,
    ).content;
    expect(text).not.toContain("## Beszel");
    expect(text).not.toContain("## Grafana Cloud");
  });

  it("opens Beszel's dashboard through the tunnel and names its password file only", () => {
    for (const provider of ["hetzner", "own"] as const) {
      const text = renderRunbook(
        observed(testPlan({ provider, domain: "example.com" }), { beszel }),
        ctx,
      ).content;
      expect(text).toContain("## Beszel");
      expect(text).toContain("`opscrew addon open beszel` keeps an SSH tunnel to it open");
      expect(text).toContain("http://localhost:8090");
      expect(text).toContain("`admin@opscrew.invalid`");
      expect(text).toContain("`~/.opscrew/projects/shop-0123456789ab/beszel_secrets.json`");
      expect(text).toContain("never their settings or");
      expect(text).toContain("(`--keep-data` keeps the history)");
      expect(text).not.toContain("Cloudflare Access: only");
    }
  });

  it("names this environment in the add-on commands", () => {
    const staging = observed(
      inEnvironment(testPlan({ domain: "example.com" }), { name: "staging" }),
      { beszel, grafanaCloud: grafana },
    );
    const text = renderRunbook(staging, ctx).content;
    expect(text).toContain("`opscrew addon open beszel --env staging` keeps an SSH tunnel");
    expect(text).toContain("`opscrew addon status --env staging` shows its containers");
    expect(text).toContain("`opscrew addon disable beszel --env staging` removes it");
    expect(text).toContain("`opscrew addon disable grafana-cloud --env staging` removes Alloy");
  });

  it("names Beszel's subdomain behind Cloudflare Access", () => {
    const text = renderRunbook(
      observed(testPlan({ domain: "example.com" }), {
        beszel: {
          ...beszel,
          access: "subdomain",
          hostname: "beszel.example.com",
          allowedEmails: ["ops@example.com"],
        },
      }),
      ctx,
    ).content;
    expect(text).toContain(
      "It is also served on https://beszel.example.com, behind Cloudflare Access",
    );
  });

  it("points Beszel's agent mode at the user's hub", () => {
    const text = renderRunbook(
      observed(testPlan({ domain: "example.com" }), {
        beszel: { ...beszel, mode: "agent", hubUrl: "https://hub.example.com", hubKey: HUB_KEY },
      }),
      ctx,
    ).content;
    expect(text).toContain("to your Beszel hub at https://hub.example.com");
    expect(text).toContain("remove the system from your hub too");
    expect(text).not.toContain("opscrew addon open beszel");
  });

  it("says where Grafana Cloud sends what, sampled, and what stays when it is off", () => {
    const text = renderRunbook(
      observed(testPlan({ provider: "own", domain: "example.com" }), {
        grafanaCloud: { ...grafana, logSampling: 25 },
      }),
      ctx,
    ).content;
    expect(text).toContain("## Grafana Cloud");
    expect(text).toContain('sends the app\'s log lines (25% of them), labelled `app="shop"`');
    expect(text).toContain("to\nhttps://logs.example.com/loki/api/v1/push and the server's CPU");
    expect(text).toContain("are masked on the server before they leave it");
    expect(text).toContain("`~/.opscrew/projects/shop-0123456789ab/grafana_cloud_token`");
    expect(text).toContain("The data\nalready in Grafana Cloud stays in your account.");
  });

  it("has no monitoring section without monitoring", () => {
    const text = renderRunbook(
      observed(testPlan({ domain: "example.com" }), { beszel, grafanaCloud: grafana }),
      ctx,
    ).content;
    expect(text).not.toContain("## Self-hosted monitoring");
    expect(text).not.toContain("grafanaAdminPassword");
  });

  it("never shows the server's address", () => {
    const text = renderRunbook(
      observed(testPlan({ provider: "own", domain: "example.com" }), {
        ...CHECK_ON,
        beszel,
        grafanaCloud: grafana,
      }),
      ctx,
    ).content;
    expect(text).not.toContain(IPV4);
  });
});

describe("the runbook's self-hosted monitoring", () => {
  const versions = { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" };
  const retention = { metricsDays: 30, logsDays: 7, metricsMaxGb: 24 };
  const monitoring = (where: object) => ({
    monitoring: { enabled: true, where, versions, retention },
  });

  /** The owner: the stack on its extra server `monitoring` (placed through `db`, then freed). */
  function ownerPlan(): DeployPlan {
    const placed = withPlacement(testPlan({ domain: "example.com" }), {
      servers: { monitoring: "hetzner" },
      placed: { db: "monitoring" },
    });
    return observed(
      { ...placed, services: placed.services.map(({ server: _, ...service }) => service) },
      monitoring({ kind: "server", server: "monitoring" }),
    );
  }

  /** A sender: its network's outside member is the owner's server `monitoring`. */
  function senderPlan(): DeployPlan {
    const plan = withPlacement(testPlan({ domain: "example.com" }), {});
    const [app] = plan.network?.members ?? [];
    if (plan.network === undefined || app === undefined) throw new Error("no network");
    return observed(
      {
        ...plan,
        network: {
          ...plan.network,
          members: [app, { ...app, name: "monitoring", address: "10.200.4.9", port: 51821 }],
        },
      },
      monitoring({ kind: "shared", owner: { plan: "opscrew/plan.yaml", server: "monitoring" } }),
    );
  }

  const cases = {
    "on its own server": ownerPlan,
    "on the app's server": () =>
      observed(testPlan({ domain: "example.com" }), monitoring({ kind: "app" })),
    "on the repository's monitoring server": senderPlan,
  };

  /** The runbook's monitoring section, up to the next section. */
  const section = (plan: DeployPlan) => {
    const text = renderRunbook(plan, ctx).content;
    const start = text.indexOf("## Self-hosted monitoring");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\n## ", start + 1);
    return text.slice(start, end === -1 ? undefined : end + 1);
  };

  for (const [label, plan] of Object.entries(cases)) {
    it(`renders the stack ${label} (snapshot)`, () => {
      const text = section(plan());
      expect(text).toMatchSnapshot();
      expect(text).toContain("`opscrew addon open monitoring`: it gives Grafana's private address");
      expect(text).toContain("http://localhost:3000");
      expect(text).toContain("servers, containers, HTTP traffic, Caddy, Postgres and logs");
      expect(text).toContain("**Figures are kept 30 days** (at most 24 GB) **and logs 7 days.**");
      expect(text).toContain("the stack sends none");
      expect(text).toContain("`opscrew addon disable monitoring`, then `opscrew provision`");
      expect(text).not.toContain(IPV4);
    });
  }

  it("names the password's file, and the owner's for a sender", () => {
    expect(section(ownerPlan())).toContain(
      "`monitoring.grafanaAdminPassword` in `~/.opscrew/projects/shop-0123456789ab/generated_values.json`",
    );
    const sender = section(senderPlan());
    expect(sender).toContain("the generated values of the environment of `opscrew/plan.yaml`");
    expect(sender).toContain("the server and the other environments' data stay");
  });

  it("names this environment in its commands", () => {
    const text = section(
      observed(
        inEnvironment(testPlan({ domain: "example.com" }), { name: "staging" }),
        monitoring({ kind: "app" }),
      ),
    );
    expect(text).toContain("`opscrew addon open monitoring --env staging`");
    expect(text).toContain("`opscrew addon status --env staging`");
    expect(text).toContain(
      "`opscrew addon disable monitoring --env staging`, then `opscrew provision --env staging`",
    );
  });
});
