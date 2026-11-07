// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { checkDialect, detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { testCloudflareAccount, testContext, testPlan } from "../__fixtures__/plans";
import type { RenderedFile } from "../types";
import { CLOUDFLARE_PROVIDER } from "./hcl";
import { MOVE_LAYOUTS, type MoveLayoutName } from "./layouts";
import {
  backupsRootDir,
  offsiteExpires,
  PREVIOUS_BUCKET_PROFILE,
  renderBackups,
  renderStorage,
} from "./storage";

type StorageProvider = "r2" | "digitalocean" | "hetzner" | "garage";

const REGIONS = { r2: "auto", digitalocean: "fra1", hetzner: "fsn1", garage: "garage" } as const;

/** A plan for `shop` on `example.com` (with `www.`) storing its files at `provider`. */
function storagePlan(
  provider: StorageProvider,
  o: { cors?: boolean; domain?: string | null; www?: boolean } = {},
): DeployPlan {
  const base = testPlan({
    provider: provider === "digitalocean" ? "digitalocean" : "hetzner",
    ...(o.domain === null ? {} : { domain: o.domain ?? "example.com", www: o.www ?? true }),
  });
  return DeployPlanSchema.parse({
    ...base,
    storage: {
      objectStorage: {
        provider,
        bucket: "shop-uploads",
        region: REGIONS[provider],
        cors: o.cors ?? true,
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
      },
    },
  });
}

type S3Provider = "digitalocean" | "hetzner";

/**
 * A plan moving from `from` to the other cloud provider with its bucket: `shop-uploads` there is
 * `plan.storage.objectStorage`, and the bucket being left, `shop-files` at `from`, is
 * `plan.retarget.from.objectStorage`.
 */
function movingPlan(from: S3Provider, o: { cors?: boolean; fromCors?: boolean } = {}): DeployPlan {
  const plan = storagePlan(from === "hetzner" ? "digitalocean" : "hetzner", { cors: o.cors });
  const old = storagePlan(from, { cors: o.fromCors });
  const bucket = old.storage?.objectStorage;
  return DeployPlanSchema.parse({
    ...plan,
    retarget: {
      from: { target: old.target, objectStorage: { ...bucket, bucket: "shop-files" } },
      step: "created",
      startedAt: "2026-11-05T12:00:00.000Z",
    },
  });
}

const ENDPOINTS = {
  digitalocean: (region: string) => `https://\${var.${region}}.digitaloceanspaces.com`,
  hetzner: (region: string) => `https://\${var.${region}}.your-objectstorage.com`,
} as const;

/** A resource or provider block of `main.tf` (from its first line to its closing brace). */
function block(main: string, header: string): string | undefined {
  const start = main.indexOf(`${header} {\n`);
  return start < 0 ? undefined : main.slice(start, main.indexOf("\n}\n", start) + 2);
}

/** The `provider "aws"` blocks of `main.tf`. */
const awsProviders = (main: string) => main.match(/^provider "aws" \{$[\s\S]*?^\}$/gm) ?? [];

const ctx = () => testContext({ cloudflare: testCloudflareAccount() });

