import { z } from "zod";
import { MoneySchema } from "./enums";
import { RequirementsSchema } from "./requirements";

/** Requirements fields the interview can ask about. */
export const QuestionIdSchema = RequirementsSchema.keyof().exclude(["schemaVersion", "answeredAt"]);
export type QuestionId = z.infer<typeof QuestionIdSchema>;

/** How a question is answered. */
export const QuestionKindSchema = z.enum([
  "single-select",
  "multi-select",
  "text",
  "money",
  "confirm",
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

const SELECT_KINDS: ReadonlySet<QuestionKind> = new Set(["single-select", "multi-select"]);

/** Checks that a default value has the answer type of the question kind. */
const DEFAULT_MATCHES_KIND: Record<QuestionKind, (value: unknown) => boolean> = {
  "single-select": (v) => typeof v === "string",
  "multi-select": (v) => Array.isArray(v) && v.every((item) => typeof item === "string"),
  text: (v) => typeof v === "string",
  money: (v) => MoneySchema.safeParse(v).success,
  confirm: (v) => typeof v === "boolean",
};

/** One interview question (not persisted; returned by the CLI and the MCP server). */
export const QuestionSchema = z
  .strictObject({
    /** The requirements field this question fills, for example `expectedMonthlyUsers`. */
    id: QuestionIdSchema,
    /** Plain-English question. */
    prompt: z.string().min(1),
    help: z.string().min(1).optional(),
    kind: QuestionKindSchema,
    /** Choices; required (non-empty) for select kinds and not allowed otherwise. */
    options: z
      .array(
        z.strictObject({
          value: z.string().min(1),
          label: z.string().min(1),
          hint: z.string().min(1).optional(),
        }),
      )
      .optional(),
    /** Default answer, of the same type as the answer. */
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string()), MoneySchema])
      .optional(),
    required: z.boolean(),
  })
  .superRefine((q, ctx) => {
    const isSelect = SELECT_KINDS.has(q.kind);
    if (isSelect && (q.options === undefined || q.options.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `is required for "${q.kind}" questions`,
      });
    }
    if (!isSelect && q.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `is only allowed for select questions, not "${q.kind}"`,
      });
    }
    if (q.default === undefined) return;
    if (!DEFAULT_MATCHES_KIND[q.kind](q.default)) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `does not match the answer type of a "${q.kind}" question`,
      });
      return;
    }
    if (isSelect && q.options !== undefined) {
      const values = new Set(q.options.map((o) => o.value));
      const defaults = Array.isArray(q.default) ? q.default : [q.default];
      for (const d of defaults) {
        if (typeof d === "string" && !values.has(d)) {
          ctx.addIssue({
            code: "custom",
            path: ["default"],
            message: `"${d}" is not one of the options`,
          });
        }
      }
    }
  });
export type Question = z.infer<typeof QuestionSchema>;
