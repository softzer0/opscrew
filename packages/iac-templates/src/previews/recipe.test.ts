import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, snapshotsOn } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CF_RANGES, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { renderDeployment } from "../render";
import { runtimeDir } from "../runtime-dir";
import {
  APP_ZONE_BASE,
  BASE,
  directPreview,
  envFor,
  IMAGE_NAME,
  type PreviewPlanOptions,
  previewPlan,
  REPOSITORY,
} from "./__fixtures__/plans";
import {
  PREVIEW_SECRET_FORMATS,
  type PreviewEnvTemplates,
  type PreviewSecretFormat,
  previewRecipeDir,
  previewSecret,
  previewTemplatePlan,
  renderPreviewRecipe,
} from "./index";
import { previewScript } from "./script";

const DIR = "opscrew/environments/preview/previews";

/** The recipe of `plan` with the fixtures' env templates (or `env`), by path under its folder. */
function recipe(plan: DeployPlan, env?: PreviewEnvTemplates): Record<string, string> {
  const files = renderPreviewRecipe(plan, {
    repository: REPOSITORY,
    imageName: IMAGE_NAME,
    env: env ?? envFor(previewTemplatePlan(plan)),
  });
  return Object.fromEntries(files.map((file) => [file.path.slice(DIR.length + 1), file.content]));
}

/** A fixed value per generated name, in its format, as the server would make it. */
function fixed(name: string, format: PreviewSecretFormat): string {
  const hex = (bytes: number) => Buffer.alloc(bytes, name.length).toString("hex");
  switch (format) {
    case "hex32":
      return hex(32);
    case "hex64":
      return hex(64);
    case "b64k32":
      return `base64:${Buffer.alloc(32, name.length).toString("base64")}`;
    case "gk":
      return `GK${hex(12)}`;
  }
}

/**
 * `template/` filled in as the server does: `@N@` with `n`, `@R@` with `random`, each placeholder
 * with {@link fixed}.
 */
function filled(files: Record<string, string>, n: number, random: string): Record<string, string> {
  const fill = (text: string) =>
    text
      .replaceAll("@N@", String(n))
      .replaceAll("@R@", random)
      .replaceAll(/@SECRET:([A-Za-z][A-Za-z0-9_-]*):([a-z0-9]+)@/g, (_, name, format) =>
        fixed(name, format),
      );
  return Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.startsWith("template/"))
      .map(([path, content]) => [fill(path.slice("template/".length)), fill(content)]),
  );
}

