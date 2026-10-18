import {
  BUILDPACKS_OFFERS,
  type DockerStack,
  detectStack,
  isClientExposedEnvName,
} from "@opscrew/iac-templates";
import type {
  AppBuild,
  DeployPlan,
  ImageBuilder,
  ProjectFacts,
  RuntimeLanguage,
} from "@opscrew/plan-schema";
import { frameworkName } from "../analyze/summary";
import { offered, RUNTIME_NAMES, resolveRuntime } from "./runtime-version";

/** A CPU architecture an image is built for. */
export type BuildArch = "amd64" | "arm64";

/** Who builds the image and why (contracts/builders.md "chooseBuilder"). */
export interface BuilderChoice {
  builder: ImageBuilder;
  chosen: "auto" | "user";
  /** One plain sentence naming the deciding fact. */
  reason: string;
  /** What the builder is given; `other` has no version (Railpack picks it). */
  runtime: AppBuild["runtime"];
  /** What an automatic choice would be; printed by a failed deploy when the user's choice is in use. */
  automatic: ImageBuilder;
  /** How the Compose health check probes the app, for a tool the image has. */
  probe: NonNullable<AppBuild["probe"]>;
  /**
   * Plain-English warnings: about the runtime version (end of life, a new release line, a
   * declaration OpsCrew cannot follow) and about the user's Buildpacks for a language OpsCrew
   * cannot check.
   */
  warnings: string[];
}

/** The languages OpsCrew builds with Buildpacks (FR-1201): the ones it has no Dockerfile for. */
type BuildpacksLanguage = keyof typeof BUILDPACKS_OFFERS;

const isBuildpacksLanguage = (language: RuntimeLanguage): language is BuildpacksLanguage =>
  Object.hasOwn(BUILDPACKS_OFFERS, language);

/** Builder names in a sentence. */
const BUILDER_NAMES: Readonly<Record<ImageBuilder, string>> = {
  "generated-dockerfile": "OpsCrew's generated Dockerfile",
  "own-dockerfile": "your own Dockerfile",
  buildpacks: "Buildpacks",
  railpack: "Railpack",
};

/** Languages detected from their own manifests, in the order one is picked when several are. */
const SERVER_LANGUAGES = ["ruby", "php", "go", "java", "rust"] as const;

const hasFramework = (facts: ProjectFacts, name: string) =>
  facts.frameworks.some((f) => f.name === name);

/**
 * The language the app runs on. Rails and Laravel decide first, then FastAPI and Django, then a
 * Ruby, PHP, Go, Java, .NET or Rust project (its JavaScript is the frontend's), then the Node or
 * Python stack OpsCrew has a Dockerfile for, else `other`.
 */
export function runtimeLanguageOf(facts: ProjectFacts): RuntimeLanguage {
  if (hasFramework(facts, "rails")) return "ruby";
  if (hasFramework(facts, "laravel")) return "php";
  if (hasFramework(facts, "fastapi") || hasFramework(facts, "django")) return "python";
  const server = SERVER_LANGUAGES.find((language) => facts.languages.includes(language));
  if (server !== undefined) return server;
  if (facts.runtimeVersions.dotnet !== undefined) return "dotnet";
  const stack = detectStack(facts);
  if (stack === undefined) return "other";
  return stack.startsWith("python-") ? "python" : "node";
}

/** The stack in a sentence: `Next.js with pnpm`, `FastAPI`, `a static site built with Vite`. */
function stackText(facts: ProjectFacts, stack: DockerStack): string {
  const named = (names: readonly string[]) => {
    const found = facts.frameworks.find((f) => names.includes(f.name));
    return found === undefined ? undefined : frameworkName(found.name);
  };
  const manager = ["npm", "pnpm", "yarn", "bun"].includes(facts.packageManager)
    ? ` with ${facts.packageManager}`
    : "";
  switch (stack) {
    case "static-spa": {
      const tool = named(["vite", "angular", "create-react-app", "astro"]);
      return `a static site${tool === undefined ? "" : ` built with ${tool}`}`;
    }
    case "next-standalone":
      return `Next.js${manager}`;
    case "node-server":
      return `${named(["express", "fastify", "nestjs", "hono", "koa", "redwood"]) ?? "a Node.js server"}${manager}`;
    case "python-fastapi":
      return "FastAPI";
    case "python-django":
      return "Django";
    case "python-generic":
      return named(["flask"]) ?? "a Python app";
  }
}

