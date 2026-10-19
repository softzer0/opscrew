import type {
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  ResourceChange,
} from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { FakeEngine } from "../../testing";

/** The bucket's resources as a plan of the `storage` root creates them. */
export function bucketChanges(
  provider: "r2" | "hetzner" | "digitalocean",
  action: ResourceChange["action"] = "create",
): ResourceChange[] {
  const r2 = provider === "r2";
  return [
    {
      address: r2 ? "cloudflare_r2_bucket.this" : "aws_s3_bucket.this",
      type: r2 ? "cloudflare_r2_bucket" : "aws_s3_bucket",
      name: "this",
      provider: r2
        ? "registry.opentofu.org/cloudflare/cloudflare"
        : "registry.opentofu.org/hashicorp/aws",
      action,
    },
  ];
}

/**
 * `plan` keeping the app's files in the bucket `shop-uploads` at `provider`, without CORS, with
 * the variables design gives the app for it.
 */
export function withBucket(plan: DeployPlan, provider: "r2" | "hetzner" | "digitalocean") {
  const variables = ["AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL_S3", "AWS_REGION"].map((name) => ({
    name,
    secret: name === "AWS_ACCESS_KEY_ID",
    source: "derived" as const,
  }));
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      env: [
        ...plan.app.env,
        ...variables,
        { name: "AWS_SECRET_ACCESS_KEY", secret: true, source: "derived" },
      ],
    },
    storage: {
      objectStorage: {
        provider,
        bucket: "shop-uploads",
        region: provider === "r2" ? "auto" : provider === "hetzner" ? "fsn1" : "fra1",
        cors: false,
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: {
          monthly: provider === "r2" ? 0 : 6.49,
          currency: provider === "digitalocean" ? "USD" : "EUR",
          source: "test",
          checkedOn: "2026-10-19",
        },
      },
    },
  });
}

/**
 * One engine for two roots: the `storage` root's fake (`storage`, also for its deletion copy in
 * `.opscrew/storage-delete`) and every other root's (`main`), picked by the root module's folder.
 * Records the environment of each `storage` call.
 */
export class RootEngine<S extends IacEngine = FakeEngine> implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  /** The environment of every call into the `storage` root. */
  readonly storageEnvs: Record<string, string | undefined>[] = [];

  constructor(
    readonly main: IacEngine,
    readonly storage: S,
  ) {}

  #pick(dir: string, options?: IacRunOptions): IacEngine {
    if (!/[\\/]storage(?:-delete)?$/.test(dir)) return this.main;
    if (options?.env !== undefined) this.storageEnvs.push(options.env);
    return this.storage;
  }

  init(dir: string, options?: IacInitOptions) {
    return this.#pick(dir, options).init(dir, options);
  }
  validate(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).validate(dir, options);
  }
  plan(dir: string, planFile: string, options?: IacRunOptions & { destroy?: boolean }) {
    return this.#pick(dir, options).plan(dir, planFile, options);
  }
  apply(dir: string, planFile: string, approval: IacApproval, options?: IacRunOptions) {
    return this.#pick(dir, options).apply(dir, planFile, approval, options);
  }
  output(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).output(dir, options);
  }
  providerSchemas(dir: string, options?: IacRunOptions) {
    return this.#pick(dir, options).providerSchemas(dir, options);
  }
  stateResources(stateFile: string, options?: IacRunOptions) {
    return this.main.stateResources(stateFile, options);
  }
}

/** A fake `storage` engine whose plans create (or with `action`, change) the bucket. */
export function bucketEngine(
  provider: "r2" | "hetzner" | "digitalocean",
  scenario: ConstructorParameters<typeof FakeEngine>[0] = {},
): FakeEngine {
  return new FakeEngine({
    changes: bucketChanges(provider),
    outputs: {},
    planJson: { format_version: "1.2", planned_values: { root_module: {} } },
    ...scenario,
  });
}
