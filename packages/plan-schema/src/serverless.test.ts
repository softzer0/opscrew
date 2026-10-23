import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type CloudflareWorkersDeployTarget,
  CloudProviderSchema,
  DeployPlanSchema,
  DeployProviderSchema,
  DesignOptionSchema,
  type GithubPagesDeployTarget,
  isServerlessProvider,
  isServerlessTarget,
  onOneServer,
  parseArtifact,
  RequirementsSchema,
  type Site,
  serializeArtifact,
  VpsProviderSchema,
} from "./index";

// Feature 016: the server-less targets, Cloudflare's hosting (Workers with static assets) and
// GitHub Pages (T1601a, ADR 0019).

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

async function serverPlan() {
  return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
}

const staticSite = {
  tool: "node",
  packageManager: "pnpm",
  nodeVersion: "24",
  command: "pnpm run build",
  outputDir: "dist",
} as const;
const ssrSite = {
  ...staticSite,
  entry: "dist/_worker.js/index.js",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
} as const;

const cloudflare = (overrides: Record<string, unknown> = {}) => ({
  provider: "cloudflare-workers",
  mode: "workers-assets",
  worker: "example-app",
  render: "static",
  notFound: "single-page-application",
  site: staticSite,
  ...overrides,
});
const pages = (overrides: Record<string, unknown> = {}) => ({
  provider: "github-pages",
  mode: "pages-workflow",
  site: { tool: "hugo", command: "hugo --minify", outputDir: "public" },
  ...overrides,
});

const free = {
  monthly: { amount: 0, currency: "EUR" },
  breakdown: [],
  pricesIncludeVat: false,
  source: "static",
  asOf: "2026-10-23T00:00:00.000Z",
} as const;
const proxiedDns = {
  provider: "cloudflare",
  domain: "docs.example.com",
  zone: "example.com",
  proxied: true,
  www: false,
} as const;
const dnsOnly = { ...proxiedDns, proxied: false } as const;