/** How the health check probes an image from `builder` (see `AppBuild.probe`). */
function probeFor(
  builder: ImageBuilder,
  language: RuntimeLanguage,
  stack: DockerStack | undefined,
): BuilderChoice["probe"] {
  switch (builder) {
    case "own-dockerfile":
      return "none";
    case "generated-dockerfile":
      return stack === "static-spa" ? "wget" : language === "python" ? "python" : "node";
    case "buildpacks":
      return language === "ruby" ? "ruby" : "bash";
    case "railpack":
      return language === "ruby" ? "ruby" : language === "php" ? "php" : "bash";
  }
}

type Decision = Pick<BuilderChoice, "builder" | "reason">;

/**
 * The first secret value the build needs: a variable baked into the frontend at build time
 * (client-exposed) that is secret. Buildpacks cannot mount it as a BuildKit secret.
 */
function secretBuildValue(facts: ProjectFacts): string | undefined {
  return facts.envVars.find(
    (v) => (isClientExposedEnvName(v.name) || v.clientExposed) && v.secretLikely,
  )?.name;
}

/** Rules 2–5 of the contract: the builder OpsCrew picks itself. */
function automaticChoice(
  facts: ProjectFacts,
  language: RuntimeLanguage,
  version: string | undefined,
  stack: DockerStack | undefined,
  ownsGeneratedDockerfile: boolean,
): Decision {
  const dockerfile = facts.docker.dockerfile;
  if (dockerfile !== undefined && !ownsGeneratedDockerfile) {
    return {
      builder: "own-dockerfile",
      reason: `The repository has its own Dockerfile (${dockerfile}), so OpsCrew builds the image with it.`,
    };
  }
  if ((language === "node" || language === "python") && stack !== undefined) {
    return {
      builder: "generated-dockerfile",
      reason: `OpsCrew has a Dockerfile for ${stackText(facts, stack)}, which builds a small image that runs as a non-root user.`,
    };
  }
  const name = `${RUNTIME_NAMES[language]}${version === undefined ? "" : ` ${version}`}`;
  if (isBuildpacksLanguage(language) && version !== undefined) {
    if (!offered(version, BUILDPACKS_OFFERS[language])) {
      return {
        builder: "railpack",
        reason: `The pinned Buildpacks builder does not offer ${name}, so Railpack builds the image, running the app as a non-root user.`,
      };
    }
    const secret = secretBuildValue(facts);
    if (secret !== undefined) {
      return {
        builder: "railpack",
        reason: `Buildpacks has no secret mounts for the secret build value ${secret}, so Railpack builds the image, running the app as a non-root user.`,
      };
    }
    return {
      builder: "buildpacks",
      reason: `Buildpacks builds ${name} as a non-root image, smaller than Railpack's.`,
    };
  }
  return {
    builder: "railpack",
    reason: `OpsCrew has no Dockerfile for ${RUNTIME_NAMES[language]} and does not build it with Buildpacks, so Railpack builds the image, running the app as a non-root user.`,
  };
}

/** What checking the user's builder found: why it cannot build the app, or warnings. */
type UserCheck = { problem: string } | { warnings: string[] };

/**
 * The user's Buildpacks for this app (FR-1202): refused without a secret mount for a secret build
 * value, for a version the pinned builder does not offer, and where the builder has no support
 * (pnpm, Bun, Rust, other languages); allowed with a warning for Node with npm or Yarn, Python and
 * PHP, whose offered versions OpsCrew cannot check.
 */
