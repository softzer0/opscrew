import { CLOUD_PROVIDER_CONTRACT_VERSION, type CloudProviderDefinition } from "@opscrew/contracts";
import { isRecord, OpsCrewError, zodIssues } from "@opscrew/core";
import { CurrencySchema, RegionSchema } from "@opscrew/plan-schema";
import { z } from "zod";

/** The shared first-boot setup OpsCrew adds to every server module (ADR 0029, D5). */
const SHARED_CLOUD_INIT = "cloud-init.yaml.tftpl";

/** A function of the contract; only its kind is checked. */
function fn<T>() {
  return z.custom<T>((value) => typeof value === "function", "must be a function");
}

type Definition = CloudProviderDefinition;
const regex = z.instanceof(RegExp);
const lines = z.array(z.string());

const tokenRule = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  pattern: regex.refine((pattern) => pattern.global, "must be a global regular expression"),
  group: z.number().int().optional(),
  description: z.string(),
});

const credentials = z.object({
  envVars: z.array(z.string()).min(1, "names no environment variable"),
  mode: z.enum(["any", "all"]),
  createUrl: z.string(),
  tokenRules: z.array(tokenRule),
  envPrefixes: lines,
  apiPattern: regex,
});

const regions = z
  .object({
    locations: z.record(
      RegionSchema,
      z
        .array(z.string(), {
          error: (issue) => (issue.input === undefined ? "maps no location" : undefined),
        })
        .min(1, "maps no location"),
    ),
    locationNames: z.record(z.string(), z.string()),
    notes: z.partialRecord(RegionSchema, z.string()),
    coordinates: z.record(z.string(), z.tuple([z.number(), z.number()])),
  })
  .superRefine(({ locations, locationNames, coordinates }, ctx) => {
    for (const location of new Set(Object.values(locations).flat())) {
      if (!Object.hasOwn(locationNames, location)) {
        ctx.addIssue({
          code: "custom",
          path: ["locationNames", location],
          message: `names no location ${location}`,
        });
      }
      if (!Object.hasOwn(coordinates, location)) {
        ctx.addIssue({
          code: "custom",
          path: ["coordinates", location],
          message: `has no coordinates for ${location}`,
        });
      }
    }
  });

const offering = z.object({
  currency: CurrencySchema,
  defaultImage: z.string(),
  backupPercent: z.number(),
  providerBackups: z.boolean(),
  backupsOutliveServer: z.boolean(),
  snapshots: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("per-gb") }),
    z.object({ kind: z.literal("included") }),
  ]),
  serverSnapshotsOutliveServer: z.boolean(),
  deleteProtection: z.boolean(),
  resize: z.boolean(),
  removal: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("delete") }),
    z.object({
      kind: z.literal("cancel-at-term-end"),
      minimumTermMonths: z.number().int().positive(),
    }),
  ]),
  unavailable: regex,
  serverLimit: regex,
});

const moduleFiles = z.record(z.string(), z.string()).superRefine((files, ctx) => {
  if (Object.keys(files).length === 0) ctx.addIssue({ code: "custom", message: "has no files" });
  if (Object.hasOwn(files, SHARED_CLOUD_INIT)) {
    ctx.addIssue({
      code: "custom",
      path: [SHARED_CLOUD_INIT],
      message: "must not be in the module, OpsCrew adds its own to every server module",
    });
  }
});

const terraform = z.object({
  provider: z.object({ name: z.string(), source: z.string(), version: z.string() }),
  serverResourceType: z.string(),
  firewallResourceType: z.string(),
  mirroredAttributes: z.record(z.string(), lines),
  module: z.object({ name: z.string(), files: moduleFiles }),
  credentialsComment: z.string(),
  deleteProtectionVariable: z.boolean(),
  descriptions: z.object({ location: z.string(), serverType: z.string(), backups: z.string() }),
  moduleArguments: fn<Definition["terraform"]["moduleArguments"]>(),
  extraShared: z.object({
    resources: lines,
    sshKeyId: z.string(),
    appTag: z.string().optional(),
  }),
});

type Texts = Definition["texts"];

const texts = z.object({
  interview: z.object({ label: z.string(), hint: z.string() }),
  design: z.object({
    summaryNoun: z.string(),
    titleSuffix: z.string(),
    livePricesVar: z.string().optional(),
  }),
  init: z.object({ fix: z.string(), scopeNote: z.string() }),
  runbook: z.object({
    serverLabel: fn<Texts["runbook"]["serverLabel"]>(),
    console: z.string(),
    backupsOnDatabaseCell: z.string(),
    backupsOn: z.string(),
    cloudFirewall: z.string(),
    deletes: fn<Texts["runbook"]["deletes"]>(),
    connectNote: lines,
    snapshotReason: z.string(),
    snapshotFirst: lines,
    noSnapshot: lines,
    deleteProtectionNote: lines,
    whatRemains: fn<Texts["runbook"]["whatRemains"]>(),
    hostKey: z.string(),
  }),
  destroy: z.object({
    console: z.string(),
    snapshotRef: fn<Texts["destroy"]["snapshotRef"]>(),
    snapshotBilling: z.string(),
    snapshotBilled: z.string(),
    lookup: fn<Texts["destroy"]["lookup"]>(),
    tokenHint: fn<Texts["destroy"]["tokenHint"]>(),
    deletedBackups: z.string().optional(),
    keptBackups: z.string().optional(),
    keptBackupsRemaining: z.string().optional(),
    storageConsole: z.string().optional(),
  }),
  secops: z.object({
    noun: z.string(),
    rules: fn<Texts["secops"]["rules"]>(),
    attached: fn<Texts["secops"]["attached"]>(),
    attachedText: z.string(),
    unattachedText: z.string(),
    keylessText: z.string(),
    backupsText: z.string(),
  }),
});

/**
 * The contract's shape. Typed against `CloudProviderDefinition`, so a required field the contract
 * gains and this schema lacks fails the typecheck.
 */
const definitionSchema: z.ZodType<Definition> = z.object({
  contractVersion: z.literal(CLOUD_PROVIDER_CONTRACT_VERSION, {
    error: `must be ${CLOUD_PROVIDER_CONTRACT_VERSION}, the contract version this OpsCrew reads`,
  }),
  id: z.string().min(1),
  displayName: z.string(),
  name: z.string(),
  serverNoun: z.string(),
  consoleUrl: z.string(),
  accountUrl: z.string(),
  credentials,
  connector: fn<Definition["connector"]>(),
  regions,
  offering,
  terraform,
  texts,
});

/**
 * Checks a cloud provider definition against the contract (ADR 0029) and returns it unchanged.
 * Throws an `INTERNAL` error naming the provider's id and the parts that fail.
 */
export function validateCloudProvider(candidate: unknown): CloudProviderDefinition {
  const parsed = definitionSchema.safeParse(candidate);
  if (parsed.success) return candidate as CloudProviderDefinition;
  const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : undefined;
  const which =
    id === undefined
      ? "A cloud provider definition without an id"
      : `The cloud provider definition "${id}"`;
  throw new OpsCrewError("INTERNAL", `${which} is not valid: ${zodIssues(parsed.error)}.`, {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}
