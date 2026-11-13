import type {
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  ObjectStorageApi,
  ObjectStorageKey,
  ProviderObjectStorage,
  ResourceChange,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { FakeEngine } from "./deploy";

/** A provider of the app's bucket in the storage tests. */
type BucketAt = "r2" | "hetzner" | "digitalocean" | "contabo";

/** Each provider's region of the app's bucket in the storage tests. */
const BUCKET_REGIONS = {
  r2: "auto",
  hetzner: "fsn1",
  digitalocean: "fra1",
  contabo: "EU",
} as const;

/** The bucket's resources as a plan of the `storage` root creates them. */
export function bucketChanges(
  provider: BucketAt,
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
export function withBucket(plan: DeployPlan, provider: BucketAt) {
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
        region: BUCKET_REGIONS[provider],
        cors: false,
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: {
          monthly: provider === "r2" ? 0 : provider === "contabo" ? 2.49 : 6.49,
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
 * `.opscrew/storage-delete`, and its state file `storage.tfstate`) and every other root's (`main`),
 * picked by the root module's folder. Records the environment of each `storage` call.
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
    return (/storage\.tfstate$/.test(stateFile) ? this.storage : this.main).stateResources(
      stateFile,
      options,
    );
  }
  untaint(dir: string, address: string, options?: IacRunOptions) {
    return this.#pick(dir, options).untaint(dir, address, options);
  }
  stateRemove(dir: string, addresses: readonly string[], options?: IacRunOptions) {
    return this.#pick(dir, options).stateRemove(dir, addresses, options);
  }
  importResource(dir: string, address: string, id: string, options?: IacRunOptions) {
    return this.#pick(dir, options).importResource(dir, address, id, options);
  }
}

/** A fake `storage` engine whose plans create (or with `action`, change) the bucket. */
export function bucketEngine(
  provider: BucketAt,
  scenario: ConstructorParameters<typeof FakeEngine>[0] = {},
): FakeEngine {
  return new FakeEngine({
    changes: bucketChanges(provider),
    outputs: {},
    planJson: { format_version: "1.2", planned_values: { root_module: {} } },
    ...scenario,
  });
}

/** The S3 endpoint of the fake Contabo storage. */
export const CONTABO_S3_URL = "https://eu2.contabostorage.com";

/**
 * Contabo's object storage API, faked: the account's storages, what was ordered, and the key
 * Contabo made with each storage (synthetic). `orderAnswer` makes the next order refused, or lose
 * its answer (the order may have been made).
 */
export class FakeObjectStorage implements ObjectStorageApi {
  readonly orders: { region: string; sizeTb: number; displayName: string }[] = [];
  readonly keysRead: string[] = [];
  orderAnswer: "ordered" | "refused" | "lost" = "ordered";
  /** The key Contabo made with every storage here. */
  readonly madeKey: ObjectStorageKey = {
    accessKeyId: fakeSecret("aws-access-key-id", "contabo-storage"),
    secretAccessKey: fakeSecret("aws-secret-access-key", "contabo-storage"),
  };

  constructor(readonly storages: ProviderObjectStorage[] = []) {}

  async find(region: string): Promise<ProviderObjectStorage | undefined> {
    return this.storages.find((storage) => storage.region === region);
  }

  async order(request: { region: string; sizeTb: number; displayName: string }) {
    this.orders.push(request);
    if (this.orderAnswer === "refused") {
      return {
        refused: "Contabo answered HTTP 400 to POST /v1/object-storages: Region not available",
      };
    }
    if (this.orderAnswer === "lost") {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        "Lost the connection to Contabo's API (POST /v1/object-storages).",
        {
          hint: "The change may still have been made: check the Customer Control Panel before trying again.",
        },
      );
    }
    const storage = {
      id: `os-${this.orders.length}`,
      region: request.region,
      s3Url: CONTABO_S3_URL,
    };
    this.storages.push(storage);
    return { ordered: storage };
  }

  async key(storageId: string): Promise<ObjectStorageKey> {
    this.keysRead.push(storageId);
    return this.madeKey;
  }
}