/** A plan for `target` with nothing that needs a server, as design writes it. */
async function serverlessPlan(
  target: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const plan = await serverPlan();
  const github = target.provider === "github-pages";
  return {
    ...plan,
    app: { ...plan.app, name: "example-app", env: [] },
    target,
    services: [],
    externalServices: [],
    cost: free,
    dns: github ? dnsOnly : proxiedDns,
    security: { ...plan.security, wafCustomRules: !github },
    deployment: { url: "https://docs.example.com" },
    ...overrides,
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("the Cloudflare hosting target", () => {
  it("records the Worker, the rendering, the not-found handling and the site, with no server", async () => {
    const parsed = DeployPlanSchema.parse(await serverlessPlan(cloudflare()));
    expect(parsed.target).toEqual({ ...cloudflare(), workersDev: false, previewUrls: false });
    expectTypeOf<CloudflareWorkersDeployTarget>().toEqualTypeOf<{
      provider: "cloudflare-workers";
      mode: "workers-assets";
      worker: string;
      render: "static" | "ssr";
      notFound: "single-page-application" | "404-page" | "none";
      workersDev: boolean;
      previewUrls: boolean;
      site: Site;
    }>();
    for (const variant of [
      cloudflare({ notFound: "404-page", workersDev: true, previewUrls: true }),
      cloudflare({ notFound: "none" }),
      cloudflare({ render: "ssr", site: ssrSite }),
    ]) {
      expect(DeployPlanSchema.parse(await serverlessPlan(variant)).target).toEqual({
        workersDev: false,
        previewUrls: false,
        ...variant,
      });
    }
  });

  it("round-trips a static and a server-rendered plan through plan.yaml unchanged", async () => {
    const texts: string[] = [];
    for (const target of [cloudflare(), cloudflare({ render: "ssr", site: ssrSite })]) {
      const plan = DeployPlanSchema.parse(await serverlessPlan(target));
      const text = serializeArtifact("plan", plan);
      expect(text).toContain("provider: cloudflare-workers");
      expect(parseArtifact("plan", text, "plan.yaml")).toEqual(plan);
      texts.push(text);
    }
    // Only the server-rendered site names compatibility flags: absent means none.
    expect(texts[0]).not.toContain("compatibilityFlags");
    expect(texts[1]).toContain(
      "    compatibilityFlags:\n      - nodejs_compat\n      - global_fetch_strictly_public\n",
    );
  });

  it("takes Worker names of lower-case letters, digits and hyphens, up to 63", async () => {
    for (const worker of ["a", "example-app", "example-app-staging", "7", `a${"b".repeat(62)}`]) {
      const result = DeployPlanSchema.safeParse(await serverlessPlan(cloudflare({ worker })));
      expect(result.success, worker).toBe(true);
    }
    const message =
      "must be a Worker name: 1-63 lower-case letters, digits or hyphens, starting and ending with a letter or digit";
    for (const worker of ["", "Example", "-app", "app-", "app_1", "app.1", `a${"b".repeat(63)}`]) {
      const result = DeployPlanSchema.safeParse(await serverlessPlan(cloudflare({ worker })));
      expect(issues(result), worker).toEqual([{ path: "target.worker", message }]);
    }
    const { worker: _worker, ...noWorker } = cloudflare();
    expect(issues(DeployPlanSchema.safeParse(await serverlessPlan(noWorker)))?.[0]?.path).toBe(
      "target.worker",
    );
  });

  it("rejects server fields, unknown modes and bad values", async () => {
    for (const extra of [{ location: "nbg1" }, { serverType: "cpx22" }, { edge: "caddy" }]) {
      const result = DeployPlanSchema.safeParse(await serverlessPlan(cloudflare(extra)));
      expect(
        issues(result)?.map((i) => i.path),
        JSON.stringify(extra),
      ).toEqual(["target"]);
    }
    for (const [field, value] of [
      ["mode", "vps-compose"],
      ["render", "spa"],
      ["notFound", "index"],
      ["workersDev", "yes"],
      ["previewUrls", 1],
    ] as const) {
      const result = DeployPlanSchema.safeParse(
        await serverlessPlan(cloudflare({ [field]: value })),
      );
      expect(
        issues(result)?.map((i) => i.path),
        field,
      ).toEqual([`target.${field}`]);
    }
  });

  it("needs the Worker entry for server rendering, and only there", async () => {
    const ssr = DeployPlanSchema.safeParse(
      await serverlessPlan(cloudflare({ render: "ssr", site: staticSite })),
    );
    expect(issues(ssr)).toEqual([
      {
        path: "target.site.entry",
        message:
          'is required with render "ssr": the Worker module the adapter builds (Cloudflare with render "ssr" only, and required there)',
      },
    ]);
    const withEntry = { ...staticSite, entry: "dist/_worker.js/index.js" };
    const static_ = DeployPlanSchema.safeParse(
      await serverlessPlan(cloudflare({ site: withEntry })),
    );
    expect(issues(static_)).toEqual([
      {
        path: "target.site.entry",
        message:
          'is refused with render "static": a static site runs no server code (Cloudflare with render "ssr" only, and required there)',
      },
    ]);
  });
});

describe("the GitHub Pages target", () => {
  it("records the site only, and round-trips through plan.yaml unchanged", async () => {
    const plan = DeployPlanSchema.parse(await serverlessPlan(pages()));
    expect(plan.target).toEqual(pages());
    expect(serializeArtifact("plan", plan)).not.toContain("compatibilityFlags");
    expectTypeOf<GithubPagesDeployTarget>().toEqualTypeOf<{
      provider: "github-pages";
      mode: "pages-workflow";
      site: Site;
    }>();
    const text = serializeArtifact("plan", plan);
    expect(text).toContain("provider: github-pages");
    expect(parseArtifact("plan", text, "plan.yaml")).toEqual(plan);
  });

  it("rejects Cloudflare's fields, server fields and other modes", async () => {
    for (const extra of [{ worker: "example-app" }, { render: "static" }, { location: "nbg1" }]) {
      const result = DeployPlanSchema.safeParse(await serverlessPlan(pages(extra)));
      expect(
        issues(result)?.map((i) => i.path),
        JSON.stringify(extra),
      ).toEqual(["target"]);
    }
    const mode = DeployPlanSchema.safeParse(
      await serverlessPlan(pages({ mode: "workers-assets" })),
    );
    expect(issues(mode)?.map((i) => i.path)).toEqual(["target.mode"]);
  });

  it("refuses a Worker entry: GitHub Pages runs no server code", async () => {
    const site = { tool: "none", outputDir: "site", entry: "worker.js" };
    expect(issues(DeployPlanSchema.safeParse(await serverlessPlan(pages({ site }))))).toEqual([
      {
        path: "target.site.entry",
        message:
          'is refused with GitHub Pages: it serves static files only and runs no server code (Cloudflare with render "ssr" only)',
      },
    ]);
  });
});

describe("the site block", () => {
  async function siteIssues(site: Record<string, unknown>) {
    return issues(DeployPlanSchema.safeParse(await serverlessPlan(pages({ site }))));
  }

  it("takes a Node build, a Hugo build and files as they are", async () => {
    for (const site of [
      staticSite,
      { tool: "node", packageManager: "bun", command: "bun run build", outputDir: "out" },
      {
        tool: "node",
        packageManager: "npm",
        nodeVersion: "22.12",
        command: "npm run build",
        outputDir: "build/client",
      },
      { tool: "hugo", command: "hugo --minify", outputDir: "public" },
      { tool: "none", outputDir: "." },
    ]) {
      const parsed = DeployPlanSchema.parse(await serverlessPlan(pages({ site })));
      expect(parsed.target.provider === "github-pages" && parsed.target.site).toEqual(site);
    }
  });

  it("needs a package manager with node and refuses one otherwise", async () => {
    const { packageManager: _pm, ...noManager } = staticSite;
    expect(await siteIssues(noManager)).toEqual([
      {
        path: "target.site.packageManager",
        message:
          'is required with tool "node": it installs the site\'s dependencies and runs its build (required with node, refused otherwise)',
      },
    ]);
    expect(
      await siteIssues({
        tool: "hugo",
        packageManager: "npm",
        command: "hugo",
        outputDir: "public",
      }),
    ).toEqual([
      {
        path: "target.site.packageManager",
        message:
          'is refused with tool "hugo": a package manager is required with node and refused otherwise',
      },
    ]);
    expect((await siteIssues({ ...staticSite, packageManager: "pip" }))?.[0]?.path).toBe(
      "target.site.packageManager",
    );
  });

  it("takes a Node version with node only, as a version", async () => {
    expect(await siteIssues({ tool: "none", nodeVersion: "24", outputDir: "." })).toEqual([
      {
        path: "target.site.nodeVersion",
        message: 'is refused with tool "none": the Node.js version is for a node site only',
      },
    ]);
    for (const nodeVersion of ["lts", "v24", "24.x", ""]) {
      expect(await siteIssues({ ...staticSite, nodeVersion }), nodeVersion).toEqual([
        { path: "target.site.nodeVersion", message: "must be a version such as `24` or `22.12`" },
      ]);
    }
  });

  it("needs a build command with node and hugo, and refuses one with none", async () => {
    expect(await siteIssues({ tool: "hugo", outputDir: "public" })).toEqual([
      {
        path: "target.site.command",
        message:
          'is required with tool "hugo": the command that builds the site (required with node and hugo, refused with none)',
      },
    ]);
    const { command: _command, ...noCommand } = staticSite;
    expect((await siteIssues(noCommand))?.[0]?.message).toContain('is required with tool "node"');
    expect(await siteIssues({ tool: "none", command: "make", outputDir: "." })).toEqual([
      {
        path: "target.site.command",
        message:
          'is refused with tool "none": the files are in the repository as they are, with nothing to build (required with node and hugo, refused with none)',
      },
    ]);
    expect((await siteIssues({ ...staticSite, command: "pnpm i\npnpm build" }))?.[0]).toEqual({
      path: "target.site.command",
      message: "must be one shell command on a single line",
    });
  });

  it("takes repository paths for the output folder and the entry", async () => {
    for (const outputDir of ["/srv/dist", "..", "C:/dist", "dist\\client"]) {
      expect((await siteIssues({ ...staticSite, outputDir }))?.[0]?.path, outputDir).toBe(
        "target.site.outputDir",
      );
    }
    const entry = DeployPlanSchema.safeParse(
      await serverlessPlan(cloudflare({ render: "ssr", site: { ...ssrSite, entry: "../w.js" } })),
    );
    expect(issues(entry)?.map((i) => i.path)).toEqual(["target.site.entry"]);
    expect((await siteIssues({ tool: "none" }))?.[0]?.path).toBe("target.site.outputDir");
    expect((await siteIssues({ ...staticSite, tool: "jekyll" }))?.[0]?.path).toBe(
      "target.site.tool",
    );
  });
});

describe("compatibility flags", () => {
  const message = "compatibility flags are for server-rendered apps on Cloudflare";

  it("are for a server-rendered app on Cloudflare only", async () => {
    const flagged = { ...staticSite, compatibilityFlags: ["nodejs_compat"] };
    const static_ = DeployPlanSchema.safeParse(await serverlessPlan(cloudflare({ site: flagged })));
    expect(issues(static_)).toEqual([
      {
        path: "target.site.compatibilityFlags",
        message: `is refused with render "static": ${message}`,
      },
    ]);
    const site = { tool: "none", outputDir: ".", compatibilityFlags: ["nodejs_compat"] };
    const github = DeployPlanSchema.safeParse(await serverlessPlan(pages({ site })));
    expect(issues(github)).toEqual([
      {
        path: "target.site.compatibilityFlags",
        message: `is refused with GitHub Pages: ${message}`,
      },
    ]);
  });

  it("are none when absent or empty", async () => {
    for (const target of [
      cloudflare({ site: { ...staticSite, compatibilityFlags: [] } }),
      cloudflare({ render: "ssr", site: { ...staticSite, entry: "dist/_worker.js/index.js" } }),
      pages({ site: { tool: "none", outputDir: ".", compatibilityFlags: [] } }),
    ]) {
      const result = DeployPlanSchema.safeParse(await serverlessPlan(target));
      expect(result.success, JSON.stringify(target)).toBe(true);
    }
  });

  it("are Cloudflare flag names", async () => {
    for (const flag of ["nodejs-compat", "Nodejs_compat", "nodejs compat", ""]) {
      const site = { ...ssrSite, compatibilityFlags: ["nodejs_compat", flag] };
      const result = DeployPlanSchema.safeParse(
        await serverlessPlan(cloudflare({ render: "ssr", site })),
      );
      expect(issues(result), flag).toEqual([
        {
          path: "target.site.compatibilityFlags.1",
          message:
            "must be a Cloudflare compatibility flag such as `nodejs_compat`: lower-case letters, digits and underscores",
        },
      ]);
    }
  });
});

describe("the plan's rules for the server-less targets", () => {
  const targets = [
    ["Cloudflare hosting", cloudflare()],
    ["GitHub Pages", pages()],
  ] as const;

  it.each(targets)("%s needs the domain on Cloudflare", async (name, target) => {
    const why =
      name === "GitHub Pages"
        ? "OpsCrew creates the site's DNS records, and GitHub's verification record, in the domain's Cloudflare zone"
        : "the site answers on your domain as a custom domain of its Worker, which needs the domain on Cloudflare";
    const none = { provider: "none", proxied: name === "Cloudflare hosting", www: false };
    expect(issues(DeployPlanSchema.safeParse(await serverlessPlan(target, { dns: none })))).toEqual(
      [
        {
          path: "dns.provider",
          message: `must be "cloudflare" with ${name}: ${why}; move your domain's DNS to Cloudflare (opscrew domain connect), then set dns.provider to "cloudflare" with dns.domain`,
        },
      ],
    );
    const plan = await serverlessPlan(target);
    const { domain: _domain, ...noDomain } = plan.dns;
    expect(issues(DeployPlanSchema.safeParse({ ...plan, dns: noDomain }))).toEqual([
      { path: "dns.domain", message: 'is required when dns.provider is "cloudflare"' },
    ]);
  });

  it.each(targets)("%s serves a hostname two levels below the zone", async (_name, target) => {
    // A Worker's custom domain gets a certificate of its own, and GitHub issues GitHub Pages'
    // certificates: Cloudflare's free certificate, which reaches one level, is not involved.
    const plan = await serverlessPlan(target);
    const dns = { ...plan.dns, domain: "docs.shop.example.com", www: true };
    const parsed = DeployPlanSchema.parse({
      ...plan,
      dns,
      deployment: { url: "https://docs.shop.example.com" },
    });
    expect(parsed.dns).toMatchObject({ domain: "docs.shop.example.com", zone: "example.com" });
  });

  it("keeps a Worker's custom domain behind Cloudflare's proxy", async () => {
    const result = DeployPlanSchema.safeParse(await serverlessPlan(cloudflare(), { dns: dnsOnly }));
    expect(issues(result)).toEqual([
      {
        path: "dns.proxied",
        message:
          "must be true with Cloudflare hosting: a custom domain of a Worker is always behind Cloudflare's proxy; set dns.proxied to true",
      },
    ]);
  });

  it("keeps GitHub Pages hostnames DNS-only, without Cloudflare's WAF rules", async () => {
    const proxied = DeployPlanSchema.safeParse(await serverlessPlan(pages(), { dns: proxiedDns }));
    expect(issues(proxied)).toEqual([
      {
        path: "dns.proxied",
        message:
          "must be false with GitHub Pages: Cloudflare's proxy stops GitHub from issuing and renewing the site's certificate; set dns.proxied to false (DNS only)",
      },
    ]);
    const plan = await serverlessPlan(pages());
    const waf = { ...plan, security: { ...plan.security, wafCustomRules: true } };
    expect(issues(DeployPlanSchema.safeParse(waf))).toEqual([
      {
        path: "security.wafCustomRules",
        message:
          "must be false with GitHub Pages: the site's hostnames are DNS-only, so Cloudflare's WAF never sees their traffic; set security.wafCustomRules to false",
      },
    ]);
  });

  it.each(targets)("%s refuses every part that needs a server, naming it", async (name, target) => {
    const plan = await serverPlan();
    const parts = {
      services: plan.services,
      processes: {
        workers: [{ name: "jobs", command: "node worker.js", source: "user" }],
        cron: [{ name: "nightly", schedule: "@daily", command: "node cleanup.js" }],
      },
      storage: {
        objectStorage: {
          provider: "r2",
          bucket: "example-app-files",
          region: "auto",
          expected: { storageGb: 1, egressGbPerMonth: 1 },
          price: {
            monthly: 0,
            currency: "EUR",
            source: "Cloudflare R2 pricing",
            checkedOn: "2026-10-23",
          },
        },
      },
    };
    expect(issues(DeployPlanSchema.safeParse(await serverlessPlan(target, parts)))).toEqual([
      {
        path: "services.0",
        message: `is refused with ${name}: the service db (postgres) runs on a server, and ${name} has none; keep the app's own hosted service instead, or choose a server target`,
      },
      {
        path: "processes.workers.0",
        message: `is refused with ${name}: the worker jobs runs as a process on a server, and ${name} has none; choose a server target`,
      },
      {
        path: "processes.cron.0",
        message: `is refused with ${name}: the cron job nightly runs on a server, and ${name} has none; choose a server target`,
      },
      {
        path: "storage.objectStorage",
        message: `is refused with ${name}: OpsCrew's bucket (example-app-files) gives its keys to the app on a server, and ${name} has none; keep the app's own storage, or choose a server target`,
      },
    ]);
    const sqlite = DeployPlanSchema.safeParse(
      await serverlessPlan(target, {
        storage: { sqlite: { dir: "data" } },
        deploy: { strategy: "recreate" },
      }),
    );
    expect(issues(sqlite)).toEqual([
      {
        path: "storage.sqlite",
        message: `is refused with ${name}: an SQLite database keeps its file on a server's disk, and ${name} has none; use a hosted database, or choose a server target`,
      },
    ]);
  });

  it.each(targets)(
    "%s refuses a release command, Portainer CE and signing",
    async (name, target) => {
      const base = await serverlessPlan(target);
      const result = DeployPlanSchema.safeParse({
        ...base,
        app: { ...base.app, releaseCommand: "npx prisma migrate deploy" },
        portainer: { enabled: true, version: "2.33.1" },
        supplyChain: { sign: true },
      });
      expect(issues(result)).toEqual([
        {
          path: "app.releaseCommand",
          message: `is refused with ${name}: it runs in a container of the app's image on the server before each deploy, and ${name} has no server or image; remove it, or choose a server target`,
        },
        {
          path: "portainer",
          message: `is refused with ${name}: Portainer CE runs on a server, and ${name} has none; remove it`,
        },
        {
          path: "supplyChain.sign",
          message: `must be false with ${name}: cosign signs the app's image, and ${name} builds no image`,
        },
      ]);
    },
  );

  it.each(targets)("%s does not move to or from a server yet", async (name, target) => {
    const plan = await serverPlan();
    const move = { from: { target: plan.target }, step: "started", startedAt: plan.createdAt };
    const to = DeployPlanSchema.safeParse(await serverlessPlan(target, { retarget: move }));
    expect(issues(to)).toEqual([
      {
        path: "retarget",
        message: `moving an app to or from ${name} is not available yet: moving to and from server-less targets comes with retarget anywhere`,
      },
    ]);
    const from = { ...move, from: { target } };
    const back = DeployPlanSchema.safeParse({ ...plan, retarget: from });
    expect(issues(back)?.map((i) => i.path)).toContain("retarget.from.target.provider");
  });
});

describe("onServer: the runners that deploy on or to a server", () => {
  const own = { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" } as const;
  const portainer = {
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "proxy", port: 8080 },
  } as const;
  const localhost = {
    provider: "localhost",
    mode: "local-compose",
    arch: "amd64",
    ports: { https: 443, http: 80 },
    image: "registry",
  } as const;
  const noDns = { provider: "none", proxied: false, www: false } as const;

  /** A staging plan of `target` (its DNS as the target needs it) with `environment`. */
  async function staging(target: string, environment: Record<string, unknown>) {
    const server = await serverPlan();
    const base =
      target === "cloudflare-workers"
        ? await serverlessPlan(cloudflare({ worker: "example-app-staging" }))
        : target === "github-pages"
          ? await serverlessPlan(pages())
          : {
              ...server,
              target:
                target === "own"
                  ? own
                  : target === "portainer"
                    ? portainer
                    : target === "localhost"
                      ? localhost
                      : { ...server.target, provider: target },
              ...(target === "portainer" || target === "localhost" ? { dns: noDns } : {}),
            };
    return {
      ...base,
      app: { ...base.app, name: "example-app-staging" },
      environment: { name: "staging", ...environment },
    };
  }

  it("is true for every server target and for no other one", async () => {
    // The plan's target providers and the deploy providers are the same list.
    expect(DeployProviderSchema.options).toEqual([
      "hetzner",
      "digitalocean",
      "own",
      "portainer",
      "localhost",
      "cloudflare-workers",
      "github-pages",
    ]);
    const onServer = new Set(["hetzner", "digitalocean", "own"]);
    const runnerHost = { name: "home-box", arch: "amd64" };
    for (const provider of DeployProviderSchema.options) {
      for (const environment of [{ runner: "server" }, { runner: "host", runnerHost }]) {
        const result = DeployPlanSchema.safeParse(await staging(provider, environment));
        const what = `${provider} ${environment.runner}`;
        if (onServer.has(provider)) {
          expect(result.success, what).toBe(true);
        } else {
          expect(
            issues(result)?.map((i) => i.path),
            what,
          ).toEqual(["environment.runner"]);
          expect(result.error?.issues[0]?.message, what).toMatch(
            new RegExp(
              `^can be "${environment.runner}" only on a server OpsCrew creates or your own server \\(target.provider hetzner, digitalocean or own\\)`,
            ),
          );
        }
      }
    }
  });

  it("keeps the local runner to this computer, and GitHub's machines for everything", async () => {
    for (const provider of ["cloudflare-workers", "github-pages"]) {
      const local = DeployPlanSchema.safeParse(await staging(provider, { runner: "local" }));
      expect(issues(local), provider).toEqual([
        {
          path: "environment.runner",
          message:
            'can be "local" only with the localhost target (the runner deploys to this computer\'s Docker); use "github" here',
        },
      ]);
      const github = DeployPlanSchema.parse(await staging(provider, { runner: "github" }));
      expect(github.environment?.runner, provider).toBe("github");
    }
  });
});

describe("the unions", () => {
  it("have one predicate each: a server, and server-less", async () => {
    const servers = ["hetzner", "digitalocean", "own"];
    const serverless = ["cloudflare-workers", "github-pages"];
    for (const provider of DeployProviderSchema.options) {
      expect(onOneServer(provider), provider).toBe(servers.includes(provider));
      expect(isServerlessProvider(provider), provider).toBe(serverless.includes(provider));
      expect(isServerlessTarget({ provider }), provider).toBe(serverless.includes(provider));
    }
    expect(isServerlessProvider(undefined)).toBe(false);
    expect(isServerlessProvider("aws")).toBe(false);
    expect(onOneServer("aws")).toBe(false);
    const target = DeployPlanSchema.parse(await serverlessPlan(pages())).target;
    expect(isServerlessTarget(target) && target.site).toEqual(pages().site);
  });

  it("are deploy providers, never server providers, and need no region", async () => {
    const requirements = parseArtifact("requirements", await fixture("requirements.yaml"), "r");
    const { region: _region, ...noRegion } = requirements;
    for (const provider of ["cloudflare-workers", "github-pages"]) {
      expect(RequirementsSchema.parse({ ...noRegion, provider }).provider).toBe(provider);
      expect(VpsProviderSchema.options).not.toContain(provider);
      expect(CloudProviderSchema.options).not.toContain(provider);
    }
    expect(DesignOptionSchema.shape.target.shape.provider.options).toEqual(
      DeployProviderSchema.options,
    );
  });

  it("fills an image only for a server OpsCrew creates", async () => {
    for (const target of [cloudflare(), pages()]) {
      const parsed = DeployPlanSchema.parse(await serverlessPlan(target));
      expect(parsed.target, target.provider).not.toHaveProperty("image");
    }
    const { image: _image, ...noImage } = (await serverPlan()).target as { image?: string };
    const cloud = DeployPlanSchema.parse({ ...(await serverPlan()), target: noImage });
    expect(cloud.target).toHaveProperty("image", "ubuntu-24.04");
  });
});
