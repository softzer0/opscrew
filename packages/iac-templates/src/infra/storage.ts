// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { OFFSITE_PREFIX } from "../offsite";
import { wrongTarget } from "../providers";
import type { RenderContext, RenderedFile } from "../types";
import { planFilePath } from "../workflow/shared";
import { accountId } from "./cloudflare";
import {
  besideInfraDir,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  type ProviderRequirement,
  rootHeader,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import type { MoveLayoutName } from "./layouts";

/** The object storage OpsCrew creates a bucket for through the `storage` root. */
export type BucketProvider = "r2" | "digitalocean" | "hetzner";

/** A bucket of the plan (`storage.objectStorage`, `retarget.from.objectStorage`). */
type ObjectStorage = NonNullable<NonNullable<DeployPlan["storage"]>["objectStorage"]>;

/** The plan's bucket at a provider. */
export type ProviderBucket = ObjectStorage & { provider: BucketProvider };

/** The plan's bucket at a provider, or undefined (no object storage, or Garage next to the app). */
export function providerBucket(plan: Pick<DeployPlan, "storage">): ProviderBucket | undefined {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined || storage.provider === "garage") return undefined;
  return storage as ProviderBucket;
}

/** A bucket at a cloud provider's S3-compatible storage, which a move can take along. */
type S3Bucket = ProviderBucket & { provider: "digitalocean" | "hetzner" };

/** `bucket` when it is at Hetzner or DigitalOcean; throws {@link wrongTarget} otherwise. */
function s3Bucket(bucket: ObjectStorage | undefined): S3Bucket {
  if (bucket?.provider !== "hetzner" && bucket?.provider !== "digitalocean") {
    throw wrongTarget(
      "A bucket moves only between Hetzner Object Storage and DigitalOcean Spaces, and both the bucket being left and the new one must be there.",
    );
  }
  return bucket as S3Bucket;
}

/**
 * The profile of the shared credentials file (`AWS_SHARED_CREDENTIALS_FILE`) the provider of the
 * bucket being left reads its key from during a move: the other provider's key is in the
 * engine's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
 */
export const PREVIOUS_BUCKET_PROFILE = "opscrew-previous";

const AWS_PROVIDER: ProviderRequirement = {
  name: "aws",
  source: "hashicorp/aws",
  version: "~> 6.69",
};

