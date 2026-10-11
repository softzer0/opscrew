import { z } from "zod";
import { IsoDateTimeSchema } from "./enums";
import { ProjectFactsSchema } from "./facts";

/** `opscrew/architecture.json`: detected facts plus a plain-English summary and risks. */
export const ArchitectureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTimeSchema,
  generator: z.strictObject({
    tool: z.literal("opscrew"),
    version: z.string().min(1),
  }),
  facts: ProjectFactsSchema,
  /** Plain-English description of the app (deterministic template or model-written). */
  summary: z.string(),
  /** Deployment risks in plain English. */
  risks: z.array(z.string()),
  /** True when a model refined the summary or risks. */
  aiEnriched: z.boolean(),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;