describe("renderPreviewRecipe", () => {
  it("writes the settings, the template of a preview's folder and the command, in the environment's previews folder", () => {
    const plan = previewPlan();
    const files = renderPreviewRecipe(plan, {
      repository: REPOSITORY,
      imageName: IMAGE_NAME,
      env: envFor(previewTemplatePlan(plan)),
    });
    expect(previewRecipeDir(plan)).toBe(DIR);
    expect(files.map((file) => file.path.slice(DIR.length + 1))).toEqual([
      "settings.env",
      "template/compose.yaml",
      "template/crontab",
      "template/edge/compose.yaml",
      "template/edge/sites/shop-preview-pr-@N@.caddy",
      "template/start.sh",
      "template/rollback.sh",
      "template/env/app.env",
      "template/env/db.env",
      "bin/opscrew-preview",
    ]);
    expect(files.every((file) => file.kind === "runtime")).toBe(true);
    expect(files.filter((file) => file.mode !== undefined)).toEqual([
      expect.objectContaining({ path: `${DIR}/bin/opscrew-preview`, mode: 0o755 }),
    ]);
    expect(files.at(-1)?.content).toBe(previewScript());
  });

  it("holds every bound in settings.env, each value checked before it is written", () => {
    const settings = recipe(previewPlan({ cap: 5, lifetimeDays: 2 }))["settings.env"];
    expect(settings).toBe(
      [
        "# The bounds of the previews of example-org/example-app's pull requests, from opscrew/environments/preview/plan.yaml:",
        "# opscrew-preview reads them. `opscrew provision` rewrites this file; a change is a new approval.",
        "APP=shop-preview",
        "CAP=5",
        "LIFETIME_DAYS=2",
        "IMAGE_NAME=ghcr.io/example-org/example-app",
        `BASE=${BASE}`,
        "SEED=1",
        "",
      ].join("\n"),
    );
    // The script reads each of them.
    for (const name of ["APP", "CAP", "LIFETIME_DAYS", "IMAGE_NAME", "BASE", "SEED"]) {
      expect(previewScript()).toMatch(new RegExp(`\\$\\(?\\(?${name}\\b`));
    }
    const plan = previewPlan();
    const env = envFor(previewTemplatePlan(plan));
    for (const imageName of [
      "ghcr.io/example-org/Example-App",
      "ghcr.io/example-org",
      "docker.io/example-org/example-app",
      "ghcr.io/example-org/example-app\nSEED=1",
      "ghcr.io/example-org/example-app:latest",
    ]) {
      expect(() => renderPreviewRecipe(plan, { repository: REPOSITORY, imageName, env })).toThrow(
        OpsCrewError,
      );
    }
    for (const repository of ["example-org", "example-org/example-app\n# x", "a/b/c"]) {
      expect(() => renderPreviewRecipe(plan, { repository, imageName: IMAGE_NAME, env })).toThrow(
        OpsCrewError,
      );
    }
  });

  it("has no seed service and SEED=0 without a seed command (none, or none set yet)", () => {
    for (const plan of [previewPlan({ seed: null }), withoutSeed(previewPlan())]) {
      const files = recipe(plan);
      expect(files["settings.env"]).toContain("\nSEED=0\n");
      expect(Object.keys(parse(files["template/compose.yaml"] ?? "").services)).not.toContain(
        "seed",
      );
    }
    const services = parse(recipe(previewPlan())["template/compose.yaml"] ?? "").services;
    expect(services.seed.command).toEqual(["sh", "-c", "npm run seed"]);
    expect(services.seed.profiles).toEqual(["seed"]);
  });

  it("takes no snapshot of a preview's databases, and never changes its data on a rollback", () => {
    const plan = previewPlan();
    expect(snapshotsOn(previewTemplatePlan(plan))).toBe(false);
    const files = recipe(plan);
    const start = files["template/start.sh"] ?? "";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a JavaScript template.
    expect(start).toContain('MODE="${2:-deploy}"');
    for (const script of [start, files["template/rollback.sh"] ?? ""]) {
      expect(script).toContain("docker compose");
      expect(script).not.toMatch(/snapshot|\.rollback-database|\.database\.changed/);
    }
  });

  it("puts @N@ where the preview's number goes, @R@ where its random part goes, and the tokens nowhere", () => {
    const plan = previewPlan();
    const template = previewTemplatePlan(plan);
    expect(template.app.name).toBe("shop-preview-pr-xnumbx");
    // As long as the longest address: pr-<6 digits>-<10 random characters>.<base>.
    expect(template.dns.domain).toBe(`pr-xnumbx-xrandpartx.${BASE}`);
    expect(template.environment?.previews).toBeUndefined();
    // Its app name is as long as the longest preview's: <31>-pr-<6 digits>.
    expect(
      previewTemplatePlan(previewPlan({ name: `${"a".repeat(23)}-preview` })).app.name,
    ).toHaveLength(41);
    const files = recipe(plan);
    expect(JSON.stringify(files)).not.toMatch(/xnumbx|xrandpartx/i);
    expect(files["template/compose.yaml"]).toContain("name: shop-preview-pr-@N@\n");
    expect(files["template/compose.yaml"]).toContain("- /srv/data/shop-preview-pr-@N@/db:");
    expect(files["template/edge/sites/shop-preview-pr-@N@.caddy"]).toContain(
      `\npr-@N@-@R@.${BASE} {\n`,
    );
    expect(files["template/start.sh"]).toContain(`--host pr-@N@-@R@.${BASE} `);
    expect(files["template/env/app.env"]).toContain(`APP_URL=https://pr-@N@-@R@.${BASE}\n`);
    // @R@ only in the address.
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith("template/")) continue;
      expect(content.split("@R@").length, path).toBe(content.split(`pr-@N@-@R@.${BASE}`).length);
    }
  });

  it("puts a domain below the app's zone, several labels deep, in BASE and the preview's address", () => {
    const files = recipe(previewPlan({ appZone: true }));
    expect(files["settings.env"]).toContain(`\nBASE=${APP_ZONE_BASE}\n`);
    expect(files["template/edge/sites/shop-preview-pr-@N@.caddy"]).toContain(
      `\npr-@N@-@R@.${APP_ZONE_BASE} {\n`,
    );
    expect(files["template/start.sh"]).toContain(`--host pr-@N@-@R@.${APP_ZONE_BASE} `);
  });

  it("serves each preview with the Origin CA certificate the previews host plan installs, and X-Robots-Tag noindex", () => {
    const site = recipe(previewPlan())["template/edge/sites/shop-preview-pr-@N@.caddy"] ?? "";
    expect(site.match(/X-Robots-Tag "noindex"/g)).toHaveLength(2);
    // /srv/edge/tls/shop-preview on the server, no ACME (none of its certificates is public)
    // and no client certificate.
    expect(site).toContain(
      `\npr-@N@-@R@.${BASE} {\n\ttls /etc/caddy/tls/shop-preview/origin.pem /etc/caddy/tls/shop-preview/origin.key\n`,
    );
    expect(site.match(/\ttls /g)).toHaveLength(1);
    expect(site).not.toContain("client_auth");
  });

  describe("on another environment's server", () => {
    const plan = previewPlan({ provider: "own", server: "dev" });
    const options = {
      repository: REPOSITORY,
      imageName: IMAGE_NAME,
      env: envFor(previewTemplatePlan(plan)),
    };
    /** The edge's Compose file of `files`, at `path`. */
    const edgeOf = (files: { path: string; content: string }[], path: string) =>
      files.find((file) => file.path === path)?.content;
    const EDGE = `${DIR}/template/edge/compose.yaml`;

    it("holds the edge files the host's deploys put in /srv/edge, byte for byte", () => {
      // dev's name is DNS only, its web ports open to everyone; the previews' own plan has the
      // web filter.
      const dev = testPlan({ provider: "own", domain: "dev.example.com" });
      const host: DeployPlan = { ...dev, dns: { ...dev.dns, proxied: false } };
      const deployed = renderDeployment(
        host,
        testContext({ cloudflare: testCloudflare(), cloudflareRanges: CF_RANGES }),
      );
      const shared = renderPreviewRecipe(plan, {
        ...options,
        host: { plan: host, cloudflareRanges: CF_RANGES },
      });
      const edge = edgeOf(shared, EDGE);
      expect(edge).toBe(edgeOf(deployed, `${runtimeDir(host)}/edge/compose.yaml`));
      expect(edge).not.toContain("0.0.0.0:");
      expect(edge).toContain(CF_RANGES[0]);
      // On a server of their own, the edge follows the previews' plan, with the web filter.
      const own = renderPreviewRecipe(plan, options);
      expect(edgeOf(own, EDGE)).toContain("0.0.0.0:443");
      // Nothing else of the recipe changes.
      const rest = (files: { path: string; content: string }[]) =>
        files.filter((file) => file.path !== EDGE);
      expect(rest(shared)).toEqual(rest(own));
    });

    it("trusts no Cloudflare range when the host's plan has no Cloudflare domain, as its deploys don't", () => {
      const host = testPlan({ provider: "own" });
      const edge = edgeOf(
        renderPreviewRecipe(plan, {
          ...options,
          host: { plan: host, cloudflareRanges: CF_RANGES },
        }),
        EDGE,
      );
      expect(edge).toBe(
        edgeOf(renderDeployment(host, testContext()), `${runtimeDir(host)}/edge/compose.yaml`),
      );
      expect(edge).not.toContain(CF_RANGES[0]);
    });
  });

  describe("filled with a number and values, is what OpsCrew renders for <app>-pr-<number>", () => {
    const plans: [string, PreviewPlanOptions][] = [
      ["Postgres, a worker, cron, a release command and a seed", {}],
      [
        "a name of 31 characters, Postgres and Valkey, no seed",
        { name: `${"b".repeat(23)}-preview`, redis: true, seed: null },
      ],
      [
        "no service, worker, release command or seed",
        { postgres: false, processes: false, release: null, seed: null },
      ],
    ];
    it.each(plans)("%s", (_, options) => {
      const plan = previewPlan(options);
      const files = recipe(plan);
      for (const [n, random] of [
        [42, "a1b2c3d4e5"],
        [999999, "zzzzzzzzzz"],
      ] as const) {
        expect(filled(files, n, random)).toEqual(directPreview(plan, n, random, fixed));
      }
    });
  });

  it("uses every placeholder format, and placeholders only for generated values", () => {
    const app = recipe(previewPlan())["template/env/app.env"] ?? "";
    for (const format of PREVIEW_SECRET_FORMATS) expect(app).toContain(`:${format}@`);
    expect(previewSecret("db-password", "hex32")).toBe("@SECRET:db-password:hex32@");
    for (const name of ["", "1st", "a b", "a@b", "a:b", "x".repeat(65)]) {
      expect(() => previewSecret(name, "hex32")).toThrow(OpsCrewError);
    }
  });

  it("refuses env templates the server can't fill", () => {
    const plan = previewPlan({ redis: true });
    const env = envFor(previewTemplatePlan(plan));
    const bad: PreviewEnvTemplates[] = [
      { ...env, app: `${env.app}TOKEN=@SECRET:token:hex16@\n` },
      { ...env, app: `${env.app}TOKEN=@SECRET:token\n` },
      { ...env, app: `${env.app}AGAIN=@SECRET:db-password:hex64@\n` },
      {
        ...env,
        app: `${env.app}NAME=shop-preview-pr-xnumbx_db\n`.replace("pr-xnumbx", "PR_XNUMBX"),
      },
      { ...env, app: `${env.app}HOST=pr-xnumbx-XRANDPARTX.${BASE}\n` },
      { ...env, app: `${env.app}CODE=xrandpartx\n` },
    ];
    for (const templates of bad) {
      expect(() => recipe(plan, templates)).toThrow(OpsCrewError);
    }
  });

  it("refuses a plan without previews", () => {
    const plan = previewPlan();
    const { previews: _, ...environment } = plan.environment ?? { name: "x" };
    expect(() => recipe({ ...plan, environment } as DeployPlan)).toThrow(OpsCrewError);
    expect(() => previewTemplatePlan({ ...plan, environment } as DeployPlan)).toThrow(OpsCrewError);
  });
});

/** `plan` before design set a seed command: `environment.previews` without `seed`. */
function withoutSeed(plan: DeployPlan): DeployPlan {
  const environment = plan.environment;
  if (environment?.previews === undefined) throw new Error("not previews");
  const { seed: _, ...previews } = environment.previews;
  return { ...plan, environment: { ...environment, previews } };
}