function content(files: readonly RenderedFile[], name: string): string {
  const found = files.find((f) => f.path === `opscrew/infra/storage/${name}`);
  if (!found) throw new Error(`no ${name} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

const tfvarsOf = (files: readonly RenderedFile[]) =>
  JSON.parse(content(files, "terraform.tfvars.json")) as Record<string, unknown>;

const PROVIDERS = ["r2", "digitalocean", "hetzner"] as const;

describe("renderStorage", () => {
  it("renders nothing without a provider bucket (none, or Garage on the server)", () => {
    expect(renderStorage(testPlan(), ctx())).toEqual([]);
    expect(renderStorage(storagePlan("garage"), ctx())).toEqual([]);
  });

  for (const provider of PROVIDERS) {
    for (const cors of [true, false]) {
      it(`renders the ${provider} root ${cors ? "with" : "without"} CORS`, () => {
        const files = renderStorage(storagePlan(provider, { cors }), ctx());
        expect(files.map((f) => f.path)).toEqual([
          "opscrew/infra/storage/versions.tf",
          "opscrew/infra/storage/main.tf",
          "opscrew/infra/storage/variables.tf",
          "opscrew/infra/storage/terraform.tfvars.json",
        ]);
        for (const file of files) {
          expect(file.kind).toBe("infra");
          expect(file.content.endsWith("\n")).toBe(true);
          expect(file.content).toMatchSnapshot(file.path.split("/").pop());
        }
        const tf = files.filter((f) => f.path.endsWith(".tf"));
        expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
      });
    }
  }

  it("puts the storage root beside plan.infra.dir", () => {
    const plan = DeployPlanSchema.parse({
      ...storagePlan("hetzner"),
      infra: { dir: "deploy/infra/prod" },
    });
    expect(renderStorage(plan, ctx())[0]?.path).toBe("deploy/infra/storage/versions.tf");
  });

  it("creates the R2 bucket and its CORS through the Cloudflare provider and its usual token", () => {
    const files = renderStorage(storagePlan("r2"), ctx());
    const main = content(files, "main.tf");
    expect(main).toContain('provider "cloudflare" {}');
    expect(main).toContain('resource "cloudflare_r2_bucket" "this" {');
    expect(main).toContain('resource "cloudflare_r2_bucket_cors" "this" {');
    expect(main).not.toContain("aws");
    expect(content(files, "versions.tf")).toContain(`version = "${CLOUDFLARE_PROVIDER.version}"`);
    expect(tfvarsOf(files)).toEqual({
      bucket: "shop-uploads",
      cloudflare_account_id: testCloudflareAccount().accountId,
      cors_origins: ["https://example.com", "https://www.example.com"],
    });
  });

  it("refuses an R2 bucket without the Cloudflare account id", () => {
    expect(() => renderStorage(storagePlan("r2"), testContext())).toThrow(
      /Cloudflare account id is required/,
    );
  });

  for (const [provider, endpoint] of [
    ["digitalocean", "https://${var.region}.digitaloceanspaces.com"],
    ["hetzner", "https://${var.region}.your-objectstorage.com"],
  ] as const) {
    it(`points the aws provider at the ${provider} endpoint, path-style, with AWS's checks off`, () => {
      const files = renderStorage(storagePlan(provider), ctx());
      const main = content(files, "main.tf");
      expect(main).toContain('provider "aws" {');
      expect(main).toContain(`s3 = "${endpoint}"`);
      for (const setting of [
        "s3_use_path_style",
        "skip_credentials_validation",
        "skip_metadata_api_check",
        "skip_region_validation",
        "skip_requesting_account_id",
      ]) {
        expect(main).toMatch(new RegExp(`^ {2}${setting} += true$`, "m"));
      }
      expect(main).toContain('resource "aws_s3_bucket" "this" {');
      expect(main).toContain('resource "aws_s3_bucket_cors_configuration" "this" {');
      expect(main).not.toContain("cloudflare");
      expect(content(files, "versions.tf")).toMatch(
        /aws = \{\n\s+source {2}= "hashicorp\/aws"\n\s+version = "~> 6\.\d+"/,
      );
      expect(tfvarsOf(files)).toEqual({
        bucket: "shop-uploads",
        region: REGIONS[provider],
        cors_origins: ["https://example.com", "https://www.example.com"],
      });
    });
  }

  it("never destroys the bucket in a plan", () => {
    for (const provider of PROVIDERS) {
      const main = content(renderStorage(storagePlan(provider), ctx()), "main.tf");
      const bucket = main.slice(main.indexOf('_bucket" "this" {'));
      expect(bucket.slice(0, bucket.indexOf("\n}\n"))).toContain(
        ["  lifecycle {", "    prevent_destroy = true", "  }"].join("\n"),
      );
    }
  });

  it("lets the aws provider delete the files only when a destroy is allowed (force_destroy is read from the state)", () => {
    for (const provider of ["digitalocean", "hetzner"] as const) {
      const main = content(renderStorage(storagePlan(provider), ctx()), "main.tf");
      expect(main).toContain("  force_destroy = true\n");
      expect(main).toContain("prevent_destroy = true");
    }
    // Cloudflare deletes an R2 bucket only when it is empty: no such setting.
    expect(content(renderStorage(storagePlan("r2"), ctx()), "main.tf")).not.toContain(
      "force_destroy",
    );
  });

  it("renders the root for deleting the data without prevent_destroy, and otherwise the same", () => {
    for (const provider of PROVIDERS) {
      const kept = renderStorage(storagePlan(provider), ctx());
      const deleted = renderStorage(storagePlan(provider), ctx(), { deleteData: true });
      expect(deleted.map((f) => f.path)).toEqual(kept.map((f) => f.path));
      const main = content(deleted, "main.tf");
      expect(main).not.toContain("prevent_destroy = true");
      expect(main).toContain("You asked OpsCrew to delete the app's data");
      expect(main.includes("force_destroy = true")).toBe(provider !== "r2");
      for (const name of ["versions.tf", "variables.tf", "terraform.tfvars.json"]) {
        expect(content(deleted, name)).toBe(content(kept, name));
      }
    }
  });

  it("allows GET, PUT and POST from the app's own origins only, and only with cors", () => {
    for (const provider of PROVIDERS) {
      const withCors = renderStorage(storagePlan(provider, { www: false }), ctx());
      expect(tfvarsOf(withCors).cors_origins).toEqual(["https://example.com"]);
      expect(content(withCors, "main.tf")).toContain('["GET", "PUT", "POST"]');
      expect(content(withCors, "main.tf")).toContain("var.cors_origins");

      const without = renderStorage(storagePlan(provider, { cors: false }), ctx());
      for (const file of without) expect(file.content, file.path).not.toMatch(/cors/i);
    }
  });

  it("sets the S3 CORS rule's max_age_seconds, which Hetzner reads back as 0 when unset", () => {
    for (const provider of ["digitalocean", "hetzner"] as const) {
      const main = content(renderStorage(storagePlan(provider), ctx()), "main.tf");
      expect(main).toMatch(/^ {4}max_age_seconds += 3600$/m);
    }
  });

  it("refuses CORS without a domain: the app's origin is not known", () => {
    expect(() => renderStorage(storagePlan("hetzner", { domain: null }), ctx())).toThrow(
      /browser uploads need the app's domain/,
    );
    expect(
      renderStorage(storagePlan("hetzner", { domain: null, cors: false }), ctx()),
    ).toHaveLength(4);
  });

  describe("keys", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("never writes a storage key into a file: the provider reads it from the environment", () => {
      const keyId = fakeSecret("aws-access-key-id", "storage");
      const secret = fakeSecret("aws-secret-access-key", "storage");
      vi.stubEnv("AWS_ACCESS_KEY_ID", keyId);
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", secret);
      vi.stubEnv("TF_VAR_storage_secret_access_key", secret);
      const plans = [...PROVIDERS.map((provider) => storagePlan(provider)), movingPlan("hetzner")];
      for (const plan of plans) {
        for (const file of renderStorage(plan, ctx())) {
          expect(file.content, file.path).not.toContain(keyId);
          expect(file.content, file.path).not.toContain(secret);
          // No key argument, variable or output that could carry one into a plan or the state.
          expect(file.content, file.path).not.toMatch(/access_key|secret_key|sensitive|output/);
        }
      }
    });
  });
});

