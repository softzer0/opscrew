/**
 * The app's additions translated from `vercel.json` (FR-1446, plan.md "16."): written once, when
 * the server's proxy has no additions file yet, and the user's to edit from then on.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTextIfExists } from "@opscrew/core";
import { detectProjectDetails } from "@opscrew/detect";
import {
  additionsPath,
  EDGE_PROXIES,
  edgeProxy,
  siteHosts,
  translateVercelRouting,
} from "@opscrew/iac-templates";
import type { DeployPlan, ProjectFacts } from "@opscrew/plan-schema";
import { scanProxyAdditions } from "@opscrew/secops";

/** The header line that names the `vercel.json` a file was translated from, by its SHA-256. */
const SOURCE_LINE = /^# Translated by OpsCrew from vercel\.json \(SHA-256 ([0-9a-f]{64})\)/m;

function header(sha256: string, label: string): string {
  return [
    `# Translated by OpsCrew from vercel.json (SHA-256 ${sha256}) for ${label}.`,
    "# This file is yours to edit: OpsCrew never changes it. When vercel.json changes, `opscrew design`",
    "# says so; delete this file and run `opscrew design` again to translate it anew.",
    "",
    "",
  ].join("\n");
}

/**
 * For a plan on a server (not a Portainer stack), with `facts` from the analysis:
 * - when `facts` carry `vercel.json`'s routing rules and the app's additions file
 *   (`additionsPath`: `opscrew/proxy/additions.<proxy>` for the first app) does not exist, writes
 *   their translation there with a header naming `vercel.json`'s SHA-256, and says
 *   which rules were not translated and why (nothing is written when none were, nor when
 *   `scanProxyAdditions` refuses the translation, which design then warns about);
 * - when the file exists with that header and a fresh detect finds another `vercel.json` (detect
 *   hashes its text without a BOM), warns that the file was not changed.
 * Returns the lines to show and the warnings.
 */
export async function vercelAdditions(
  root: string,
  plan: DeployPlan,
  facts: ProjectFacts,
): Promise<{ lines: string[]; warnings: string[] }> {
  const none = { lines: [], warnings: [] };
  if (plan.target.provider === "portainer") return none;
  const proxy = edgeProxy(plan);
  const { label, upstream } = EDGE_PROXIES[proxy];
  const file = additionsPath(plan, proxy);
  const path = join(root, file);
  const existing = await readTextIfExists(path);
  if (existing !== undefined) {
    const translated = SOURCE_LINE.exec(existing)?.[1];
    if (translated === undefined) return none;
    const fresh = await detectProjectDetails(root, { appDir: facts.appDir });
    if (fresh.facts.platformRouting?.sha256 === translated) return none;
    return {
      lines: [],
      warnings: [
        `vercel.json has changed since OpsCrew translated its routing rules into ${file}, and OpsCrew does not change that file. Update it by hand, or delete it and run \`opscrew design\` again to translate the new rules.`,
      ],
    };
  }
  const routing = facts.platformRouting;
  if (routing === undefined) return none;
  const ctx = { proxy, hostnames: siteHosts(plan), upstream };
  const { text, skipped } = translateVercelRouting(routing, ctx);
  const notes = skipped.map(
    ({ rule, reason }) => `Not translated from vercel.json: ${rule}, because ${reason}.`,
  );
  if (text === "") {
    return {
      lines: [
        `None of vercel.json's routing rules can be written for ${label}, so OpsCrew wrote no ${file}.`,
        ...notes,
      ],
      warnings: [],
    };
  }
  const content = `${header(routing.sha256, label)}${text}`;
  // Fail closed: a translation OpsCrew's additions rules refuse is never written.
  const refused = scanProxyAdditions(content, ctx);
  if (refused.length > 0) {
    const found = refused.map((r) => `line ${r.line} (${r.rule}): ${r.message}`).join(" ");
    return {
      lines: notes,
      warnings: [
        `OpsCrew wrote no ${file}: its translation of vercel.json breaks OpsCrew's additions rules, ${found} Write the file by hand, or tell OpsCrew.`,
      ],
    };
  }
  await mkdir(dirname(path), { recursive: true });
  // `wx`: a file that appeared meanwhile is never overwritten.
  await writeFile(path, content, { flag: "wx" });
  return {
    lines: [
      `Wrote ${file}: vercel.json's routing rules for ${label}, in Vercel's order. The file is yours to edit from now on.`,
      ...notes,
    ],
    warnings: [],
  };
}
