/**
 * Builder-platform fingerprints (FR-105): Lovable, Bolt, Replit, v0 and Base44. The platform
 * with the most evidence wins; ties go to the first platform in that order.
 */
import type { PlatformExport } from "@opscrew/plan-schema";
import type { Dependency } from "./manifests";
import { sortStrings } from "./paths";

/** Inputs for {@link detectPlatform}; gathered from the repository root and the app directory. */
export interface PlatformInputs {
  /** npm dependencies of the root and app package.json files. */
  dependencies: readonly Dependency[];
  /** package.json `name` values of the root and app units. */
  packageNames: readonly string[];
  /** README text (root README first) with its repo-relative path. */
  readme?: { path: string; text: string };
  /** index.html text with its repo-relative path. */
  indexHtml?: { path: string; text: string };
  /** Root entries that exist: `.bolt`, `.replit`, `replit.nix`, `components.json`. */
  markers: ReadonlySet<string>;
}

/** The detected platform and its evidence. */
export interface PlatformResult {
  platform: PlatformExport;
  evidence: string[];
}

const ORDER: readonly Exclude<PlatformExport, "none">[] = [
  "lovable",
  "bolt",
  "replit",
  "v0",
  "base44",
];

function dependencyEvidence(deps: readonly Dependency[], name: string): string | undefined {
  const matching = deps.filter((dep) => dep.ecosystem === "npm" && dep.name === name);
  if (matching.length === 0) return undefined;
  return matching.some((dep) => !dep.dev) ? `dependency:${name}` : `devDependency:${name}`;
}

function textEvidence(
  file: { path: string; text: string } | undefined,
  pattern: RegExp,
): string | undefined {
  const match = file ? pattern.exec(file.text) : null;
  return file && match?.[1] ? `${file.path}:${match[1].toLowerCase()}` : undefined;
}

/** Fingerprints the builder platform the code was exported from. */
export function detectPlatform(inputs: PlatformInputs): PlatformResult {
  const { dependencies, markers } = inputs;
  const evidence: Record<Exclude<PlatformExport, "none">, (string | undefined)[]> = {
    lovable: [
      dependencyEvidence(dependencies, "lovable-tagger"),
      /<meta\b[^>]*lovable/i.test(inputs.indexHtml?.text ?? "")
        ? `${inputs.indexHtml?.path}:lovable`
        : undefined,
      textEvidence(inputs.readme, /\b(lovable\.(?:dev|app))\b/i),
    ],
    bolt: [markers.has(".bolt") ? ".bolt/" : undefined],
    replit: [
      markers.has(".replit") ? ".replit" : undefined,
      markers.has("replit.nix") ? "replit.nix" : undefined,
    ],
    v0: [],
    base44: [dependencyEvidence(dependencies, "@base44/sdk")],
  };

  const next = dependencyEvidence(dependencies, "next");
  const v0Markers = [
    textEvidence(inputs.readme, /\b(v0\.(?:dev|app))\b/i),
    inputs.packageNames.includes("my-v0-project") ? "package.json:name=my-v0-project" : undefined,
  ].filter(Boolean);
  if (markers.has("components.json") && next && v0Markers.length > 0) {
    evidence.v0 = ["components.json", next, ...v0Markers];
  }

  let best: PlatformResult = { platform: "none", evidence: [] };
  for (const platform of ORDER) {
    const found = evidence[platform].filter((item): item is string => Boolean(item));
    if (found.length > best.evidence.length) {
      best = { platform, evidence: sortStrings(new Set(found)) };
    }
  }
  return best;
}
