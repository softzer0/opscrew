import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AppKeySchema,
  appBranch,
  DeployPlanSchema,
  deploySecretPrefix,
  derivedNames,
  EnvironmentNameSchema,
  ghcrImageFor,
  githubEnvironmentFor,
  infraDirFor,
  parseArtifact,
  serializeArtifact,
  workflowPathFor,
} from "./index";

// Feature 016, US6: several apps in one repository (T1617a, ADR 0020).

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

describe("the names derived from an app's key", () => {
  it("are today's for the first app, prod given by name or left out", () => {
    for (const prod of [undefined, "prod"]) {
      expect(workflowPathFor(undefined, prod)).toBe(".github/workflows/opscrew-deploy.yml");
      expect(infraDirFor(undefined, prod)).toBe("opscrew/infra/prod");
      expect(deploySecretPrefix(undefined, prod)).toBe("OPSCREW_");
      expect(githubEnvironmentFor(undefined, prod)).toBe("production");
    }
    expect(ghcrImageFor("Acme/Shop")).toBe("ghcr.io/acme/shop");
    expect(appBranch("opscrew/prepare-deploy")).toBe("opscrew/prepare-deploy");
    expect(appBranch("opscrew/deploy-setup")).toBe("opscrew/deploy-setup");
  });

  it("are today's for the first app's other environments", () => {
    expect(workflowPathFor(undefined, "staging")).toBe(
      ".github/workflows/opscrew-deploy-staging.yml",
    );
    expect(infraDirFor(undefined, "staging")).toBe("opscrew/infra/staging");
    expect(deploySecretPrefix(undefined, "pre-prod")).toBe("OPSCREW_PRE_PROD_");
    expect(githubEnvironmentFor(undefined, "staging")).toBe("staging");
  });

  it("include a further app's key, before its environment's name", () => {
    expect(workflowPathFor("docs")).toBe(".github/workflows/opscrew-deploy-docs.yml");
    expect(workflowPathFor("docs", "staging")).toBe(
      ".github/workflows/opscrew-deploy-docs-staging.yml",
    );
    expect(infraDirFor("docs", "prod")).toBe("opscrew/infra/docs");
    expect(infraDirFor("docs", "staging")).toBe("opscrew/infra/docs-staging");
    expect(deploySecretPrefix("docs")).toBe("OPSCREW_DOCS_");
    expect(deploySecretPrefix("api-docs", "pre-prod")).toBe("OPSCREW_API_DOCS_PRE_PROD_");
    expect(githubEnvironmentFor("docs")).toBe("docs-production");
    expect(githubEnvironmentFor("docs", "staging")).toBe("docs-staging");
    expect(ghcrImageFor("Acme/Shop", "docs")).toBe("ghcr.io/acme/shop/docs");
    expect(appBranch("opscrew/prepare-deploy", "docs")).toBe("opscrew/prepare-deploy-docs");
    expect(appBranch("opscrew/deploy-setup", "docs")).toBe("opscrew/deploy-setup-docs");
  });
});

describe("GitHub Pages' own GitHub environment", () => {
  const refusal = (which: string) => ({
    code: "INVALID_INPUT",
    message: `${which} would deploy in the GitHub environment github-pages, which belongs to GitHub Pages: OpsCrew deletes it when it destroys a Pages site.`,
    hint: "Give the environment another name.",
  });

  it("is refused for a key and an environment that join into it", () => {
    for (const names of [
      () => githubEnvironmentFor("github", "pages"),
      () => derivedNames("github", "pages"),
    ]) {
      expect(names).toThrow(
        expect.objectContaining(refusal(`The app github's environment "pages"`)),
      );
    }
    expect(() => githubEnvironmentFor(undefined, "github-pages")).toThrow(
      expect.objectContaining(refusal('The environment "github-pages"')),
    );
  });

  it("is refused as an environment's name or a key by the name rules", () => {
    expect(EnvironmentNameSchema.safeParse("github-pages").success).toBe(false);
    expect(AppKeySchema.safeParse("github-pages").success).toBe(false);
  });

  it("is never what any other app or environment deploys in", () => {
    const keys = [undefined, "github", "pages", "github-pages", "docs", "gh"];
    const environments = [undefined, "pages", "github-pages", "pages-2", "github", "staging"];
    for (const app of keys) {
      for (const env of environments) {
        // The name rules refuse these before any name is derived.
        if (app !== undefined && !AppKeySchema.safeParse(app).success) continue;
        if (env !== undefined && !EnvironmentNameSchema.safeParse(env).success) continue;
        const names = () => githubEnvironmentFor(app, env);
        if (app === "github" && env === "pages") expect(names).toThrow();
        else expect(names(), `${app} ${env}`).not.toBe("github-pages");
      }
    }
    expect(githubEnvironmentFor("github")).toBe("github-production");
    expect(githubEnvironmentFor(undefined, "pages")).toBe("pages");
  });
});