/** `plan` with the off-server copies of its snapshots in `offsite`'s bucket. */
function withOffsite(
  plan: DeployPlan,
  offsite: NonNullable<DeployPlan["snapshots"]>["offsite"],
): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, snapshots: { offsite } });
}

const OFFSITE = {
  r2: { provider: "r2", bucket: "shop-backups" },
  hetzner: { provider: "hetzner", bucket: "shop-backups", region: "fsn1", days: 30 },
  digitalocean: { provider: "digitalocean", bucket: "shop-backups", region: "fra1" },
} as const;

/** The file `name` of the `backups` root of the first app's prod. */
function backupsFile(files: readonly RenderedFile[], name: string): string {
  const found = files.find((f) => f.path === `opscrew/infra/backups/${name}`);
  if (!found) throw new Error(`no ${name} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

describe("renderBackups", () => {
  it("renders nothing without the off-server copy, and leaves the storage root as it is", () => {
    expect(renderBackups(storagePlan("hetzner"), ctx())).toEqual([]);
    const plan = withOffsite(storagePlan("hetzner"), OFFSITE.r2);
    expect(renderStorage(plan, ctx())).toEqual(renderStorage(storagePlan("hetzner"), ctx()));
  });

  it("puts the root beside plan.infra.dir, named like the storage root, for each app and environment", () => {
    const STAGING = {
      name: "staging",
      deploySource: { from: "main" as const },
      runner: "github" as const,
    };
    const plan = withOffsite(testPlan(), OFFSITE.r2);
    expect(renderBackups(plan, ctx()).map((f) => f.path)).toEqual([
      "opscrew/infra/backups/versions.tf",
      "opscrew/infra/backups/main.tf",
      "opscrew/infra/backups/variables.tf",
      "opscrew/infra/backups/terraform.tfvars.json",
    ]);
    const named = { ...plan, app: { ...plan.app, key: "docs" }, environment: STAGING };
    expect(backupsRootDir(named)).toBe("opscrew/infra/backups-docs-staging");
    expect(backupsRootDir({ ...plan, environment: STAGING })).toBe("opscrew/infra/backups-staging");
  });

  it("expires R2's copies through Cloudflare's lifecycle, with no versioning", () => {
    const files = renderBackups(withOffsite(testPlan(), OFFSITE.r2), ctx());
    const main = backupsFile(files, "main.tf");
    expect(main).toContain('provider "cloudflare" {}');
    expect(main).toContain('resource "cloudflare_r2_bucket" "this" {');
    expect(main).toContain('resource "cloudflare_r2_bucket_lifecycle" "this" {');
    expect(main).toContain('conditions = { prefix = "backups/" }');
    expect(main).toContain('condition = { type = "Age", max_age = var.days * 86400 }');
    expect(main).not.toMatch(/aws|versioning/);
    expect(JSON.parse(backupsFile(files, "terraform.tfvars.json"))).toEqual({
      bucket: "shop-backups",
      cloudflare_account_id: testCloudflareAccount().accountId,
      days: 90,
    });
    expect(() => renderBackups(withOffsite(testPlan(), OFFSITE.r2), testContext())).toThrow(
      /Cloudflare account id is required/,
    );
  });

  it("keeps Hetzner's copies versioned and expires them and their older versions", () => {
    const files = renderBackups(withOffsite(testPlan(), OFFSITE.hetzner), ctx());
    const main = backupsFile(files, "main.tf");
    expect(main).toContain('s3 = "https://${var.region}.your-objectstorage.com"');
    expect(main).toContain('resource "aws_s3_bucket" "this" {');
    expect(block(main, 'resource "aws_s3_bucket_versioning" "this"')).toContain(
      'status = "Enabled"',
    );
    const rule = block(main, 'resource "aws_s3_bucket_lifecycle_configuration" "this"') ?? "";
    for (const line of [
      "depends_on = [aws_s3_bucket_versioning.this]",
      'prefix = "backups/"',
      "days = var.days",
      "noncurrent_days = var.days",
      "days_after_initiation = 1",
    ]) {
      expect(rule).toContain(line);
    }
    // Hetzner never reads back the transition-size header the provider sends by default (live,
    // 2026-11-07): sent, the provider waits for it until its create times out.
    expect(rule).toContain('  transition_default_minimum_object_size = ""\n');
    expect(main).not.toContain("cloudflare");
    expect(JSON.parse(backupsFile(files, "terraform.tfvars.json"))).toEqual({
      bucket: "shop-backups",
      region: "fsn1",
      days: 30,
    });
  });

  it("gives Spaces the bucket alone: the script deletes old copies there", () => {
    const files = renderBackups(withOffsite(testPlan(), OFFSITE.digitalocean), ctx());
    const main = backupsFile(files, "main.tf");
    expect(main).toContain('s3 = "https://${var.region}.digitaloceanspaces.com"');
    expect(main).toContain('resource "aws_s3_bucket" "this" {');
    expect(main).not.toMatch(/versioning|lifecycle_configuration|var\.days/);
    expect(JSON.parse(backupsFile(files, "terraform.tfvars.json"))).toEqual({
      bucket: "shop-backups",
      region: "fra1",
    });
    expect(offsiteExpires("digitalocean")).toBe(false);
    expect(offsiteExpires("hetzner") && offsiteExpires("r2")).toBe(true);
  });

  it("never destroys the bucket, never deletes its files, holds no key and is dialect-neutral", () => {
    const keyId = fakeSecret("aws-access-key-id", "backups");
    for (const offsite of Object.values(OFFSITE)) {
      const files = renderBackups(withOffsite(testPlan(), offsite), ctx());
      const main = backupsFile(files, "main.tf");
      const bucket = main.slice(main.indexOf('_bucket" "this" {'));
      expect(bucket.slice(0, bucket.indexOf("\n}\n"))).toContain(
        ["  lifecycle {", "    prevent_destroy = true", "  }"].join("\n"),
      );
      expect(main).not.toContain("force_destroy");
      for (const file of files) {
        expect(file.kind).toBe("infra");
        expect(file.content).not.toContain(keyId);
        expect(file.content, file.path).not.toMatch(/access_key|secret_key|sensitive|output/);
      }
      const tf = files.filter((f) => f.path.endsWith(".tf"));
      expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
    }
  });
});

describe("renderStorage while the bucket moves to another provider", () => {
  const ORIGINS = ["https://example.com", "https://www.example.com"];
  const resources = (main: string) =>
    [...main.matchAll(/^resource "(\w+)" "(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
  const moves = (main: string) =>
    [...main.matchAll(/^moved \{\n {2}from = (\S+)\n {2}to {3}= (\S+)\n\}$/gm)].map(
      (m) => `${m[1]} -> ${m[2]}`,
    );
  const endpoints = (main: string) =>
    awsProviders(main).map((provider) => /^ {4}s3 = "([^"]+)"$/m.exec(provider)?.[1]);

  for (const from of ["hetzner", "digitalocean"] as const) {
    const to = from === "hetzner" ? "digitalocean" : "hetzner";

    it(`keeps the bucket being left at ${from} beside the new one, behind a provider of its own`, () => {
      const plan = movingPlan(from);
      const files = renderStorage(plan, ctx());
      const main = content(files, "main.tf");
      expect(endpoints(main)).toEqual([
        ENDPOINTS[to]("region"),
        ENDPOINTS[from]("previous_region"),
      ]);
      const [current, previous] = awsProviders(main);
      expect(current).not.toMatch(/alias|profile/);
      expect(previous).toContain(
        'provider "aws" {\n  alias   = "previous"\n  profile = "opscrew-previous"\n',
      );
      expect(resources(main)).toEqual([
        "aws_s3_bucket.this",
        "aws_s3_bucket_cors_configuration.this",
        "aws_s3_bucket.previous",
        "aws_s3_bucket_cors_configuration.previous",
      ]);
      const old = block(main, 'resource "aws_s3_bucket" "previous"') ?? "";
      expect(old).toContain("  provider = aws.previous\n  bucket   = var.previous_bucket\n");
      expect(old).toContain("  force_destroy = true\n");
      expect(old).toContain("  lifecycle {\n    prevent_destroy = true\n  }\n}");
      expect(block(main, 'resource "aws_s3_bucket_cors_configuration" "previous"')).toContain(
        "  provider = aws.previous\n  bucket   = aws_s3_bucket.previous.id\n",
      );
      expect(moves(main)).toEqual([]);
      expect(tfvarsOf(files)).toEqual({
        bucket: "shop-uploads",
        region: REGIONS[to],
        previous_bucket: "shop-files",
        previous_region: REGIONS[from],
        cors_origins: ORIGINS,
      });
      // The layouts with both buckets render this same root.
      expect(renderStorage(plan, ctx(), { layout: "both" })).toEqual(files);
      expect(renderStorage(plan, ctx(), { layout: "switched" })).toEqual(files);
    });
  }

  it("renames the bucket being left in moves-only roots, and keeps a deleted bucket's provider", () => {
    const plan = movingPlan("hetzner");
    const render = (layout: MoveLayoutName) => renderStorage(plan, ctx(), { layout });
    const main = (layout: MoveLayoutName) => content(render(layout), "main.tf");
    const previous = ["aws_s3_bucket.previous", "aws_s3_bucket_cors_configuration.previous"];
    const current = ["aws_s3_bucket.this", "aws_s3_bucket_cors_configuration.this"];
    const renamed = [
      "aws_s3_bucket.this -> aws_s3_bucket.previous",
      "aws_s3_bucket_cors_configuration.this -> aws_s3_bucket_cors_configuration.previous",
    ];
    const newEndpoint = ENDPOINTS.digitalocean("region");
    const oldEndpoint = ENDPOINTS.hetzner("previous_region");

    // rename: only the bucket being left, renamed from the app's bucket in the state.
    expect(resources(main("rename"))).toEqual(previous);
    expect(moves(main("rename"))).toEqual(renamed);
    expect(endpoints(main("rename"))).toEqual([oldEndpoint]);
    expect(tfvarsOf(render("rename"))).toEqual({
      previous_bucket: "shop-files",
      previous_region: "fsn1",
      cors_origins: ORIGINS,
    });
    // finish: the new bucket, and the old one's provider until the old one is deleted.
    expect(resources(main("finish"))).toEqual(current);
    expect(moves(main("finish"))).toEqual([]);
    expect(endpoints(main("finish"))).toEqual([newEndpoint, oldEndpoint]);
    expect(tfvarsOf(render("finish"))).toEqual({
      bucket: "shop-uploads",
      region: "fra1",
      previous_region: "fsn1",
      cors_origins: ORIGINS,
    });
    // abort-remove: the old bucket, and the new one's provider until the new one is deleted.
    expect(resources(main("abort-remove"))).toEqual(previous);
    expect(moves(main("abort-remove"))).toEqual([]);
    expect(endpoints(main("abort-remove"))).toEqual([newEndpoint, oldEndpoint]);
    // abort-rename: the old bucket is the app's again, at its own provider's endpoint.
    expect(resources(main("abort-rename"))).toEqual(current);
    expect(moves(main("abort-rename"))).toEqual(
      renamed.map((move) => move.split(" -> ").reverse().join(" -> ")),
    );
    expect(endpoints(main("abort-rename"))).toEqual([ENDPOINTS.hetzner("region")]);
    expect(tfvarsOf(render("abort-rename"))).toEqual({
      bucket: "shop-files",
      region: "fsn1",
      cors_origins: ORIGINS,
    });
    // Every bucket a root renders is out of reach of a plan.
    for (const layout of ["rename", "finish", "abort-remove", "abort-rename"] as const) {
      const text = main(layout);
      expect(text.match(/prevent_destroy = true/g), layout).toHaveLength(1);
    }
  });

  it("gives the bucket being left a CORS rule only when it had one", () => {
    const main = content(
      renderStorage(movingPlan("hetzner", { fromCors: false }), ctx()),
      "main.tf",
    );
    expect(main).toContain('resource "aws_s3_bucket_cors_configuration" "this"');
    expect(main).not.toContain('resource "aws_s3_bucket_cors_configuration" "previous"');
    const renamed = content(
      renderStorage(movingPlan("hetzner", { fromCors: false }), ctx(), { layout: "rename" }),
      "main.tf",
    );
    expect(renamed).not.toContain("aws_s3_bucket_cors_configuration");
    const neither = renderStorage(movingPlan("hetzner", { cors: false, fromCors: false }), ctx());
    for (const file of neither) expect(file.content, file.path).not.toMatch(/cors/i);
  });

  it("drops prevent_destroy from both buckets only in the root that deletes the data", () => {
    const main = content(
      renderStorage(movingPlan("digitalocean"), ctx(), { deleteData: true }),
      "main.tf",
    );
    expect(main).not.toContain("prevent_destroy");
    expect(main.match(/force_destroy = true/g)).toHaveLength(2);
  });

  it("renders the plain root when no bucket is left, whatever the layout", () => {
    const plan = storagePlan("hetzner");
    expect(renderStorage(plan, ctx(), { layout: "rename" })).toEqual(renderStorage(plan, ctx()));
  });

  it("refuses to move a bucket that is not at Hetzner or DigitalOcean", () => {
    const plan = movingPlan("hetzner");
    const r2 = DeployPlanSchema.parse({ ...plan, storage: storagePlan("r2").storage });
    expect(() => renderStorage(r2, ctx())).toThrow(
      expect.objectContaining({ code: "PHASE_PRECONDITION" }),
    );
  });

  it("is dialect-neutral and matches the snapshots", () => {
    for (const layout of ["both", "rename", "abort-rename"] as const) {
      const files = renderStorage(movingPlan("hetzner"), ctx(), { layout });
      const tf = files.filter((f) => f.path.endsWith(".tf"));
      expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
      for (const name of ["main.tf", "variables.tf"]) {
        expect(content(files, name)).toMatchSnapshot(`${layout}, ${name}`);
      }
    }
  });
});

// Downloads the cloudflare and aws providers from the registry, so it only runs with OPSCREW_IT=1.
// Binaries come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
// Not a credential: a placeholder of the right shape, so the provider configures without a network.
const PLACEHOLDER_TOKEN = "0".repeat(40);

/** What `planOffline` planned: the plan's output and the saved plan as JSON. */
interface Planned {
  stdout: string;
  stderr: string;
  shown: string;
}

describe.skipIf(!runIt)("the storage root validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine)
      console.warn(`[iac-templates] skipping ${name}: no usable ${name} binary`);
    const bin = engine?.binary ?? name;
    // Every root renders the same file names, so one folder per engine downloads each provider
    // once; each test overwrites the root and runs init again.
    let root: Promise<string> | undefined;
    const folder = () => {
      root ??= mkdtemp(join(tmpdir(), `opscrew-storage-${name}-`));
      return root;
    };

    /**
     * Writes `files`, then initialises (a local state named `label`), validates, checks the format
     * and plans the root `root` offline (nothing refreshed) with `env`.
     */
    async function planOffline(
      test: TestContext,
      files: readonly RenderedFile[],
      label: string,
      env: NodeJS.ProcessEnv,
      root = "opscrew/infra/storage",
    ): Promise<Planned> {
      const dir = await folder();
      for (const file of files) {
        const target = join(dir, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      const cwd = join(dir, root);
      const runner = new NodeCommandRunner();
      const init = await runner.run(
        bin,
        [
          "init",
          "-input=false",
          "-no-color",
          `-backend-config=path=${join(dir, `${label}.tfstate`)}`,
          "-reconfigure",
        ],
        { cwd, env },
      );
      if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
        test.skip(`${name} could not download the providers (network needed)`);
      }
      expect(init.exitCode, init.stdout + init.stderr).toBe(0);
      const validate = await runner.run(bin, ["validate", "-no-color"], { cwd, env });
      expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
      const fmt = await runner.run(bin, ["fmt", "-check", "-no-color"], { cwd });
      expect(
        fmt.exitCode,
        `not formatted as ${name} fmt writes it:\n${fmt.stdout}${fmt.stderr}`,
      ).toBe(0);
      const planFile = join(dir, `${label}.tfplan`);
      const plan = await runner.run(
        bin,
        ["plan", "-input=false", "-no-color", "-refresh=false", "-lock=false", `-out=${planFile}`],
        { cwd, env },
      );
      expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
      const shown = await runner.run(bin, ["show", "-json", "-no-color", planFile], { cwd, env });
      expect(shown.exitCode, shown.stderr).toBe(0);
      return { stdout: plan.stdout, stderr: plan.stderr, shown: shown.stdout };
    }

    /** The engine's environment with made-up keys, which no output may show. */
    function keys(label: string): { env: NodeJS.ProcessEnv; secrets: string[] } {
      const keyId = fakeSecret("aws-access-key-id", `${name}-${label}`);
      const secret = fakeSecret("aws-secret-access-key", `${name}-${label}`);
      return {
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
          AWS_ACCESS_KEY_ID: keyId,
          AWS_SECRET_ACCESS_KEY: secret,
        },
        secrets: [keyId, secret],
      };
    }

    const expectNoSecret = (planned: Planned, secrets: readonly string[]) => {
      for (const output of [planned.stdout, planned.stderr, planned.shown]) {
        for (const secret of secrets) expect(output).not.toContain(secret);
      }
    };

    for (const provider of PROVIDERS) {
      // Plans offline (placeholder credentials, local state, nothing refreshed): the bucket and its
      // CORS are planned, and the key the provider read from the environment is in neither the
      // plan's output nor the saved plan.
      it.skipIf(!engine)(
        `validates and plans the ${provider} root with ${name} without the key in the plan`,
        async (test: TestContext) => {
          const { env, secrets } = keys(provider);
          const planned = await planOffline(
            test,
            renderStorage(storagePlan(provider), ctx()),
            provider,
            env,
          );
          const bucket = provider === "r2" ? "cloudflare_r2_bucket" : "aws_s3_bucket";
          expect(planned.stdout).toContain(`${bucket}.this`);
          expect(planned.stdout).toContain('"https://www.example.com"');
          expectNoSecret(planned, secrets);
        },
        600_000,
      );
    }

    // The `backups` root (the off-server copies' bucket) with each provider's rules, its own key in
    // neither the plan's output nor the saved plan.
    for (const offsite of Object.values(OFFSITE)) {
      it.skipIf(!engine)(
        `validates and plans the ${offsite.provider} backups root with ${name} without the key in the plan`,
        async (test: TestContext) => {
          const { env, secrets } = keys(`backups-${offsite.provider}`);
          const files = renderBackups(withOffsite(testPlan(), offsite), ctx());
          const planned = await planOffline(
            test,
            files,
            `backups-${offsite.provider}`,
            env,
            "opscrew/infra/backups",
          );
          for (const [, type] of backupsFile(files, "main.tf").matchAll(
            /^resource "(w+)" "this"/gm,
          )) {
            expect(planned.stdout).toContain(`${type}.this will be created`);
          }
          expectNoSecret(planned, secrets);
        },
        600_000,
      );
    }

    /**
     * {@link keys}, plus the made-up keys of the bucket being left in a shared credentials file
     * (its provider's profile), as during a move.
     */
    async function movingKeys(
      label: string,
    ): Promise<{ env: NodeJS.ProcessEnv; secrets: string[] }> {
      const { env, secrets } = keys(label);
      const credentials = join(await folder(), `${label}.credentials`);
      const previous = [
        fakeSecret("aws-access-key-id", `${name}-${label}-previous`),
        fakeSecret("aws-secret-access-key", `${name}-${label}-previous`),
      ];
      await writeFile(
        credentials,
        `[${PREVIOUS_BUCKET_PROFILE}]\naws_access_key_id = ${previous[0]}\naws_secret_access_key = ${previous[1]}\n`,
      );
      return {
        env: { ...env, AWS_SHARED_CREDENTIALS_FILE: credentials },
        secrets: [...secrets, ...previous],
      };
    }

    // During a move the bucket being left has a provider of its own, which reads that service's
    // key from a profile of the shared credentials file: made-up keys there too, and no key in the
    // plan.
    for (const layout of MOVE_LAYOUTS) {
      it.skipIf(!engine)(
        `validates and plans the ${layout} root of a moving bucket with ${name} without a key in the plan`,
        async (test: TestContext) => {
          const { env, secrets } = await movingKeys(`move-${layout}`);
          const files = renderStorage(movingPlan("hetzner"), ctx(), { layout });
          const planned = await planOffline(test, files, `move-${layout}`, env);
          for (const [, type, slot] of content(files, "main.tf").matchAll(
            /^resource "(\w+)" "(\w+)"/gm,
          )) {
            expect(planned.stdout).toContain(`${type}.${slot} will be created`);
          }
          expectNoSecret(planned, secrets);
        },
        600_000,
      );
    }

    // The rename over the state of the app's bucket before the move (`aws_s3_bucket.this` at the
    // default provider): the bucket moves to `aws_s3_bucket.previous` and its own provider, and
    // nothing is created or deleted.
    it.skipIf(!engine)(
      `plans the rename over the old bucket's state with ${name}: a move, nothing created or deleted`,
      async (test: TestContext) => {
        const label = "rename-over-state";
        const registry = name === "tofu" ? "registry.opentofu.org" : "registry.terraform.io";
        const state = {
          version: 4,
          terraform_version: "1.6.0",
          serial: 1,
          lineage: "3f1c1f0e-0000-4000-8000-000000000001",
          outputs: {},
          resources: [
            {
              mode: "managed",
              type: "aws_s3_bucket",
              name: "this",
              provider: `provider["${registry}/hashicorp/aws"]`,
              instances: [
                {
                  schema_version: 0,
                  attributes: { id: "shop-files", bucket: "shop-files", force_destroy: true },
                  sensitive_attributes: [],
                },
              ],
            },
          ],
        };
        await writeFile(join(await folder(), `${label}.tfstate`), JSON.stringify(state));
        const { env, secrets } = await movingKeys(label);
        const files = renderStorage(movingPlan("hetzner", { fromCors: false }), ctx(), {
          layout: "rename",
        });
        const planned = await planOffline(test, files, label, env);
        expect(planned.stdout).toContain("# (moved from aws_s3_bucket.this)");
        expect(planned.stdout).toMatch(/Plan: 0 to add, \d+ to change, 0 to destroy/);
        expectNoSecret(planned, secrets);
      },
      600_000,
    );
  }
});
