/**
 * `opscrew drift --env <preview>` (FR-2221, plan.md 8.): beside the preview environment's root
 * (its server and wildcard record) and its generated files, the recipe on the preview server is
 * compared with the one provision rendered and committed (`opscrew/environments/<env>/previews/`,
 * the same files without the values): its files, its values file, the preview key and the
 * hourly cleanup. Read-only. On another environment's server it reads the recipe through that
 * environment's login.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectHost, previewCommand } from "@opscrew/connector-ssh-host";
import { errorText, isUserFacingError, listText, sha256Hex, toPosixRelative } from "@opscrew/core";
import { appDir, IMAGES, previewRecipeDir } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { appZoneChecks, appZoneDomain } from "../previews/app-zone";
import { previewServer } from "../previews/host";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { serverShell } from "../status/servers";
import { AREA_TITLES, type HostDifference } from "./host";
import type { ServersDriftOptions } from "./servers";
import type { CloudflareRuleDifference } from "./types";

/**
 * Previews below the app's zone (FR-2232): the previews' certificate pack not active, or Total TLS
 * on, each a difference in the zone with its fix (`appZoneChecks`, read-only). None for previews in
 * a zone of their own.
 */
export async function appZoneDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "sharedCloudflare">,
): Promise<CloudflareRuleDifference[]> {
  if (appZoneDomain(plan) === undefined) return [];
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const checks = await appZoneChecks(
    sharedCloudflareClient(deps, services),
    plan,
    `opscrew provision${flag}`,
  );
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => ({ title: check.message, detail: check.remediation ?? "" }));
}

/**
 * The committed recipe's files by path, each with the SHA-256 of its text (LF line ends);
 * `undefined` without the folder.
 */
async function committedRecipe(dir: string): Promise<Record<string, string> | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    () => undefined,
  );
  if (entries === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const entry of entries) {
    // Dot-files are left out, as the server's facts leave them out.
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(entry.parentPath, entry.name);
    // A Windows checkout's CRLF line ends are the same text.
    const text = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
    files[toPosixRelative(dir, path)] = sha256Hex(text);
  }
  return files;
}

/**
 * How the preview server's recipe differs from the committed one (see the module's comment). A
 * server that can't be read, or a recipe that isn't committed yet, adds a note instead.
 */
export async function previewRecipeDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  notes: string[],
  options: ServersDriftOptions = {},
): Promise<HostDifference[]> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const folder = previewRecipeDir(plan);
  const committed = await committedRecipe(join(deps.paths.root, folder));
  if (committed === undefined) {
    notes.push(
      `The previews' recipe is not in the repository yet (${folder}/), so the one on the preview server was not compared; \`opscrew provision${flag}\` renders it.`,
    );
    return [];
  }
  let facts: Awaited<ReturnType<typeof inspectHost>>;
  try {
    // On another environment's server, through that environment's login (`previewServer`).
    const server = await previewServer(deps, plan);
    const shell = await serverShell(server.deps, server.plan, APP_SERVER, options.services ?? {});
    deps.reporter.step("Comparing the previews' recipe on the server with the repository's");
    facts = await (options.inspect ?? inspectHost)(
      shell.remote,
      shell.login.own ? {} : { rootImage: IMAGES.caddy.ref },
    );
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    notes.push(`OpsCrew could not compare the previews' recipe on the server. ${errorText(error)}`);
    return [];
  }
  const app = plan.app.name;
  const differ = (detail: string): HostDifference => ({
    area: "previews",
    title: AREA_TITLES.previews,
    detail: `${detail} \`opscrew provision${flag}\` puts it back.`,
    restoredByProvision: true,
  });
  const recipe = facts.previews.find((item) => item.app === app);
  if (recipe === undefined) {
    return [differ(`The previews' recipe is not on the server (${appDir(plan)}).`)];
  }
  const paths = [...new Set([...Object.keys(committed), ...Object.keys(recipe.files)])].sort();
  const missing = paths.filter((path) => recipe.files[path] === undefined);
  const extra = paths.filter((path) => committed[path] === undefined);
  const edited = paths.filter(
    (path) =>
      committed[path] !== undefined &&
      recipe.files[path] !== undefined &&
      committed[path] !== recipe.files[path],
  );
  const out: HostDifference[] = [];
  if (missing.length > 0) out.push(differ(`The server's recipe lacks ${listText(missing)}.`));
  if (edited.length > 0) {
    const verb = edited.length === 1 ? "differs" : "differ";
    out.push(differ(`${listText(edited)} on the server ${verb} from the repository's recipe.`));
  }
  if (extra.length > 0) {
    out.push(differ(`The server's recipe has ${listText(extra)}, which the repository's lacks.`));
  }
  if (!recipe.values) out.push(differ("The previews' values file (values.env) is missing."));
  if (recipe.cron.length === 0) {
    out.push(differ("The hourly cleanup of idle previews is not in the deploy user's crontab."));
  }
  const command = `command="${previewCommand(app)}"`;
  if (!(facts.deployUser?.previewKeys ?? []).some((line) => line.includes(command))) {
    out.push(
      differ(
        "The preview key is not in the deploy user's authorized_keys, so pull requests' preview jobs can't reach the server.",
      ),
    );
  }
  return out;
}
