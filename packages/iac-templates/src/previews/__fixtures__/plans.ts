import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan, testServices } from "../../__fixtures__/plans";
import { initStepsFor } from "../../catalog";
import { renderCompose, renderEdgeSite, renderRuntimeFiles } from "../../runtime";
import { runtimeDir } from "../../runtime-dir";
import { NIGHTLY } from "../../workflow/__fixtures__/plans";
import { rollbackCommands, switchCommands } from "../../workflow/switch";
import { type PreviewEnvTemplates, type PreviewSecretFormat, previewSecret } from "../index";

/** The preview environment's base name: previews are `pr-<n>.shop.example.com`. */
export const BASE = "shop.example.com";

/** The image the tests' previews run. */
export const IMAGE_NAME = "ghcr.io/example-org/example-app";

export const REPOSITORY = "example-org/example-app";

export interface PreviewPlanOptions {
  /** The app's name (default `shop-preview`). */
  name?: string;
  /** Postgres (`db`) on the server (default true). */
  postgres?: boolean;
  /** Valkey (`cache`) too. */
  redis?: boolean;
  /** The seed command, `null` for none (default `npm run seed`). */
  seed?: string | null;
  /** The release command (default `npm run migrate`), `null` for none. */
  release?: string | null;
  /** A worker and a cron job (default true). */
  processes?: boolean;
  cap?: number;
  lifetimeDays?: number;
  /** The plan's proxy (default Caddy). */
  edge?: "caddy" | "nginx";
  /** The deploy's strategy (default rolling). */
  strategy?: "rolling" | "recreate";
}

/** A preview environment's plan for `shop`: Postgres, a worker, a cron job, a release command and a seed. */
export function previewPlan(o: PreviewPlanOptions = {}): DeployPlan {
  const base = testPlan({ postgres: o.postgres ?? true });
  const processes = o.processes ?? true;
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      name: o.name ?? "shop-preview",
      ...(o.release === null ? {} : { releaseCommand: o.release ?? "npm run migrate" }),
    },
    target: { ...base.target, ...(o.edge === undefined ? {} : { edge: o.edge }) },
    deploy: { ...base.deploy, ...(o.strategy === undefined ? {} : { strategy: o.strategy }) },
    services: [...base.services, ...testServices({ redis: o.redis ?? false })],
    processes: processes
      ? {
          workers: [{ name: "worker", command: "node worker.js", source: "user" }],
          cron: [NIGHTLY],
        }
      : { workers: [], cron: [] },
    environment: {
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: {
        domain: BASE,
        ...(o.cap === undefined ? {} : { cap: o.cap }),
        ...(o.lifetimeDays === undefined ? {} : { lifetimeDays: o.lifetimeDays }),
        seed: o.seed === undefined ? "npm run seed" : o.seed,
      },
    },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
  });
}

/**
 * Env templates as provision builds them for `plan` (the template plan or a preview's own): the
 * database's address with its generated password, the app's own address, Rails' and Laravel's keys
 * and Garage's key id, each from `secret(name, format)`.
 */
export function envFor(
  plan: DeployPlan,
  secret: (name: string, format: PreviewSecretFormat) => string = previewSecret,
): PreviewEnvTemplates {
  const password = secret("db-password", "hex32");
  const services: Record<string, string> = {};
  for (const service of plan.services.filter((s) => s.enabled)) {
    services[service.name] =
      service.kind === "postgres"
        ? `POSTGRES_USER=app\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=app\n`
        : `VALKEY_PASSWORD=${secret("cache-password", "hex32")}\n`;
  }
  return {
    app: [
      `DATABASE_URL=postgres://app:${password}@db:5432/app`,
      `APP_URL=https://${plan.dns.domain}`,
      `SECRET_KEY_BASE=${secret("SECRET_KEY_BASE", "hex64")}`,
      `APP_KEY=${secret("APP_KEY", "b64k32")}`,
      `S3_ACCESS_KEY_ID=${secret("garage-key-id", "gk")}`,
      "",
    ].join("\n"),
    services,
  };
}

/**
 * The files OpsCrew renders directly for preview `n` of the preview environment's `plan` (the app
 * `<app>-pr-<n>` at `pr-<n>.<base>`), by their path in the preview's folder, with the env templates
 * of {@link envFor} and `secret`'s values: what the recipe's template must fill into.
 */
export function directPreview(
  plan: DeployPlan,
  n: number,
  secret: (name: string, format: PreviewSecretFormat) => string,
): Record<string, string> {
  const previews = plan.environment?.previews;
  if (plan.environment === undefined || previews === undefined) throw new Error("not previews");
  const { previews: _, ...environment } = plan.environment;
  const own: DeployPlan = {
    ...plan,
    environment,
    app: { ...plan.app, name: `${plan.app.name}-pr-${n}` },
    dns: { ...plan.dns, domain: `pr-${n}.${previews.domain}` },
  };
  const runtime = runtimeDir(own);
  const files: Record<string, string> = {};
  for (const file of [
    renderCompose(own, typeof previews.seed === "string" ? { seed: previews.seed } : {}),
    ...renderRuntimeFiles(own),
    ...renderEdgeSite(own, { noindex: true }),
  ]) {
    files[file.path.slice(runtime.length + 1)] = file.content;
  }
  files["start.sh"] = `${switchCommands(own, initStepsFor(own)).join("\n")}\n`;
  files["rollback.sh"] = `${rollbackCommands(own).join("\n")}\n`;
  const env = envFor(own, secret);
  files["env/app.env"] = env.app;
  for (const [name, content] of Object.entries(env.services)) files[`env/${name}.env`] = content;
  return files;
}
