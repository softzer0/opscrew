import type { CodeChangeKind } from "@opscrew/plan-schema";

/** Playbook ids, one per supported stack plus a generic fallback. */
export type PlaybookId = "nextjs" | "node-server" | "static-spa" | "fastapi" | "django" | "generic";

/**
 * Plain-English instructions for the Code-change agent (and for people making the changes by
 * hand when no model is configured), for one framework.
 */
export interface Playbook {
  id: PlaybookId;
  title: string;
  /** Stack-wide guidance that applies to every change. */
  guidance: readonly string[];
  /** How to make each kind of change in this stack. Kinds not listed use the generic playbook. */
  steps: Partial<Record<CodeChangeKind, string>>;
  /** How to tell each kind of change is done. Kinds not listed use the generic playbook. */
  checks: Partial<Record<CodeChangeKind, readonly string[]>>;
}
