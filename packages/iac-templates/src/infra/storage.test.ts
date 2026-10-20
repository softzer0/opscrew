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
import { renderStorage } from "./storage";

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
      for (const provider of PROVIDERS) {
        for (const file of renderStorage(storagePlan(provider), ctx())) {
          expect(file.content, file.path).not.toContain(keyId);
          expect(file.content, file.path).not.toContain(secret);
          // No key argument, variable or output that could carry one into a plan or the state.
          expect(file.content, file.path).not.toMatch(/access_key|secret_key|sensitive|output/);
        }
      }
    });
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

describe.skipIf(!runIt)("the storage root validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine)
      console.warn(`[iac-templates] skipping ${name}: no usable ${name} binary`);
    const bin = engine?.binary ?? name;
    // Every provider renders the same file names, so one folder per engine downloads each
    // provider once; each test overwrites the root and runs init again.
    let root: Promise<string> | undefined;

    for (const provider of PROVIDERS) {
      // Plans offline (placeholder credentials, local state, nothing refreshed): the bucket and its
      // CORS are planned, and the key the provider read from the environment is in neither the
      // plan's output nor the saved plan.
      it.skipIf(!engine)(
        `validates and plans the ${provider} root with ${name} without the key in the plan`,
        async (test: TestContext) => {
          root ??= mkdtemp(join(tmpdir(), `opscrew-storage-${name}-`));
          const dir = await root;
          for (const file of renderStorage(storagePlan(provider), ctx())) {
            const target = join(dir, file.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.content);
          }
          const cwd = join(dir, "opscrew/infra/storage");
          const keyId = fakeSecret("aws-access-key-id", `${name}-${provider}`);
          const secret = fakeSecret("aws-secret-access-key", `${name}-${provider}`);
          const env = {
            ...process.env,
            CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
            AWS_ACCESS_KEY_ID: keyId,
            AWS_SECRET_ACCESS_KEY: secret,
          };
          const runner = new NodeCommandRunner();
          const init = await runner.run(
            bin,
            [
              "init",
              "-input=false",
              "-no-color",
              `-backend-config=path=${join(dir, `${provider}.tfstate`)}`,
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

          const planFile = join(dir, `${provider}.tfplan`);
          const plan = await runner.run(
            bin,
            [
              "plan",
              "-input=false",
              "-no-color",
              "-refresh=false",
              "-lock=false",
              `-out=${planFile}`,
            ],
            { cwd, env },
          );
          expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
          const bucket = provider === "r2" ? "cloudflare_r2_bucket" : "aws_s3_bucket";
          expect(plan.stdout).toContain(`${bucket}.this`);
          expect(plan.stdout).toContain('"https://www.example.com"');
          const shown = await runner.run(bin, ["show", "-json", "-no-color", planFile], {
            cwd,
            env,
          });
          expect(shown.exitCode, shown.stderr).toBe(0);
          for (const output of [plan.stdout, plan.stderr, shown.stdout]) {
            expect(output).not.toContain(keyId);
            expect(output).not.toContain(secret);
          }
        },
        600_000,
      );
    }
  }
});
