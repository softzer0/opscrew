import {
  type DeployPlan,
  DeployPlanSchema,
  type ImageBuilder,
  type RuntimeLanguage,
} from "@opscrew/plan-schema";
import { designProbe, testPlan } from "../../__fixtures__/plans";

/**
 * `plan` with `app.build` set to `builder` for `language` (default Go 1.26, chosen by design, with
 * the probe design records).
 */
export function withBuild(
  plan: DeployPlan,
  builder: ImageBuilder,
  o: {
    language?: RuntimeLanguage;
    version?: string;
    chosen?: "auto" | "user";
    automatic?: ImageBuilder;
  } = {},
): DeployPlan {
  const language = o.language ?? "go";
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      build: {
        builder,
        chosen: o.chosen ?? "auto",
        reason: "The test chose it.",
        runtime: { language, ...(language === "other" ? {} : { version: o.version ?? "1.26" }) },
        probe: designProbe(builder, language),
        ...(o.automatic === undefined ? {} : { automatic: o.automatic }),
      },
    },
  });
}

/** `plan` with the given top-level sections replaced (and parsed again). */
export function withPlan(
  plan: DeployPlan,
  o: {
    deploy?: Partial<DeployPlan["deploy"]>;
    supplyChain?: Partial<DeployPlan["supplyChain"]>;
    deployTags?: Partial<DeployPlan["cicd"]["deployTags"]>;
    imageRetention?: Partial<DeployPlan["cicd"]["imageRetention"]>;
    releaseCommand?: string;
  },
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      ...(o.releaseCommand === undefined ? {} : { releaseCommand: o.releaseCommand }),
    },
    deploy: { ...plan.deploy, ...o.deploy },
    supplyChain: { ...plan.supplyChain, ...o.supplyChain },
    cicd: {
      ...plan.cicd,
      deployTags: { ...plan.cicd.deployTags, ...o.deployTags },
      imageRetention: { ...plan.cicd.imageRetention, ...o.imageRetention },
    },
  });
}

/** `plan` with the given workers (from the user, defaults for the rest) and cron jobs. */
export function withProcesses(
  plan: DeployPlan,
  o: {
    workers?: readonly { name: string; command: string; enabled?: boolean; count?: number }[];
    cron?: readonly { name: string; schedule: string; command: string; enabled?: boolean }[];
  },
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    processes: {
      workers: (o.workers ?? []).map((worker) => ({ source: "user", ...worker })),
      cron: o.cron ?? [],
    },
  });
}

/** One nightly cron job, enabled. */
export const NIGHTLY = { name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" };

/** The YAML text of job `id` in a rendered workflow, as committed (for snapshots). */
export function jobYaml(content: string, id: string): string {
  const lines = content.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) throw new Error(`The workflow has no job ${id}.`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[a-z]+:$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trimEnd();
}

/** A Hetzner plan with a domain (the shared test plan). */
export function serverPlan(): DeployPlan {
  return testPlan({ domain: "shop.example.com" });
}

/** The shared test plan on the localhost target (edge ports 8443 and 8080), without DNS. */
export function localhostPlan(): DeployPlan {
  return DeployPlanSchema.parse({
    ...testPlan(),
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: { https: 8443, http: 8080 },
      image: "registry",
      edge: "caddy",
    },
  });
}

/**
 * `plan` as one environment's plan, as design writes it: with a `name`, the app name
 * `<app>-<name>`, the domain `<name>-<domain>` and the workflow `opscrew-deploy-<name>.yml`;
 * without one, prod's plan with its `environment` block.
 */
export function inEnvironment(
  plan: DeployPlan,
  environment: {
    name?: string;
    deploySource?: NonNullable<DeployPlan["environment"]>["deploySource"];
    runner?: NonNullable<DeployPlan["environment"]>["runner"];
    runnerHost?: NonNullable<DeployPlan["environment"]>["runnerHost"];
    build?: NonNullable<DeployPlan["environment"]>["build"];
    secrets?: NonNullable<DeployPlan["environment"]>["secrets"];
  },
): DeployPlan {
  const { name } = environment;
  const { domain } = plan.dns;
  return DeployPlanSchema.parse({
    ...plan,
    environment,
    ...(name === undefined
      ? {}
      : {
          app: { ...plan.app, name: `${plan.app.name}-${name}` },
          dns: { ...plan.dns, ...(domain === undefined ? {} : { domain: `${name}-${domain}` }) },
          cicd: { ...plan.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
        }),
  });
}

/**
 * `plan` on SQLite: `storage.sqlite.dir` `dir` (default `storage`), the `recreate` strategy it
 * needs, and for the user's own Dockerfile the folder the app runs in (`workdir`).
 */
export function withSqlite(
  plan: DeployPlan,
  o: { dir?: string; workdir?: string } = {},
): DeployPlan {
  const build = plan.app.build;
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      ...(build === undefined || o.workdir === undefined
        ? {}
        : { build: { ...build, workdir: o.workdir } }),
    },
    storage: { ...plan.storage, sqlite: { dir: o.dir ?? "storage" } },
    deploy: { ...plan.deploy, strategy: "recreate" },
  });
}