describe("derivedNames", () => {
  const clash = (a: string[], b: string[]) => a.filter((name) => b.includes(name));

  it("names every name that must differ, with its kind", () => {
    expect(derivedNames()).toEqual([
      "the workflow file .github/workflows/opscrew-deploy.yml",
      "the infrastructure folder opscrew/infra/prod",
      "the GitHub environment production",
      "the secret names starting with OPSCREW_",
    ]);
    expect(derivedNames("docs", "staging", "docs-staging")).toEqual([
      "the workflow file .github/workflows/opscrew-deploy-docs-staging.yml",
      "the infrastructure folder opscrew/infra/docs-staging",
      "the GitHub environment docs-staging",
      "the secret names starting with OPSCREW_DOCS_STAGING_",
      "the app name docs-staging (resource names and concurrency group)",
    ]);
    expect(derivedNames(undefined, "prod")).toEqual(derivedNames());
  });

  it("keep apps and environments of different names apart", () => {
    const all = [
      derivedNames(undefined, undefined, "shop"),
      derivedNames(undefined, "staging", "shop-staging"),
      derivedNames("docs", undefined, "docs"),
      derivedNames("docs", "staging", "docs-staging"),
      derivedNames("landing", undefined, "landing"),
      derivedNames("landing", "qa", "landing-qa"),
    ];
    all.forEach((names, i) => {
      for (const other of all.slice(i + 1)) expect(clash(names, other)).toEqual([]);
    });
  });

  it("clash for a further app named after an environment of the first app", () => {
    expect(clash(derivedNames("docs"), derivedNames(undefined, "docs"))).toEqual([
      "the workflow file .github/workflows/opscrew-deploy-docs.yml",
      "the infrastructure folder opscrew/infra/docs",
      "the secret names starting with OPSCREW_DOCS_",
    ]);
  });

  it("clash where a key and an environment's name join into another's", () => {
    expect(clash(derivedNames("a", "b"), derivedNames("a-b"))).toContain(
      "the workflow file .github/workflows/opscrew-deploy-a-b.yml",
    );
    expect(clash(derivedNames("a", "b"), derivedNames(undefined, "a-b"))).toContain(
      "the secret names starting with OPSCREW_A_B_",
    );
    // A first app's environment named like a further app's GitHub environment.
    expect(clash(derivedNames("docs"), derivedNames(undefined, "docs-production"))).toEqual([
      "the GitHub environment docs-production",
    ]);
  });

  it("clash for a further app named after the first app's app name", () => {
    // The first app's detected name is docs, and a further app's name defaults to its key.
    expect(
      clash(derivedNames("docs", undefined, "docs"), derivedNames(undefined, undefined, "docs")),
    ).toEqual(["the app name docs (resource names and concurrency group)"]);
  });

  it("clash for a further app named after an environment's app name of the first app", () => {
    // The first app site's environment docs is named site-docs.
    const environment = derivedNames(undefined, "docs", "site-docs");
    expect(clash(derivedNames("site-docs", undefined, "site-docs"), environment)).toEqual([
      "the app name site-docs (resource names and concurrency group)",
    ]);
  });
});

