// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";
import { accountId } from "./cloudflare";
import {
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  type ProviderRequirement,
  ROOT_HEADER,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";

const AWS_PROVIDER: ProviderRequirement = {
  name: "aws",
  source: "hashicorp/aws",
  version: "~> 6.69",
};

/** The S3-compatible services OpsCrew reaches through the `aws` provider. */
const S3_SERVICES = {
  digitalocean: {
    name: "DigitalOcean Spaces",
    endpoint: "https://${var.region}.digitaloceanspaces.com",
    regionDescription: "Spaces region of the bucket, for example fra1.",
    providerRegion: [
      "  # Spaces creates buckets only with us-east-1 here; the endpoint picks the real region.",
      '  region = "us-east-1"',
    ],
  },
  hetzner: {
    name: "Hetzner Object Storage",
    endpoint: "https://${var.region}.your-objectstorage.com",
    regionDescription: "Hetzner Object Storage location of the bucket, for example fsn1.",
    providerRegion: ["  region = var.region"],
  },
} as const;

const NEVER_DESTROYED = [
  "# Never destroyed by a plan: OpsCrew deletes the bucket and its files only when you ask it to",
  "# delete data.",
];
const DELETED = [
  "# You asked OpsCrew to delete the app's data: this copy of the root lets its destroy plan",
  "# delete the bucket and its files.",
];
const PREVENT_DESTROY = ["", "  lifecycle {", "    prevent_destroy = true", "  }"];

/** The bucket's guard: `prevent_destroy`, except in the root that deletes the data. */
function guard(deleteData: boolean) {
  return deleteData
    ? { comment: DELETED, lifecycle: [] }
    : { comment: NEVER_DESTROYED, lifecycle: PREVENT_DESTROY };
}
const CORS_COMMENT = "# Browser uploads with presigned links, from the app's own origins only.";
const CORS_METHODS = '["GET", "PUT", "POST"]';

/** The app's own origins: its domain and, when it serves one, its `www.` alias. */
function corsOrigins(plan: DeployPlan): string[] {
  const { domain, www } = plan.dns;
  if (domain === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The bucket's browser uploads need the app's domain: without one, OpsCrew cannot tell which site may upload.",
      {
        hint: "Give the app a domain in opscrew/plan.yaml (dns.domain), or set storage.objectStorage.cors to false if the app does not upload from the browser, then run the command again.",
      },
    );
  }
  return www ? [`https://${domain}`, `https://www.${domain}`] : [`https://${domain}`];
}

function r2Main(cors: boolean, deleteData: boolean): string[] {
  const { comment, lifecycle } = guard(deleteData);
  return [
    ...CLOUDFLARE_PROVIDER_BLOCK,
    "# The app's bucket on Cloudflare R2. OpsCrew never creates storage keys: you create an R2",
    "# token limited to this bucket after it exists.",
    ...comment,
    'resource "cloudflare_r2_bucket" "this" {',
    "  account_id = var.cloudflare_account_id",
    "  name       = var.bucket",
    ...lifecycle,
    "}",
    ...(cors
      ? [
          "",
          CORS_COMMENT,
          'resource "cloudflare_r2_bucket_cors" "this" {',
          "  account_id  = var.cloudflare_account_id",
          "  bucket_name = cloudflare_r2_bucket.this.name",
          "",
          "  rules = [{",
          "    allowed = {",
          `      methods = ${CORS_METHODS}`,
          "      origins = var.cors_origins",
          '      headers = ["*"]',
          "    }",
          '    expose_headers = ["ETag"]',
          "  }]",
          "}",
        ]
      : []),
  ];
}

