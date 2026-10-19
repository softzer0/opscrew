import { fileURLToPath } from "node:url";
import { detectProject } from "@opscrew/detect";
import type { AppBuild, DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, nextPostgresFacts, staticSpaFacts } from "../testing";
import { type BuilderChoice, chooseBuilder, runtimeLanguageOf } from "./builder";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));

/** A plan holding only `app.build`, as `chooseBuilder` reads it. */
function planWith(build: Omit<AppBuild, "probe">): Pick<DeployPlan, "app"> {
  return { app: { build: { ...build, probe: "none" } } as DeployPlan["app"] };
}

function choice(result: BuilderChoice | { refused: string }): BuilderChoice {
  if ("refused" in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

describe("chooseBuilder: the example apps of today", () => {
  // Every example is a Node or Python stack OpsCrew has a Dockerfile for. Five have `@types/node`
  // 22 as their evidence; the others declare nothing or a range the default is inside.
  const cases: [string, BuilderChoice["probe"], "node" | "python", string?][] = [
    ["angular-static", "wget", "node"],
    ["astro-ssr", "node", "node"],
    ["django-postgres", "python", "python"],
    ["express-api", "node", "node"],
    ["express-drizzle", "node", "node"],
    ["fastapi-redis", "python", "python"],
    ["fastapi-sqlmodel", "python", "python"],
    ["fastify-api", "node", "node"],
    ["hono-api", "node", "node", "22"],
    ["koa-knex", "node", "node"],
    ["lovable-supabase", "wget", "node"],
    ["monorepo-two-apps", "node", "node"],
    ["nestjs-api", "node", "node", "22"],
    ["nestjs-typeorm", "node", "node", "22"],
    ["nextjs-postgres", "node", "node", "22"],
    ["nuxt-ssr", "node", "node"],
    ["react-router-ssr", "node", "node", "22"],
    ["static-vite", "wget", "node"],
    ["sveltekit-ssr", "node", "node"],
  ];

  it("covers all 19 examples", () => {
    expect(cases).toHaveLength(19);
  });

  it.each(cases)("%s → the generated Dockerfile", async (name, probe, language, version) => {
    const facts = await detectProject(`${EXAMPLES}${name}`);
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    expect(result).toMatchObject({
      builder: "generated-dockerfile",
      chosen: "auto",
      automatic: "generated-dockerfile",
      probe,
      runtime: { language, version: version ?? (language === "node" ? "24" : "3.14") },
    });
    expect(result.reason).toMatch(/^OpsCrew has a Dockerfile for .+, which builds a small image/);
  });
});

/** The six apps of 012 as detection describes them (examples/ gets them in T1208). */
const NEW_LANGUAGES: Record<string, ProjectFacts> = {
  "go-api": makeFacts({ name: "go-api", languages: ["go"], runtimeVersions: { go: "1.26" } }),
  "rails-api": makeFacts({
    name: "rails-api",
    languages: ["ruby"],
    frameworks: [{ name: "rails", path: "." }],
    appKind: "fullstack",
    runtimeVersions: { ruby: "4.0.6" },
  }),
  "laravel-app": makeFacts({
    name: "laravel-app",
    languages: ["javascript", "php"],
    frameworks: [
      { name: "laravel", path: "." },
      { name: "vite", path: "." },
    ],
    appKind: "fullstack",
    runtimeVersions: { php: "^8.4" },
  }),
  "spring-boot-api": makeFacts({
    name: "spring-boot-api",
    languages: ["java"],
    runtimeVersions: { java: "21" },
  }),
  "dotnet-api": makeFacts({
    name: "dotnet-api",
    languages: ["other"],
    runtimeVersions: { dotnet: "10.0" },
  }),
  "rust-api": makeFacts({ name: "rust-api", languages: ["rust"] }),
};

describe("chooseBuilder: the six new languages", () => {
  const cases: [string, BuilderChoice["builder"], BuilderChoice["probe"], AppBuild["runtime"]][] = [
    ["go-api", "buildpacks", "bash", { language: "go", version: "1.26" }],
    ["rails-api", "buildpacks", "ruby", { language: "ruby", version: "4.0.6" }],
    ["laravel-app", "railpack", "php", { language: "php", version: "8.4" }],
    ["spring-boot-api", "buildpacks", "bash", { language: "java", version: "21" }],
    ["dotnet-api", "buildpacks", "bash", { language: "dotnet", version: "10.0" }],
    ["rust-api", "railpack", "bash", { language: "rust", version: "1.98" }],
  ];

  it.each(cases)("%s → %s", (name, builder, probe, runtime) => {
    const facts = NEW_LANGUAGES[name] as ProjectFacts;
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    expect(result).toMatchObject({ builder, chosen: "auto", automatic: builder, probe, runtime });
  });

  // go.mod's `go` and `toolchain` lines are minimums inside their release line.
  it.each([
    ["1.25.0", "buildpacks", "1.25"],
    ["1.25.3", "buildpacks", "1.25"],
    ["1.26", "buildpacks", "1.26"],
    ["1.26.9", "railpack", "1.26.9"],
  ] as const)("Go %s → %s with Go %s", (declared, builder, version) => {
    const facts = makeFacts({ languages: ["go"], runtimeVersions: { go: declared } });
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    expect(result).toMatchObject({ builder, runtime: { language: "go", version } });
    if (builder === "railpack") {
      expect(result.reason).toBe(
        "The pinned Buildpacks builder does not offer Go 1.26.9, so Railpack builds the image, running the app as a non-root user.",
      );
    }
  });

  it("builds Buildpacks languages for arm64 too", () => {
    const facts = NEW_LANGUAGES["go-api"] as ProjectFacts;
    expect(choice(chooseBuilder(facts, undefined, "arm64")).builder).toBe("buildpacks");
  });

  it("names the deciding fact in one sentence", () => {
    const reason = (name: string) =>
      choice(chooseBuilder(NEW_LANGUAGES[name] as ProjectFacts, undefined, "amd64")).reason;
    expect(reason("spring-boot-api")).toBe(
      "Buildpacks builds Java 21 as a non-root image, smaller than Railpack's.",
    );
    expect(reason("go-api")).toBe(
      "Buildpacks builds Go 1.26 as a non-root image, without the extra layer Railpack needs for that.",
    );
    expect(reason("rust-api")).toBe(
      "OpsCrew has no Dockerfile for Rust and does not build it with Buildpacks, so Railpack builds the image, running the app as a non-root user.",
    );
    expect(reason("laravel-app")).toMatch(/^OpsCrew has no Dockerfile for PHP/);
  });
});

describe("chooseBuilder rules", () => {
  it("sends pnpm and Next.js to the generated Dockerfile", () => {
    const facts = nextPostgresFacts({ packageManager: "pnpm" });
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    expect(result.builder).toBe("generated-dockerfile");
    expect(result.reason).toBe(
      "OpsCrew has a Dockerfile for Next.js with pnpm, which builds a small image that runs as a non-root user.",
    );
  });

  it("probes a static site with wget", () => {
    expect(choice(chooseBuilder(staticSpaFacts(), undefined, "amd64")).probe).toBe("wget");
  });

  it("sends Ruby 4.0.7 to Railpack: the pinned Buildpacks builder offers 4.0.6", () => {
    const facts = makeFacts({
      languages: ["ruby"],
      frameworks: [{ name: "rails", path: "." }],
      runtimeVersions: { ruby: "ruby-4.0.7" },
    });
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    expect(result).toMatchObject({
      builder: "railpack",
      probe: "ruby",
      runtime: { language: "ruby", version: "4.0.7" },
    });
    expect(result.reason).toBe(
      "The pinned Buildpacks builder does not offer Ruby 4.0.7, so Railpack builds the image, running the app as a non-root user.",
    );
  });

  it("uses the repository's own Dockerfile before any other builder", () => {
    const facts = nextPostgresFacts({ docker: { dockerfile: "Dockerfile" } });
    const result = choice(chooseBuilder(facts, undefined, "amd64"));
    // A failed deploy names the builder OpsCrew would choose without the Dockerfile.
    expect(result).toMatchObject({
      builder: "own-dockerfile",
      probe: "none",
      automatic: "generated-dockerfile",
    });
    expect(result.reason).toBe(
      "The repository has its own Dockerfile (Dockerfile), so OpsCrew builds the image with it.",
    );
  });

  it("keeps the generated Dockerfile once adapt has committed it", () => {
    const facts = nextPostgresFacts({ docker: { dockerfile: "Dockerfile" } });
    const plan = planWith({
      builder: "generated-dockerfile",
      chosen: "auto",
      reason: "earlier",
      runtime: { language: "node", version: "24" },
    });
    expect(choice(chooseBuilder(facts, plan, "amd64")).builder).toBe("generated-dockerfile");
  });

  it("keeps the user's choice, with what the automatic choice would be", () => {
    const plan = planWith({
      builder: "railpack",
      chosen: "user",
      reason: "mine",
      runtime: { language: "go", version: "1.26" },
    });
    const result = choice(chooseBuilder(NEW_LANGUAGES["go-api"] as ProjectFacts, plan, "amd64"));
    expect(result).toMatchObject({
      builder: "railpack",
      chosen: "user",
      automatic: "buildpacks",
      probe: "bash",
      reason: "You chose Railpack in opscrew/plan.yaml (app.build.builder).",
    });
  });

  it("refuses a user's builder that cannot build the app", () => {
    const generated = planWith({
      builder: "generated-dockerfile",
      chosen: "user",
      reason: "mine",
      runtime: { language: "rust", version: "1.98" },
    });
    expect(chooseBuilder(NEW_LANGUAGES["rust-api"] as ProjectFacts, generated, "arm64")).toEqual({
      refused:
        "opscrew/plan.yaml sets app.build.builder to generated-dockerfile, but OpsCrew's generated Dockerfile exists only for Node.js and Python apps, and this app runs on Rust. Set it to railpack, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.",
    });
    const buildpacks = planWith({
      builder: "buildpacks",
      chosen: "user",
      reason: "mine",
      runtime: { language: "ruby", version: "4.0.7" },
    });
    const ruby = makeFacts({ languages: ["ruby"], runtimeVersions: { ruby: "4.0.7" } });
    expect(chooseBuilder(ruby, buildpacks, "amd64")).toEqual({
      refused:
        "opscrew/plan.yaml sets app.build.builder to buildpacks, but the pinned Buildpacks builder does not offer Ruby 4.0.7. Set it to railpack, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.",
    });
  });

  describe("a user's Buildpacks for a language OpsCrew does not pick it for (FR-1202)", () => {
    const buildpacks = (language: AppBuild["runtime"]["language"], version?: string) =>
      planWith({
        builder: "buildpacks",
        chosen: "user",
        reason: "mine",
        runtime: { language, ...(version === undefined ? {} : { version }) },
      });
    const unchecked = (runtime: string) =>
      `OpsCrew could not check that the pinned Buildpacks builder offers ${runtime}; the build fails if it does not.`;

    it("allows Node with npm or Yarn, and Python, with a warning", () => {
      const npm = choice(chooseBuilder(nextPostgresFacts(), buildpacks("node", "24"), "amd64"));
      expect(npm).toMatchObject({ builder: "buildpacks", chosen: "user", probe: "bash" });
      expect(npm.warnings).toEqual([unchecked("Node.js 24")]);
      const yarn = nextPostgresFacts({ packageManager: "yarn" });
      expect(choice(chooseBuilder(yarn, buildpacks("node", "24"), "amd64")).builder).toBe(
        "buildpacks",
      );
      const python = makeFacts({ languages: ["python"], packageManager: "pip" });
      const result = choice(chooseBuilder(python, buildpacks("python", "3.14"), "amd64"));
      expect(result.warnings).toEqual([unchecked("Python 3.14")]);
    });

    it("refuses PHP: the pinned Noble builder has none", () => {
      const laravel = NEW_LANGUAGES["laravel-app"] as ProjectFacts;
      expect(chooseBuilder(laravel, buildpacks("php", "8.4"), "amd64")).toEqual({
        refused:
          "opscrew/plan.yaml sets app.build.builder to buildpacks, but the pinned Buildpacks builder has no PHP support. Set it to railpack, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.",
      });
    });

    it("refuses pnpm, Bun and Rust, which the builder does not support", () => {
      for (const [manager, automatic] of [
        ["pnpm", "generated-dockerfile"],
        ["bun", "railpack"],
      ] as const) {
        const facts = nextPostgresFacts({ packageManager: manager });
        expect(chooseBuilder(facts, buildpacks("node", "24"), "amd64")).toEqual({
          refused: `opscrew/plan.yaml sets app.build.builder to buildpacks, but the pinned Buildpacks builder has no ${manager} support. Set it to ${automatic}, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.`,
        });
      }
      const rust = NEW_LANGUAGES["rust-api"] as ProjectFacts;
      expect(chooseBuilder(rust, buildpacks("rust", "1.98"), "amd64")).toMatchObject({
        refused: expect.stringContaining("the pinned Buildpacks builder has no Rust support"),
      });
    });
  });

  describe("a Bun project", () => {
    const BUN_REASON =
      "a Bun project: Railpack builds and runs it with Bun; OpsCrew's Dockerfile and Buildpacks have no Bun";

    it("goes to Railpack, never to OpsCrew's Dockerfile, which would run it on Node.js", () => {
      const facts = nextPostgresFacts({ packageManager: "bun" });
      expect(choice(chooseBuilder(facts, undefined, "amd64"))).toMatchObject({
        builder: "railpack",
        chosen: "auto",
        automatic: "railpack",
        probe: "bash",
        reason: `A${BUN_REASON.slice(1)}.`,
      });
    });

    it("refuses the user's choice of OpsCrew's Dockerfile, with the same reason", () => {
      const facts = nextPostgresFacts({ packageManager: "bun" });
      const generated = planWith({
        builder: "generated-dockerfile",
        chosen: "user",
        reason: "You chose it.",
        runtime: { language: "node", version: "24" },
      });
      expect(chooseBuilder(facts, generated, "amd64")).toEqual({
        refused: `opscrew/plan.yaml sets app.build.builder to generated-dockerfile, but this is ${BUN_REASON}. Set it to railpack, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.`,
      });
    });

    it("keeps the repository's own Dockerfile", () => {
      const facts = nextPostgresFacts({
        packageManager: "bun",
        docker: { dockerfile: "Dockerfile" },
      });
      expect(choice(chooseBuilder(facts, undefined, "amd64"))).toMatchObject({
        builder: "own-dockerfile",
        automatic: "railpack",
      });
    });
  });

  describe("a secret build value (Buildpacks has no secret mounts)", () => {
    const secretValue = (name: string, clientExposed: boolean) => ({
      name,
      files: ["app/javascript/config.js"],
      clientExposed,
      secretLikely: true,
    });
    const rails = (envVars: ProjectFacts["envVars"]) =>
      makeFacts({ ...(NEW_LANGUAGES["rails-api"] as ProjectFacts), envVars });

    it("sends a Buildpacks language to Railpack, naming the value", () => {
      const result = choice(
        chooseBuilder(rails([secretValue("VITE_MAPS_KEY", false)]), undefined, "amd64"),
      );
      expect(result).toMatchObject({ builder: "railpack", automatic: "railpack", probe: "ruby" });
      expect(result.reason).toBe(
        "Buildpacks has no secret mounts for the secret build value VITE_MAPS_KEY, so Railpack builds the image, running the app as a non-root user.",
      );
      const exposed = rails([secretValue("MAPS_KEY", true)]);
      expect(choice(chooseBuilder(exposed, undefined, "amd64")).builder).toBe("railpack");
    });

    it("keeps Buildpacks for a runtime-only secret", () => {
      const runtimeOnly = rails([{ ...secretValue("DATABASE_URL", false), files: ["config.rb"] }]);
      expect(choice(chooseBuilder(runtimeOnly, undefined, "amd64")).builder).toBe("buildpacks");
    });

    it("refuses the user's Buildpacks, saying why", () => {
      const plan = planWith({
        builder: "buildpacks",
        chosen: "user",
        reason: "mine",
        runtime: { language: "ruby", version: "4.0.6" },
      });
      expect(chooseBuilder(rails([secretValue("VITE_MAPS_KEY", false)]), plan, "amd64")).toEqual({
        refused:
          "opscrew/plan.yaml sets app.build.builder to buildpacks, but Buildpacks has no secret mounts, so the secret build value VITE_MAPS_KEY would be baked into the image. Set it to railpack, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.",
      });
    });
  });

  it("is deterministic", () => {
    const facts = NEW_LANGUAGES["laravel-app"] as ProjectFacts;
    expect(chooseBuilder(facts, undefined, "amd64")).toEqual(
      chooseBuilder(facts, undefined, "amd64"),
    );
  });
});

describe("runtimeLanguageOf", () => {
  it("reads Rails and Laravel before their frontend's JavaScript", () => {
    expect(runtimeLanguageOf(NEW_LANGUAGES["laravel-app"] as ProjectFacts)).toBe("php");
    expect(runtimeLanguageOf(NEW_LANGUAGES["rails-api"] as ProjectFacts)).toBe("ruby");
  });

  it("reads a Java project with a JavaScript frontend as Java", () => {
    const facts = makeFacts({ languages: ["java", "javascript"], appKind: "api" });
    expect(runtimeLanguageOf(facts)).toBe("java");
  });

  it("falls back to Node, Python or other", () => {
    expect(runtimeLanguageOf(makeFacts())).toBe("node");
    expect(runtimeLanguageOf(makeFacts({ languages: ["python"] }))).toBe("python");
    expect(runtimeLanguageOf(makeFacts({ languages: ["other"] }))).toBe("other");
  });

  it("gives other languages to Railpack without a version", () => {
    const result = choice(chooseBuilder(makeFacts({ languages: ["other"] }), undefined, "amd64"));
    expect(result).toMatchObject({ builder: "railpack", runtime: { language: "other" } });
    expect(result.runtime.version).toBeUndefined();
  });
});
