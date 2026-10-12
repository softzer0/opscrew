import { z } from "zod";
import { IsoDateTimeSchema, MoneySchema, ServiceKindSchema, VpsProviderSchema } from "./enums";

/** Allowed difference between the breakdown sum and the monthly total (rounding to cents). */
const SUM_TOLERANCE = 0.01 + 1e-9;

/**
 * Monthly cost estimate. The breakdown amounts sum to `monthly.amount` (within 0.01) and every
 * amount uses the same currency as `monthly`.
 */
export const CostEstimateSchema = z
  .strictObject({
    monthly: MoneySchema,
    breakdown: z.array(z.strictObject({ item: z.string().min(1), monthly: MoneySchema })),
    pricesIncludeVat: z.boolean(),
    /** `live` when read from the provider API, `static` for a dated fallback price list. */
    source: z.enum(["live", "static"]),
    asOf: IsoDateTimeSchema,
  })
  .superRefine((cost, ctx) => {
    let sum = 0;
    cost.breakdown.forEach((line, i) => {
      sum += line.monthly.amount;
      if (line.monthly.currency !== cost.monthly.currency) {
        ctx.addIssue({
          code: "custom",
          path: ["breakdown", i, "monthly", "currency"],
          message: `must be ${cost.monthly.currency}, the currency of the monthly total`,
        });
      }
    });
    if (Math.abs(sum - cost.monthly.amount) > SUM_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["monthly", "amount"],
        message: `must equal the sum of the breakdown (${(Math.round(sum * 100) / 100).toFixed(2)})`,
      });
    }
  });
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/** One deployment option offered by the Architect (not persisted). */
export const DesignOptionSchema = z.strictObject({
  /** For example `hetzner-single-cpx22-nbg1` or `digitalocean-single-s-2vcpu-4gb-fra1`. */
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  target: z.strictObject({
    provider: VpsProviderSchema,
    location: z.string().min(1),
    serverType: z.string().min(1),
    vcpus: z.int().positive(),
    memoryGb: z.number().positive(),
    diskGb: z.number().positive(),
    cpuType: z.enum(["shared", "dedicated"]),
    architecture: z.enum(["x86", "arm"]),
  }),
  /** Self-hosted containers. */
  services: z.strictObject({ postgres: z.boolean(), redis: z.boolean() }),
  externalServices: z.array(ServiceKindSchema),
  backups: z.boolean(),
  cost: CostEstimateSchema,
  fitsBudget: z.boolean(),
  recommended: z.boolean(),
  tradeoffs: z.array(z.string().min(1)),
});
export type DesignOption = z.infer<typeof DesignOptionSchema>;

/** A list of design options: at least one, unique ids, exactly one recommended. */
export const DesignOptionListSchema = z
  .array(DesignOptionSchema)
  .min(1)
  .superRefine((options, ctx) => {
    const ids = new Set<string>();
    options.forEach((option, i) => {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `duplicate option id "${option.id}"`,
        });
      }
      ids.add(option.id);
    });
    const recommended = options.filter((o) => o.recommended).length;
    if (recommended !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `exactly one option must be recommended (found ${recommended})`,
      });
    }
  });
