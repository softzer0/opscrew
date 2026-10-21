/**
 * The routing rules of a `vercel.json` (FR-1446): `redirects`, `rewrites`, `headers`, `cleanUrls`
 * and `trailingSlash`, parsed and checked, with what is not translated listed and why.
 */
import { isRecord, sha256Hex } from "@opscrew/core";
import { type PlatformRouting, VercelSourceSchema } from "@opscrew/plan-schema";
import { parseJson } from "./manifests";

type Unsupported = PlatformRouting["unsupported"][number];
type Redirect = PlatformRouting["redirects"][number];
type Rewrite = PlatformRouting["rewrites"][number];
type Header = PlatformRouting["headers"][number];

const STATUS_CODES: readonly number[] = [301, 302, 303, 307, 308];
const CONDITION = "it has a `has` or `missing` condition, which OpsCrew does not translate yet";
const ROUTES =
  "`routes` uses Vercel's PCRE form, which OpsCrew does not translate yet; write these rules as `redirects`, `rewrites` and `headers` instead";

/** A problem with the entry's `source` or `destination`, or undefined when both are usable. */
function targetProblem(entry: Record<string, unknown>, destination = true): string | undefined {
  if (!VercelSourceSchema.safeParse(entry.source).success) {
    return "its `source` must start with `/` (a path pattern) or `^` (a regular expression)";
  }
  if (destination && (typeof entry.destination !== "string" || entry.destination === "")) {
    return "it has no `destination`";
  }
  return undefined;
}

function redirect(entry: Record<string, unknown>): Omit<Redirect, "index"> | string {
  const problem = targetProblem(entry);
  if (problem) return problem;
  const { permanent, statusCode } = entry;
  if (permanent !== undefined && statusCode !== undefined) {
    return "it sets both `statusCode` and `permanent`, which Vercel does not allow";
  }
  if (permanent !== undefined && typeof permanent !== "boolean") {
    return "its `permanent` must be true or false";
  }
  if (statusCode !== undefined && !STATUS_CODES.includes(statusCode as number)) {
    return "its `statusCode` must be 301, 302, 303, 307 or 308";
  }
  return {
    source: entry.source as string,
    destination: entry.destination as string,
    // `permanent` defaults to true: 308; false is 307.
    statusCode: (statusCode ?? (permanent === false ? 307 : 308)) as Redirect["statusCode"],
  };
}

function rewrite(entry: Record<string, unknown>): Omit<Rewrite, "index"> | string {
  return (
    targetProblem(entry) ?? {
      source: entry.source as string,
      destination: entry.destination as string,
    }
  );
}

function header(entry: Record<string, unknown>): Omit<Header, "index"> | string {
  const problem = targetProblem(entry, false);
  if (problem) return problem;
  const { headers } = entry;
  const valid =
    Array.isArray(headers) &&
    headers.length > 0 &&
    headers.every(
      (h) =>
        isRecord(h) && typeof h.key === "string" && h.key !== "" && typeof h.value === "string",
    );
  if (!valid) return "its `headers` must be a list of `{ key, value }` pairs";
  return {
    source: entry.source as string,
    headers: (headers as { key: string; value: string }[]).map(({ key, value }) => ({
      key,
      value,
    })),
  };
}

/**
 * The routing rules of the `vercel.json` text, each keeping its index in the file. `routes`, every
 * rule with a `has` or `missing` condition, and malformed rules go to `unsupported` with the reason.
 * Undefined when the text is not a JSON object or has no routing rules.
 */
export function vercelRouting(text: string | undefined): PlatformRouting | undefined {
  const parsed = parseJson(text);
  if (text === undefined || !isRecord(parsed)) return undefined;
  const data = parsed;
  const unsupported: Unsupported[] = [];

  function rules<T>(
    property: "redirects" | "rewrites" | "headers",
    parse: (entry: Record<string, unknown>) => T | string,
  ): (T & { index: number })[] {
    const value = data[property];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      unsupported.push({ property, reason: "it must be a list of rules" });
      return [];
    }
    return value.flatMap((entry: unknown, index) => {
      const result = !isRecord(entry)
        ? "it is not an object"
        : "has" in entry || "missing" in entry
          ? CONDITION
          : parse(entry);
      if (typeof result === "string") {
        unsupported.push({ property, index, reason: result });
        return [];
      }
      return [{ index, ...result }];
    });
  }
  function flag(property: "cleanUrls" | "trailingSlash"): boolean | undefined {
    const value = data[property];
    if (value === undefined || typeof value === "boolean") return value;
    unsupported.push({ property, reason: "it must be true or false" });
    return undefined;
  }

  const redirects = rules("redirects", redirect);
  const rewrites = rules("rewrites", rewrite);
  const headers = rules("headers", header);
  const cleanUrls = flag("cleanUrls");
  const trailingSlash = flag("trailingSlash");
  if (data.routes !== undefined) unsupported.push({ property: "routes", reason: ROUTES });

  const found =
    redirects.length + rewrites.length + headers.length + unsupported.length > 0 ||
    cleanUrls !== undefined ||
    trailingSlash !== undefined;
  if (!found) return undefined;
  return {
    source: "vercel.json",
    sha256: sha256Hex(text),
    redirects,
    rewrites,
    headers,
    ...(cleanUrls === undefined ? {} : { cleanUrls }),
    ...(trailingSlash === undefined ? {} : { trailingSlash }),
    unsupported,
  };
}
