// Feature 027: shared hosting accounts, the `hosting` target (T2702, ADR 0030).
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DeployPlanSchema,
  DeployProviderSchema,
  type HostingDeployTarget,
  HostingPanelSchema,
  HostingTargetSchema,
  isHostingProvider,
  isHostingTarget,
  isServerlessTarget,
  onOneServer,
  parseArtifact,
  RequirementsSchema,
  type Site,
  serializeArtifact,
} from "./index";
import { toJsonSchemas } from "./json-schema";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

const hosting = (overrides: Record<string, unknown> = {}) => ({
  provider: "hosting",
  panel: "cpanel",
  app: "php",
  webRoot: "public",
  ...overrides,
});

const nodeRuntime = { interpreter: "nodejs", version: "22", startup: "server.js" } as const;
const pythonRuntime = { interpreter: "python", version: "3.12", startup: "passenger_wsgi.py" };

/** A plan for `target` on a hosting account, its hostname `app.example.com`, with no services. */
async function hostingPlan(
  target: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  return {
    ...plan,
    target,
    services: [],
    externalServices: [],
    dns: { provider: "none", domain: "app.example.com", proxied: false, www: false },
    security: { ...plan.security, httpAllowedFrom: "any" },
    ...overrides,
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

async function targetIssues(target: Record<string, unknown>) {
  return issues(DeployPlanSchema.safeParse(await hostingPlan(target)));
}

describe("the hosting target", () => {
  it("records the panel, the app, its web root and its parts, with no server", async () => {
    const parsed = DeployPlanSchema.parse(await hostingPlan(hosting()));
    expect(parsed.target).toEqual({ ...hosting(), cron: [], docroot: "direct" });
    expectTypeOf<HostingDeployTarget>().toEqualTypeOf<{
      provider: "hosting";
      panel: "cpanel" | "plesk" | "directadmin" | "sftp";
      app: "static" | "php" | "node" | "python";
      webRoot: string;
      site?: Site | undefined;
      php?: { version: string; via: "account" | "multiphp" | "handler" } | undefined;
      database?: { engine: "mariadb" | "mysql"; name: string } | undefined;
      cron: { schedule: string; command: string }[];
      runtime?: { interpreter: "nodejs" | "python"; version: string; startup: string } | undefined;
      docroot: "direct" | "link";
    }>();
    const laravel = hosting({
      php: { version: "8.3", via: "multiphp" },
      database: { engine: "mariadb", name: "shop_prod" },
      cron: [{ schedule: "* * * * *", command: "php artisan schedule:run" }],
      docroot: "link",
    });
    expect(DeployPlanSchema.parse(await hostingPlan(laravel)).target).toEqual(laravel);
    const site = hosting({
      app: "static",
      webRoot: ".",
      site: { tool: "node", packageManager: "pnpm", command: "pnpm run build", outputDir: "dist" },
    });
    expect(DeployPlanSchema.parse(await hostingPlan(site)).target).toMatchObject(site);
  });

  it("takes every panel, and node and python apps with their runtime", async () => {
    expect(HostingPanelSchema.options).toEqual(["cpanel", "plesk", "directadmin", "sftp"]);
    for (const panel of HostingPanelSchema.options) {
      const result = DeployPlanSchema.safeParse(await hostingPlan(hosting({ panel })));
      expect(result.success, panel).toBe(true);
    }
    for (const target of [
      hosting({ app: "node", webRoot: ".", runtime: nodeRuntime }),
      hosting({ app: "python", webRoot: ".", runtime: pythonRuntime, panel: "directadmin" }),
    ]) {
      expect(DeployPlanSchema.parse(await hostingPlan(target)).target).toMatchObject(target);
    }
  });

  it("round-trips through plan.yaml unchanged", async () => {
    const plan = DeployPlanSchema.parse(
      await hostingPlan(hosting({ database: { engine: "mysql", name: "app" } })),
    );
    const text = serializeArtifact("plan", plan);
    expect(text).toContain("provider: hosting\n  panel: cpanel\n");
    expect(parseArtifact("plan", text, "plan.yaml")).toEqual(plan);
  });

  it("serves a relative web root inside the release, the release itself as .", async () => {
    for (const webRoot of [".", "public", "web/public"]) {
      const result = DeployPlanSchema.safeParse(await hostingPlan(hosting({ webRoot })));
      expect(result.success, webRoot).toBe(true);
    }
    for (const webRoot of ["..", "../public", "public/../..", "/public", "C:/www", "public\\x"]) {
      expect(
        (await targetIssues(hosting({ webRoot })))?.map((i) => i.path),
        webRoot,
      ).toEqual(["target.webRoot"]);
    }
  });

  it("rejects server fields, unknown values and malformed parts", async () => {
    for (const extra of [{ mode: "vps-compose" }, { edge: "caddy" }, { location: "nbg1" }]) {
      expect(
        (await targetIssues(hosting(extra)))?.map((i) => i.path),
        JSON.stringify(extra),
      ).toEqual(["target"]);
    }
    for (const [field, value, path] of [
      ["panel", "whm", "target.panel"],
      ["app", "ruby", "target.app"],
      ["docroot", "public_html", "target.docroot"],
      ["php", { version: "8", via: "account" }, "target.php.version"],
      ["php", { version: "8.3.1", via: "account" }, "target.php.version"],
      ["php", { version: "8.3", via: "cagefs" }, "target.php.via"],
      ["database", { engine: "postgres", name: "app" }, "target.database.engine"],
      ["database", { engine: "mysql", name: "App" }, "target.database.name"],
      ["database", { engine: "mysql", name: "app-db" }, "target.database.name"],
      ["database", { engine: "mysql", name: "" }, "target.database.name"],
      ["cron", [{ schedule: "@daily", command: "php cron.php" }], "target.cron.0.schedule"],
      ["cron", [{ schedule: "0 * * * * *", command: "php cron.php" }], "target.cron.0.schedule"],
      ["cron", [{ schedule: "0 3 * * *", command: "a\nb" }], "target.cron.0.command"],
    ] as const) {
      expect(
        (await targetIssues(hosting({ [field]: value })))?.map((i) => i.path),
        JSON.stringify(value),
      ).toEqual([path]);
    }
    expect(
      HostingTargetSchema.safeParse(hosting({ database: { engine: "mysql", name: "App" } })).error
        ?.issues[0]?.message,
    ).toBe(
      "must be lower-case letters, digits and underscores, without the account's prefix (the panel adds it)",
    );
    const runtime = { ...nodeRuntime, version: "lts" };
    expect((await targetIssues(hosting({ app: "node", runtime })))?.map((i) => i.path)).toEqual([
      "target.runtime.version",
    ]);
  });
});

describe("the hosting target's rules", () => {
  it("keeps an SFTP host to static sites and PHP on the account's own version", async () => {
    const sftp = (overrides: Record<string, unknown>) => hosting({ panel: "sftp", ...overrides });
    expect(
      DeployPlanSchema.parse(await hostingPlan(sftp({ php: { version: "8.2", via: "account" } })))
        .target,
    ).toMatchObject({ panel: "sftp", php: { via: "account" } });
    const why = "an SFTP host has no panel for OpsCrew to set it up through";
    expect(
      await targetIssues(
        sftp({
          database: { engine: "mysql", name: "app" },
          cron: [{ schedule: "0 3 * * *", command: "php cron.php" }],
          php: { version: "8.3", via: "multiphp" },
        }),
      ),
    ).toEqual([
      {
        path: "target.database",
        message: `is refused with panel "sftp": ${why}; make the database in your host's control panel, give the app its values as settings, and remove target.database`,
      },
      {
        path: "target.cron",
        message: `must be empty with panel "sftp": ${why}; add the app's scheduled commands in your host's control panel, and remove target.cron`,
      },
      {
        path: "target.php.via",
        message: `must be "account" with panel "sftp": ${why}, so the hostname runs the account's own PHP version; set target.php.via to "account"`,
      },
    ]);
    expect((await targetIssues(sftp({ php: { version: "8.3", via: "handler" } })))?.[0]).toEqual({
      path: "target.php.via",
      message: `must be "account" with panel "sftp": ${why}, so the hostname runs the account's own PHP version; set target.php.via to "account"`,
    });
    for (const [app, runtime] of [
      ["node", nodeRuntime],
      ["python", pythonRuntime],
    ] as const) {
      const appIssue = {
        path: "target.app",
        message: `can be "static" or "php" with panel "sftp": a Node.js or Python app runs through a panel's app support, and ${why}; choose a hosting account with a panel, or a server target`,
      };
      // Without a runtime only the app is refused: an SFTP host never takes one.
      expect(await targetIssues(sftp({ app })), app).toEqual([appIssue]);
      expect(await targetIssues(sftp({ app, runtime })), app).toEqual([
        appIssue,
        {
          path: "target.runtime",
          message: `is refused with panel "sftp": a Node.js or Python app runs through a panel's app support, and ${why}; remove target.runtime`,
        },
      ]);
    }
  });

  it("refuses PHP, a database and a runtime for a static site", async () => {
    const site = hosting({
      app: "static",
      webRoot: ".",
      php: { version: "8.3", via: "account" },
      database: { engine: "mariadb", name: "app" },
      runtime: nodeRuntime,
    });
    expect(await targetIssues(site)).toEqual([
      {
        path: "target.php",
        message: 'is refused with app "static": a static site runs no PHP; remove target.php',
      },
      {
        path: "target.database",
        message:
          'is refused with app "static": a static site uses no database; remove target.database',
      },
      {
        path: "target.runtime",
        message:
          'is refused with app "static": a static site runs no Node.js or Python app; remove target.runtime',
      },
    ]);
  });

  it("needs a Node.js or Python app's runtime, with its own interpreter", async () => {
    expect(await targetIssues(hosting({ app: "node" }))).toEqual([
      {
        path: "target.runtime",
        message:
          'is required with app "node": the interpreter (nodejs), its version and the startup file the panel runs the app with',
      },
    ]);
    expect(await targetIssues(hosting({ app: "python", panel: "plesk" }))).toEqual([
      {
        path: "target.runtime",
        message:
          'is required with app "python": the interpreter (python), its version and the startup file the panel runs the app with',
      },
    ]);
    expect(await targetIssues(hosting({ app: "python", runtime: nodeRuntime }))).toEqual([
      {
        path: "target.runtime.interpreter",
        message: 'must be "python" with app "python"; set target.runtime.interpreter to "python"',
      },
    ]);
  });

  it("needs dns.domain, the hostname, whether the domain is on Cloudflare or not", async () => {
    const message =
      "is required with a hosting account: it is the hostname the account serves the app on; set dns.domain to it";
    for (const provider of ["none", "cloudflare"]) {
      const plan = await hostingPlan(hosting(), {
        dns: { provider, proxied: false, www: false },
      });
      expect(issues(DeployPlanSchema.safeParse(plan)), provider).toEqual([
        { path: "dns.domain", message },
      ]);
    }
    const onCloudflare = await hostingPlan(hosting(), {
      dns: {
        provider: "cloudflare",
        domain: "shop.example.com",
        zone: "example.com",
        proxied: false,
        www: false,
      },
    });
    expect(DeployPlanSchema.parse(onCloudflare).dns.domain).toBe("shop.example.com");
  });

  it("refuses extra servers, naming a hosting account", async () => {
    const plan = await hostingPlan(hosting(), {
      servers: [{ name: "data", target: { provider: "own", mode: "vps-compose", arch: "amd64" } }],
    });
    expect(issues(DeployPlanSchema.safeParse(plan))).toContainEqual({
      path: "servers",
      message:
        "is refused with a hosting account: extra servers run on a cloud server or your own server (target.provider hetzner, digitalocean, contabo or own); remove servers, or choose such a target",
    });
  });
});

describe("the hosting guards", () => {
  it("know the hosting target and nothing else", async () => {
    for (const provider of DeployProviderSchema.options) {
      expect(isHostingProvider(provider), provider).toBe(provider === "hosting");
      expect(isHostingTarget({ provider }), provider).toBe(provider === "hosting");
    }
    expect(isHostingProvider(undefined)).toBe(false);
    expect(onOneServer("hosting")).toBe(false);
    expect(isServerlessTarget({ provider: "hosting" })).toBe(false);
    const target = DeployPlanSchema.parse(await hostingPlan(hosting())).target;
    expect(isHostingTarget(target) && target.panel).toBe("cpanel");
  });

  it("is a deploy provider that needs no region", async () => {
    const requirements = parseArtifact("requirements", await fixture("requirements.yaml"), "r");
    const { region: _region, ...noRegion } = requirements;
    expect(RequirementsSchema.parse({ ...noRegion, provider: "hosting" }).provider).toBe("hosting");
  });

  it("is in the JSON schemas", () => {
    const schemas = toJsonSchemas();
    expect(schemas.requirements).toMatchObject({
      properties: { provider: { enum: DeployProviderSchema.options } },
    });
    const plan = schemas.plan as { properties: { target: { oneOf: object[] } } };
    expect(plan.properties.target.oneOf.at(-1)).toMatchObject({
      properties: {
        provider: { const: "hosting" },
        panel: { enum: ["cpanel", "plesk", "directadmin", "sftp"] },
        app: { enum: ["static", "php", "node", "python"] },
        cron: { type: "array", default: [] },
        docroot: { enum: ["direct", "link"], default: "direct" },
      },
      required: ["provider", "panel", "app", "webRoot"],
      additionalProperties: false,
    });
  });
});