function s3Main(
  service: (typeof S3_SERVICES)[keyof typeof S3_SERVICES],
  cors: boolean,
  deleteData: boolean,
): string[] {
  const { comment, lifecycle } = guard(deleteData);
  return [
    "# OpsCrew never creates storage keys: the provider reads yours from the AWS_ACCESS_KEY_ID and",
    "# AWS_SECRET_ACCESS_KEY environment variables, so it is never stored in files, plans or state.",
    'provider "aws" {',
    ...service.providerRegion,
    "",
    "  endpoints {",
    `    s3 = "${service.endpoint}"`,
    "  }",
    "",
    `  # ${service.name} speaks S3 but is not AWS: no AWS account, region or key checks.`,
    "  s3_use_path_style           = true",
    "  skip_credentials_validation = true",
    "  skip_metadata_api_check     = true",
    "  skip_region_validation      = true",
    "  skip_requesting_account_id  = true",
    "}",
    "",
    ...comment,
    'resource "aws_s3_bucket" "this" {',
    "  bucket = var.bucket",
    "",
    "  # Deletes the files with the bucket. The provider reads it from the state when the bucket is",
    "  # destroyed, so it is set from the start; only a destroy you allowed ever uses it.",
    "  force_destroy = true",
    ...lifecycle,
    "}",
    ...(cors
      ? [
          "",
          CORS_COMMENT,
          'resource "aws_s3_bucket_cors_configuration" "this" {',
          "  bucket = aws_s3_bucket.this.id",
          "",
          "  cors_rule {",
          '    allowed_headers = ["*"]',
          `    allowed_methods = ${CORS_METHODS}`,
          "    allowed_origins = var.cors_origins",
          '    expose_headers  = ["ETag"]',
          "    # Set, because a provider that reads an unset value back as 0 would plan a change.",
          "    max_age_seconds = 3600",
          "  }",
          "}",
        ]
      : []),
  ];
}

/** The `storage` root's folder, beside `plan.infra.dir`: `opscrew/infra/storage`. */
export function storageRootDir(plan: Pick<DeployPlan, "infra">): string {
  const infraDir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${infraDir.slice(0, infraDir.lastIndexOf("/") + 1)}storage`;
}

/**
 * The `storage` root (`opscrew/infra/storage`, beside `plan.infra.dir`) when
 * `storage.objectStorage` is a provider bucket; none for Garage, which runs on the server. It
 * holds only the bucket and, with `cors`, a rule letting the app's own origins send GET, PUT and
 * POST:
 * - R2: `cloudflare_r2_bucket` through the Cloudflare provider (`CLOUDFLARE_API_TOKEN`, as in the
 *   other roots); needs `ctx.cloudflare.accountId`.
 * - Spaces and Hetzner: `aws_s3_bucket` through `hashicorp/aws` at the provider's S3 endpoint,
 *   path-style, with AWS's account, region and key checks off. The user's key reaches the provider
 *   only as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the engine's environment, so no key
 *   is in a rendered file, a saved plan or the state.
 *
 * The bucket has `prevent_destroy`: no plan, a destroy included, deletes it or its files. With
 * `deleteData` (`opscrew destroy --delete-data`) it is rendered without it, for the destroy plan
 * the user approves. The aws provider's bucket always has `force_destroy`, which the provider reads
 * from the state when the bucket is destroyed; R2 deletes only an empty bucket.
 * Deterministic; contains no secrets.
 */
export function renderStorage(
  plan: DeployPlan,
  ctx: RenderContext,
  options: { deleteData?: boolean } = {},
): RenderedFile[] {
  const deleteData = options.deleteData === true;
  const storage = plan.storage?.objectStorage;
  if (storage === undefined || storage.provider === "garage") return [];
  const variables: VariableSpec[] = [
    { name: "bucket", type: "string", description: "Name of the bucket." },
  ];
  const values: Record<string, unknown> = { bucket: storage.bucket };
  let main: string[];
  let provider: ProviderRequirement;
  if (storage.provider === "r2") {
    variables.push({
      name: "cloudflare_account_id",
      type: "string",
      description: "Cloudflare account id (R2 buckets belong to the account).",
    });
    values.cloudflare_account_id = accountId(ctx);
    main = r2Main(storage.cors, deleteData);
    provider = CLOUDFLARE_PROVIDER;
  } else {
    const service = S3_SERVICES[storage.provider];
    variables.push({ name: "region", type: "string", description: service.regionDescription });
    values.region = storage.region;
    main = s3Main(service, storage.cors, deleteData);
    provider = AWS_PROVIDER;
  }
  if (storage.cors) {
    variables.push({
      name: "cors_origins",
      type: "list(string)",
      description: "The app's own origins, allowed to upload from the browser.",
    });
    values.cors_origins = corsOrigins(plan);
  }
  const dir = storageRootDir(plan);
  return [
    { path: `${dir}/versions.tf`, content: versionsTf([provider]), kind: "infra" },
    { path: `${dir}/main.tf`, content: [ROOT_HEADER, "", ...main, ""].join("\n"), kind: "infra" },
    { path: `${dir}/variables.tf`, content: variablesTf(variables), kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(values, null, 2)}\n`,
      kind: "infra",
    },
  ];
}