describe("plan.app.key", () => {
  async function fixturePlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }

  it("is absent for the first app, and a further app's key otherwise", async () => {
    const plan = await fixturePlan();
    expect(plan.app.key).toBeUndefined();
    const docs = DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, name: "docs", key: "docs" },
    });
    expect(docs.app.key).toBe("docs");
    const text = serializeArtifact("plan", docs);
    expect(text).toContain("  name: docs\n  key: docs\n");
    expect(parseArtifact("plan", text, "plan.yaml")).toEqual(docs);
  });

  it("follows the key rules", async () => {
    const plan = await fixturePlan();
    for (const key of ["docs", "landing-2", "venv"]) {
      expect(AppKeySchema.safeParse(key).success, key).toBe(true);
    }
    for (const key of ["prod", "production", "modules", "env", "x-env", "service", "Docs", ""]) {
      const result = DeployPlanSchema.safeParse({ ...plan, app: { ...plan.app, key } });
      expect(result.success, key).toBe(false);
      expect(
        result.error?.issues.map((i) => i.path.join(".")),
        key,
      ).toEqual(["app.key"]);
    }
  });

  it("gives infra.dir and cicd.workflowPath their defaults, keeping the file's bytes", async () => {
    const text = await fixture("plan.yaml");
    const bare = text
      .replace("  dir: opscrew/infra/prod\n", "")
      .replace("  workflowPath: .github/workflows/opscrew-deploy.yml\n", "");
    expect(bare).not.toContain("dir: opscrew/infra/prod");
    expect(bare).not.toContain("workflowPath:");
    expect(serializeArtifact("plan", parseArtifact("plan", bare, "plan.yaml"))).toBe(text);

    const plan = parseArtifact("plan", bare, "plan.yaml");
    const defaults = (app: string | undefined, environment: string | undefined) => {
      const { infra, cicd } = DeployPlanSchema.parse({
        ...JSON.parse(JSON.stringify(plan)),
        infra: { engine: "auto", stateEncryption: true },
        cicd: { provider: "github-actions", registry: "ghcr" },
        app: {
          ...plan.app,
          ...(app === undefined ? {} : { key: app }),
          name: [app ?? plan.app.name, environment].filter(Boolean).join("-"),
        },
        ...(environment === undefined ? {} : { environment: { name: environment } }),
      });
      return [infra.dir, cicd.workflowPath];
    };
    expect(defaults(undefined, undefined)).toEqual([
      "opscrew/infra/prod",
      ".github/workflows/opscrew-deploy.yml",
    ]);
    expect(defaults(undefined, "staging")).toEqual([
      "opscrew/infra/staging",
      ".github/workflows/opscrew-deploy-staging.yml",
    ]);
    expect(defaults("docs", undefined)).toEqual([
      "opscrew/infra/docs",
      ".github/workflows/opscrew-deploy-docs.yml",
    ]);
    expect(defaults("docs", "staging")).toEqual([
      "opscrew/infra/docs-staging",
      ".github/workflows/opscrew-deploy-docs-staging.yml",
    ]);
  });

  it("keeps an infra.dir and a cicd.workflowPath the plan names", async () => {
    const plan = await fixturePlan();
    const parsed = DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, key: "docs" },
      infra: { ...plan.infra, dir: "infra/docs" },
      cicd: { ...plan.cicd, workflowPath: ".github/workflows/docs.yml" },
    });
    expect([parsed.infra.dir, parsed.cicd.workflowPath]).toEqual([
      "infra/docs",
      ".github/workflows/docs.yml",
    ]);
  });
});

describe("the app record", () => {
  it("names a further app's folder, and round-trips", () => {
    const text =
      "# Generated by OpsCrew (schema v1). Validated on every read.\nschemaVersion: 1\ndir: sites/docs\n";
    const record = parseArtifact("app", text, "opscrew/apps/docs/app.yaml");
    expect(record).toEqual({ schemaVersion: 1, dir: "sites/docs" });
    expect(serializeArtifact("app", record)).toBe(text);
  });

  it("refuses a missing or bad folder and unknown fields, naming them", () => {
    const file = "opscrew/apps/docs/app.yaml";
    for (const [body, path] of [
      ["schemaVersion: 1\n", "dir"],
      ["schemaVersion: 1\ndir: ../docs\n", "dir"],
      ["schemaVersion: 1\ndir: sites/docs\nkey: docs\n", "key"],
      ["schemaVersion: 2\ndir: sites/docs\n", "schemaVersion"],
    ] as const) {
      expect(() => parseArtifact("app", body, file), body).toThrow(
        expect.objectContaining({
          code: "ARTIFACT_INVALID",
          issues: [expect.objectContaining({ path })],
        }),
      );
    }
  });
});