function buildpacksCheck(
  facts: ProjectFacts,
  language: RuntimeLanguage,
  version: string | undefined,
): UserCheck {
  const secret = secretBuildValue(facts);
  if (secret !== undefined) {
    return {
      problem: `Buildpacks has no secret mounts, so the secret build value ${secret} would be baked into the image`,
    };
  }
  const runtime = `${RUNTIME_NAMES[language]}${version === undefined ? "" : ` ${version}`}`;
  if (isBuildpacksLanguage(language)) {
    return version !== undefined && offered(version, BUILDPACKS_OFFERS[language])
      ? { warnings: [] }
      : { problem: `the pinned Buildpacks builder does not offer ${runtime}` };
  }
  if (language === "node" && (facts.packageManager === "pnpm" || facts.packageManager === "bun")) {
    return { problem: `the pinned Buildpacks builder has no ${facts.packageManager} support` };
  }
  if (language !== "node" && language !== "python" && language !== "php") {
    return { problem: `the pinned Buildpacks builder has no ${RUNTIME_NAMES[language]} support` };
  }
  const warnings = [
    `OpsCrew could not check that the pinned Buildpacks builder offers ${runtime}; the build fails if it does not.`,
  ];
  if (hasFramework(facts, "laravel")) {
    warnings.push(
      "Buildpacks' default NGINX configuration does not route Laravel's front controller, so the app answers 404 until you add your own NGINX configuration for it.",
    );
  }
  return { warnings };
}

/** Whether the user's builder can build this app, and what to warn about when it can. */
function userChoiceCheck(
  facts: ProjectFacts,
  builder: ImageBuilder,
  language: RuntimeLanguage,
  version: string | undefined,
  stack: DockerStack | undefined,
): UserCheck {
  const name = BUILDER_NAMES[builder];
  if (builder === "generated-dockerfile" && !(language === "node" || language === "python")) {
    return {
      problem: `${name} exists only for Node.js and Python apps, and this app runs on ${RUNTIME_NAMES[language]}`,
    };
  }
  if (builder === "generated-dockerfile" && stack === undefined) {
    return { problem: `${name} has no template for this app` };
  }
  if (builder === "buildpacks") return buildpacksCheck(facts, language, version);
  return { warnings: [] };
}

/**
 * Chooses who builds the app's image (contracts/builders.md "chooseBuilder"), in this order: the
 * user's builder (`plan.app.build.chosen: user`) when it can build the app, else `{ refused }`
 * (for Buildpacks see {@link buildpacksCheck}); the repository's own Dockerfile (unless it is the
 * one OpsCrew generated, recorded as `generated-dockerfile`); OpsCrew's Dockerfile for the Node and
 * Python stacks it has one for; Buildpacks for Go, Java, .NET and Ruby versions its pinned builder
 * offers, unless the build needs a secret value (Buildpacks has no secret mounts); Railpack for
 * everything else. The runtime version follows FR-1228 ({@link resolveRuntime}). Every builder
 * builds for amd64 and arm64 (research R7, R8), so the architecture, part of the contract for
 * `retarget`, decides nothing today. Pure and deterministic: the same inputs give the same result
 * and the same reason.
 */
export function chooseBuilder(
  facts: ProjectFacts,
  plan: Pick<DeployPlan, "app"> | undefined,
  _arch: BuildArch,
): BuilderChoice | { refused: string } {
  const recorded = plan?.app.build;
  const language = runtimeLanguageOf(facts);
  const offers = isBuildpacksLanguage(language) ? BUILDPACKS_OFFERS[language] : [];
  const { runtime, warnings } = resolveRuntime(language, facts, recorded?.runtime, offers);
  const stack = language === "node" || language === "python" ? detectStack(facts) : undefined;
  const auto = automaticChoice(
    facts,
    language,
    runtime.version,
    stack,
    recorded?.builder === "generated-dockerfile",
  );
  const common = { runtime, automatic: auto.builder, warnings };
  if (recorded?.chosen === "user") {
    const check = userChoiceCheck(facts, recorded.builder, language, runtime.version, stack);
    if ("problem" in check) {
      return {
        refused: `opscrew/plan.yaml sets app.build.builder to ${recorded.builder}, but ${check.problem}. Set it to ${auto.builder}, or set app.build.chosen to auto to let OpsCrew choose; plan.yaml was not changed.`,
      };
    }
    return {
      ...common,
      warnings: [...warnings, ...check.warnings],
      builder: recorded.builder,
      chosen: "user",
      reason: `You chose ${BUILDER_NAMES[recorded.builder]} in opscrew/plan.yaml (app.build.builder).`,
      probe: probeFor(recorded.builder, language, stack),
    };
  }
  return {
    ...common,
    builder: auto.builder,
    chosen: "auto",
    reason: auto.reason,
    probe: probeFor(auto.builder, language, stack),
  };
}