/** The S3-compatible services OpsCrew reaches through the `aws` provider. */
const S3_SERVICES = {
  digitalocean: {
    name: "DigitalOcean Spaces",
    endpoint: (region: string) => `https://\${var.${region}}.digitaloceanspaces.com`,
    regionDescription: (what: string) => `Spaces region of ${what}, for example fra1.`,
    providerRegion: (_region: string) => [
      "  # Spaces creates buckets only with us-east-1 here; the endpoint picks the real region.",
      '  region = "us-east-1"',
    ],
  },
  hetzner: {
    name: "Hetzner Object Storage",
    endpoint: (region: string) => `https://\${var.${region}}.your-objectstorage.com`,
    regionDescription: (what: string) =>
      `Hetzner Object Storage location of ${what}, for example fsn1.`,
    providerRegion: (region: string) => [`  region = var.${region}`],
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
        hint: `Give the app a domain in ${planFilePath(plan)} (dns.domain), or set storage.objectStorage.cors to false if the app does not upload from the browser, then run the command again.`,
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

/**
 * What an S3 storage root holds: the bucket as `this` (the app's) and as `previous` (the bucket
 * being left during a move), the endpoints of the default `aws` provider and of its `previous`
 * alias, and a `moved` block renaming the bucket between the two in the state.
 */
interface S3Shape {
  current?: S3Bucket;
  previous?: S3Bucket;
  /** The bucket whose service the default `aws` provider reaches. */
  provider?: S3Bucket;
  /** The bucket whose service the `aws.previous` provider reaches. */
  alias?: S3Bucket;
  moved?: { from: "this" | "previous"; to: "this" | "previous"; cors: boolean };
}

/**
 * The storage root of layout `name` of a move from bucket `old` to bucket `next` (as the infra
 * root's layouts, {@link MoveLayoutName}). A bucket a layout no longer holds keeps its provider,
 * which deletes it; `moved` blocks rename a bucket only in roots that do not declare its old name.
 */
function moveShape(name: MoveLayoutName, next: S3Bucket, old: S3Bucket): S3Shape {
  switch (name) {
    case "rename":
      return { previous: old, alias: old, moved: { from: "this", to: "previous", cors: old.cors } };
    case "both":
    case "switched":
      return { current: next, previous: old, provider: next, alias: old };
    case "finish":
      return { current: next, provider: next, alias: old };
    case "abort-remove":
      return { previous: old, provider: next, alias: old };
    case "abort-rename":
      return {
        current: old,
        provider: old,
        moved: { from: "previous", to: "this", cors: old.cors },
      };
  }
}

/** The `provider "aws"` block reaching `bucket`'s service; `previous` makes it the alias. */
function s3Provider(bucket: Pick<S3Bucket, "provider">, previous: boolean): string[] {
  const service = S3_SERVICES[bucket.provider];
  const region = previous ? "previous_region" : "region";
  return [
    ...(previous
      ? [
          "# The provider of the bucket being left, until the move is finished or aborted. It reads that",
          `# service's key from the ${PREVIOUS_BUCKET_PROFILE} profile of the shared credentials file`,
          "# (AWS_SHARED_CREDENTIALS_FILE), so it is never stored in files, plans or state either.",
        ]
      : [
          "# OpsCrew never creates storage keys: the provider reads yours from the AWS_ACCESS_KEY_ID and",
          "# AWS_SECRET_ACCESS_KEY environment variables, so it is never stored in files, plans or state.",
        ]),
    'provider "aws" {',
    ...(previous ? ['  alias   = "previous"', `  profile = "${PREVIOUS_BUCKET_PROFILE}"`, ""] : []),
    ...service.providerRegion(region),
    "",
    "  endpoints {",
    `    s3 = "${service.endpoint(region)}"`,
    "  }",
    "",
    `  # ${service.name} speaks S3 but is not AWS: no AWS account, region or key checks.`,
    "  s3_use_path_style           = true",
    "  skip_credentials_validation = true",
    "  skip_metadata_api_check     = true",
    "  skip_region_validation      = true",
    "  skip_requesting_account_id  = true",
    "}",
  ];
}

/** The bucket `slot` and, with `cors`, its CORS rule. */
function s3Resources(slot: "this" | "previous", cors: boolean, deleteData: boolean): string[] {
  const { comment, lifecycle } = guard(deleteData);
  const previous = slot === "previous";
  return [
    ...(previous ? ["# The bucket being left, kept until the move is finished or aborted."] : []),
    ...comment,
    `resource "aws_s3_bucket" "${slot}" {`,
    ...(previous
      ? ["  provider = aws.previous", "  bucket   = var.previous_bucket"]
      : ["  bucket = var.bucket"]),
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
          `resource "aws_s3_bucket_cors_configuration" "${slot}" {`,
          ...(previous
            ? ["  provider = aws.previous", "  bucket   = aws_s3_bucket.previous.id"]
            : ["  bucket = aws_s3_bucket.this.id"]),
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

/** The `moved` blocks renaming the bucket (and its CORS rule) in the state. */
function movedBlocks({ from, to, cors }: NonNullable<S3Shape["moved"]>): string[] {
  const block = (type: string) => [
    "moved {",
    `  from = ${type}.${from}`,
    `  to   = ${type}.${to}`,
    "}",
  ];
  return [
    to === "previous"
      ? "# The app's bucket becomes the bucket being left in the state; nothing changes at the provider."
      : "# The bucket being left is the app's bucket again in the state; nothing changes at the provider.",
    ...block("aws_s3_bucket"),
    ...(cors ? ["", ...block("aws_s3_bucket_cors_configuration")] : []),
  ];
}

/** `parts` in order, each after a blank line but the first; empty parts are left out. */
function sections(...parts: readonly (readonly string[])[]): string[] {
  return parts
    .filter((part) => part.length > 0)
    .flatMap((part, i) => (i === 0 ? part : ["", ...part]));
}

function s3Main(shape: S3Shape, deleteData: boolean): string[] {
  return sections(
    shape.provider ? s3Provider(shape.provider, false) : [],
    shape.alias ? s3Provider(shape.alias, true) : [],
    shape.current ? s3Resources("this", shape.current.cors, deleteData) : [],
    shape.previous ? s3Resources("previous", shape.previous.cors, deleteData) : [],
    shape.moved ? movedBlocks(shape.moved) : [],
  );
}

/** The variables of an S3 root and their values. */
function s3Variables(shape: S3Shape): { specs: VariableSpec[]; values: Record<string, unknown> } {
  const specs: VariableSpec[] = [];
  const values: Record<string, unknown> = {};
  const add = (spec: VariableSpec, value: unknown) => {
    specs.push(spec);
    values[spec.name] = value;
  };
  if (shape.current) {
    add(
      { name: "bucket", type: "string", description: "Name of the bucket." },
      shape.current.bucket,
    );
  }
  if (shape.provider) {
    const description = S3_SERVICES[shape.provider.provider].regionDescription("the bucket");
    add({ name: "region", type: "string", description }, shape.provider.region);
  }
  if (shape.previous) {
    add(
      { name: "previous_bucket", type: "string", description: "Name of the bucket being left." },
      shape.previous.bucket,
    );
  }
  if (shape.alias) {
    const service = S3_SERVICES[shape.alias.provider];
    add(
      {
        name: "previous_region",
        type: "string",
        description: service.regionDescription("the bucket being left"),
      },
      shape.alias.region,
    );
  }
  return { specs, values };
}

/**
 * The `storage` root's folder, beside `plan.infra.dir`: `storage`, then a further app's key and
 * the environment's name outside prod, each after `-` (`opscrew/infra/storage` for the first app's
 * prod, `opscrew/infra/storage-<env>`, `opscrew/infra/storage-<key>`,
 * `opscrew/infra/storage-<key>-<env>`). No key or environment name starts with `storage`, so it is
 * never an infrastructure root of its own.
 */
export function storageRootDir(plan: Pick<DeployPlan, "app" | "infra" | "environment">): string {
  const name = ["storage", plan.app.key, plan.environment?.name]
    .filter((part) => part !== undefined)
    .join("-");
  return besideInfraDir(plan, name);
}

/**
 * The `storage` root ({@link storageRootDir}, beside `plan.infra.dir`) when
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
 *
 * While the bucket moves (`plan.retarget.from.objectStorage`, the bucket being left, between
 * Hetzner and DigitalOcean), the root holds both buckets: the new one (`storage.objectStorage`) as
 * `aws_s3_bucket.this` through the default `aws` provider, and the one being left as
 * `aws_s3_bucket.previous` (variables `previous_bucket`, `previous_region`) with `prevent_destroy`,
 * through the `aws.previous` provider at its own service's endpoint, which reads that service's key
 * from the {@link PREVIOUS_BUCKET_PROFILE} profile of the shared credentials file. `layout` picks
 * the move's step as the infra root's layouts do (default `both`): `rename` holds only the bucket
 * being left, renamed from `this` in the state; `finish` only the new bucket (the old one is
 * deleted through its provider); `abort-remove` only the bucket being left (the new one is
 * deleted); `abort-rename` the bucket being left as `this` again, at its own endpoint. Without a
 * bucket being left, `layout` changes nothing. Deterministic; contains no secrets.
 */
export function renderStorage(
  plan: DeployPlan,
  ctx: RenderContext,
  options: { deleteData?: boolean; layout?: MoveLayoutName } = {},
): RenderedFile[] {
  const deleteData = options.deleteData === true;
  const old = plan.retarget?.from.objectStorage;
  const storage = providerBucket(plan);
  if (old === undefined && storage === undefined) return [];
  let main: string[];
  let provider: ProviderRequirement;
  let variables: VariableSpec[];
  let values: Record<string, unknown>;
  let cors: boolean;
  if (old === undefined && storage?.provider === "r2") {
    variables = [
      { name: "bucket", type: "string", description: "Name of the bucket." },
      {
        name: "cloudflare_account_id",
        type: "string",
        description: "Cloudflare account id (R2 buckets belong to the account).",
      },
    ];
    values = { bucket: storage.bucket, cloudflare_account_id: accountId(ctx) };
    main = r2Main(storage.cors, deleteData);
    provider = CLOUDFLARE_PROVIDER;
    cors = storage.cors;
  } else {
    const bucket = s3Bucket(storage);
    const shape =
      old === undefined
        ? { current: bucket, provider: bucket }
        : moveShape(options.layout ?? "both", bucket, s3Bucket(old));
    ({ specs: variables, values } = s3Variables(shape));
    main = s3Main(shape, deleteData);
    provider = AWS_PROVIDER;
    cors = shape.current?.cors === true || shape.previous?.cors === true;
  }
  if (cors) {
    variables.push({
      name: "cors_origins",
      type: "list(string)",
      description: "The app's own origins, allowed to upload from the browser.",
    });
    values.cors_origins = corsOrigins(plan);
  }
  return rootFiles(plan, storageRootDir(plan), { provider, main, variables, values });
}

/** A bucket root's four files in `dir`: its provider, `main`, its variables and their values. */
function rootFiles(
  plan: DeployPlan,
  dir: string,
  root: {
    provider: ProviderRequirement;
    main: readonly string[];
    variables: readonly VariableSpec[];
    values: Record<string, unknown>;
  },
): RenderedFile[] {
  return [
    { path: `${dir}/versions.tf`, content: versionsTf(plan, [root.provider]), kind: "infra" },
    {
      path: `${dir}/main.tf`,
      content: [rootHeader(plan), "", ...root.main, ""].join("\n"),
      kind: "infra",
    },
    { path: `${dir}/variables.tf`, content: variablesTf(plan, root.variables), kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(root.values, null, 2)}\n`,
      kind: "infra",
    },
  ];
}

/**
 * Whether the off-server copy's bucket at `provider` expires old copies itself, through the
 * `backups` root's lifecycle rule (Hetzner, with versioning; R2, which has none). Where it does
 * not (DigitalOcean Spaces, untested live: neither), `snapshot.sh` deletes the copies older than
 * the retention after each upload (024 plan.md 7.).
 */
export function offsiteExpires(provider: BucketProvider): boolean {
  return provider !== "digitalocean";
}

/**
 * The `backups` root's folder, beside `plan.infra.dir` as the `storage` root's
 * ({@link storageRootDir}): `backups`, then a further app's key and the environment's name outside
 * prod, each after `-`. No key or environment name starts with `backups`.
 */
export function backupsRootDir(plan: Pick<DeployPlan, "app" | "infra" | "environment">): string {
  const name = ["backups", plan.app.key, plan.environment?.name]
    .filter((part) => part !== undefined)
    .join("-");
  return besideInfraDir(plan, name);
}

const BACKUPS_COMMENT = [
  "# The bucket of the encrypted copies of the app's snapshots (snapshots.offsite), which only your",
  "# age key opens. OpsCrew never creates storage keys: you create one for this bucket.",
  "# Never destroyed by a plan, a destroy included: the copies outlive the server, which is what",
  "# they are for. Delete the bucket yourself when you no longer need them.",
];

const BACKUPS_GUARD = ["", "  lifecycle {", "    prevent_destroy = true", "  }"];

const BACKUPS_RULE = "opscrew-backups";

/** R2's bucket and its lifecycle rule: copies deleted `var.days` after their upload. */
function r2Backups(): string[] {
  return [
    ...CLOUDFLARE_PROVIDER_BLOCK,
    ...BACKUPS_COMMENT,
    'resource "cloudflare_r2_bucket" "this" {',
    "  account_id = var.cloudflare_account_id",
    "  name       = var.bucket",
    ...BACKUPS_GUARD,
    "}",
    "",
    `# Deletes each copy under ${OFFSITE_PREFIX}/ var.days days after its upload, and uploads left`,
    "# unfinished after a day. R2 keeps no older versions of a file.",
    'resource "cloudflare_r2_bucket_lifecycle" "this" {',
    "  account_id  = var.cloudflare_account_id",
    "  bucket_name = cloudflare_r2_bucket.this.name",
    "",
    "  rules = [{",
    `    id         = "${BACKUPS_RULE}"`,
    "    enabled    = true",
    `    conditions = { prefix = "${OFFSITE_PREFIX}/" }`,
    "    delete_objects_transition = {",
    '      condition = { type = "Age", max_age = var.days * 86400 }',
    "    }",
    "    abort_multipart_uploads_transition = {",
    '      condition = { type = "Age", max_age = 86400 }',
    "    }",
    "  }]",
    "}",
  ];
}

/**
 * The bucket at Hetzner or Spaces (the root's own provider, with the bucket's key) and, where the
 * provider expires copies ({@link offsiteExpires}), versioning and the lifecycle rule.
 */
function s3Backups(provider: "hetzner" | "digitalocean"): string[] {
  const bucket = [
    ...BACKUPS_COMMENT,
    'resource "aws_s3_bucket" "this" {',
    "  bucket = var.bucket",
    ...BACKUPS_GUARD,
    "}",
  ];
  const expiry = offsiteExpires(provider)
    ? [
        "",
        "# The server's key can delete and overwrite copies, as every provider's key can: versioning",
        "# keeps what it deleted or overwrote as older versions, for var.days days more.",
        'resource "aws_s3_bucket_versioning" "this" {',
        "  bucket = aws_s3_bucket.this.id",
        "",
        "  versioning_configuration {",
        '    status = "Enabled"',
        "  }",
        "}",
        "",
        `# Expires each copy under ${OFFSITE_PREFIX}/ var.days days after its upload, its older versions`,
        "# var.days days after they were replaced, and uploads left unfinished after a day.",
        'resource "aws_s3_bucket_lifecycle_configuration" "this" {',
        "  bucket     = aws_s3_bucket.this.id",
        "  depends_on = [aws_s3_bucket_versioning.this]",
        "",
        "  # Empty: the provider sends no transition-size header, which Hetzner never reads back, so",
        "  # the provider's check that the rule is in place would wait until it times out.",
        '  transition_default_minimum_object_size = ""',
        "",
        "  rule {",
        `    id     = "${BACKUPS_RULE}"`,
        '    status = "Enabled"',
        "",
        "    filter {",
        `      prefix = "${OFFSITE_PREFIX}/"`,
        "    }",
        "",
        "    expiration {",
        "      days = var.days",
        "    }",
        "",
        "    noncurrent_version_expiration {",
        "      noncurrent_days = var.days",
        "    }",
        "",
        "    abort_incomplete_multipart_upload {",
        "      days_after_initiation = 1",
        "    }",
        "  }",
        "}",
      ]
    : [];
  return [...s3Provider({ provider }, false), "", ...bucket, ...expiry];
}

/**
 * The `backups` root ({@link backupsRootDir}, D9) when `snapshots.offsite` is on: the bucket of the
 * off-server copies, with its own state, plan and approval, apart from the app's `storage` root,
 * so moves, data deletion and drift never handle its key. It holds only that bucket, with
 * `prevent_destroy` always: OpsCrew never deletes the copies.
 * - R2: `cloudflare_r2_bucket` through the Cloudflare provider (`CLOUDFLARE_API_TOKEN`), with a
 *   lifecycle rule deleting copies `days` after their upload; needs `ctx.cloudflare.accountId`.
 * - Hetzner: `aws_s3_bucket` through `hashicorp/aws` at its endpoint, as the `storage` root's
 *   (the bucket's own key in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`), with versioning and
 *   a lifecycle rule expiring copies and their older versions after `days`.
 * - Spaces: the bucket alone; `snapshot.sh` deletes old copies ({@link offsiteExpires}).
 * Deterministic; contains no secrets.
 */
export function renderBackups(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) return [];
  const { provider } = offsite;
  const variables: VariableSpec[] = [
    { name: "bucket", type: "string", description: "Name of the off-server copies' bucket." },
  ];
  const values: Record<string, unknown> = { bucket: offsite.bucket };
  if (provider === "r2") {
    variables.push({
      name: "cloudflare_account_id",
      type: "string",
      description: "Cloudflare account id (R2 buckets belong to the account).",
    });
    values.cloudflare_account_id = accountId(ctx);
  } else {
    const service = S3_SERVICES[provider];
    variables.push({
      name: "region",
      type: "string",
      description: service.regionDescription("the off-server copies' bucket"),
    });
    values.region = offsite.region;
  }
  if (offsiteExpires(provider)) {
    variables.push({
      name: "days",
      type: "number",
      description: "Days each copy is kept (snapshots.offsite.days).",
    });
    values.days = offsite.days;
  }
  return rootFiles(plan, backupsRootDir(plan), {
    provider: provider === "r2" ? CLOUDFLARE_PROVIDER : AWS_PROVIDER,
    main: provider === "r2" ? r2Backups() : s3Backups(provider),
    variables,
    values,
  });
}
