import { isRecord } from "@opscrew/core";
import type { InterviewAnswers } from "./questions";

/** True for an answer that was not given: missing, `null` or only blanks. */
export function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

/** `{ default: value }` for a question, or nothing when there is no default. */
export function withDefault<T>(value: T | undefined): { default?: T } {
  return value === undefined ? {} : { default: value };
}

/** The follow-up answers under one prefix (`server.*`, `portainer.*`), split from the rest. */
export interface FollowUps<F extends string> {
  /** `<prefix>.<field>` answers, from flat keys or a nested `<prefix>:` mapping. */
  values: Partial<Record<F, unknown>>;
  /** Keys under the prefix OpsCrew does not know (`server.password`, `portainer.token`). */
  unknown: string[];
  /** The remaining answers. */
  rest: InterviewAnswers;
}

/**
 * Takes the follow-up answers under `prefix` out of `answers`: flat `<prefix>.<field>` keys (as in
 * `--answers` files and the MCP tool) or a nested `<prefix>:` mapping. Fields outside `fields` are
 * listed as unknown.
 */
export function splitFollowUps<F extends string>(
  answers: InterviewAnswers,
  prefix: string,
  fields: readonly F[],
): FollowUps<F> {
  const values: Partial<Record<F, unknown>> = {};
  const unknown: string[] = [];
  const rest: InterviewAnswers = {};
  const take = (field: string, value: unknown) => {
    if ((fields as readonly string[]).includes(field)) values[field as F] = value;
    else unknown.push(`${prefix}.${field}`);
  };
  for (const [key, value] of Object.entries(answers)) {
    if (key === prefix) {
      if (isRecord(value)) {
        for (const [field, inner] of Object.entries(value)) take(field, inner);
      } else if (!isBlank(value)) {
        unknown.push(prefix);
      }
    } else if (key.startsWith(`${prefix}.`)) {
      take(key.slice(prefix.length + 1), value);
    } else {
      rest[key] = value;
    }
  }
  return { values, unknown, rest };
}

/** True when any follow-up was answered, also one OpsCrew does not know. */
export function hasFollowUps(split: Pick<FollowUps<string>, "values" | "unknown">): boolean {
  return split.unknown.length > 0 || Object.keys(split.values).length > 0;
}

/** A port answer (a number, or its digits as text) from 1 to 65535; `undefined` otherwise. */
export function portAnswer(value: unknown): number | undefined {
  const text = String(value).trim();
  const port =
    typeof value === "number" ? value : /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}
