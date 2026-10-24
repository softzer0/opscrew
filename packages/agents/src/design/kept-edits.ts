import { type DeployPlan, isServerlessTarget, type Site } from "@opscrew/plan-schema";
import { planFile } from "../runners/words";

/**
 * `fresh` with the values the user set where design sets them from what analyze detects. The
 * parts environments share (`app.port`, `app.healthPath`, `app.releaseCommand`) come from
 * `shared`, the plan that holds them: prod's for another environment built from the same branch
 * (its own copy then follows prod's, said when it differed), else the environment's own; only
 * between plans with a server (a release command left out for a site without one is said). The
 * site's own settings come from the environment's `previous` plan: `target.notFound`
 * (Cloudflare, while the site renders the same way), `target.site.command` and `outputDir` (while
 * it is the same kind of site: tool, package manager, server rendering and folder). `lines` say
 * each value kept, with what analyze found and the file to change, and each one taken from
 * analysis instead because the kept one no longer applies. A release command analyze finds is set
 * when the plan had none, and said so. The Node.js version follows the runtime rules instead
 * (`resolveRuntime`), which keep the recorded one or say why not.
 */
export function keptEdits(
  fresh: DeployPlan,
  previous: DeployPlan | undefined,
  shared: DeployPlan | undefined,
): { plan: DeployPlan; lines: string[] } {
  const lines: string[] = [];
  const kept = (field: string, value: string | number, found: string | number, file: string) =>
    lines.push(
      `Kept ${field} ${value} from ${file}; analyze found ${found}. To use it, set ${field} to ${found} in ${file}.`,
    );
  let app = fresh.app;
  // Both plans have a server, so the parts it runs with apply to both.
  const servers =
    shared !== undefined && !isServerlessTarget(fresh.target) && !isServerlessTarget(shared.target);
  if (shared !== undefined && isServerlessTarget(fresh.target)) {
    const before = shared.app.releaseCommand;
    if (before !== undefined) {
      lines.push(
        `Left out app.releaseCommand \`${before}\` from ${planFile(shared)}: a site without a server has no image to run it in before a deploy.`,
      );
    }
  } else if (shared !== undefined && servers) {
    const file = planFile(shared);
    if (shared.app.port !== fresh.app.port) {
      kept("app.port", shared.app.port, fresh.app.port, file);
      app = { ...app, port: shared.app.port };
    }
    if (shared.app.healthPath !== fresh.app.healthPath) {
      kept("app.healthPath", shared.app.healthPath, fresh.app.healthPath, file);
      app = { ...app, healthPath: shared.app.healthPath };
    }
    const before = shared.app.releaseCommand;
    const found = fresh.app.releaseCommand;
    if (before !== undefined && before !== found) {
      app = { ...app, releaseCommand: before };
      lines.push(
        found === undefined
          ? `Kept app.releaseCommand \`${before}\` from ${file}; analyze found none. To run none, remove app.releaseCommand in ${file}.`
          : `Kept app.releaseCommand \`${before}\` from ${file}; analyze found \`${found}\`. To use it, set app.releaseCommand to \`${found}\` in ${file}.`,
      );
    } else if (before === undefined && found !== undefined) {
      lines.push(`Set app.releaseCommand to \`${found}\`, which analyze found; ${file} had none.`);
    }
  }

  if (previous === undefined) return { plan: { ...fresh, app }, lines };
  if (shared !== undefined && servers && shared !== previous) {
    // The environment's own copy of what it shares follows the plan that holds it.
    for (const field of ["port", "healthPath", "releaseCommand"] as const) {
      const own = previous.app[field];
      const now = app[field];
      if (own === undefined || own === now || now !== shared.app[field]) continue;
      const show = (value: string | number | undefined) =>
        value === undefined ? "none" : field === "releaseCommand" ? `\`${value}\`` : value;
      lines.push(
        `Set app.${field} to ${show(now)} as in ${planFile(shared)}: the environments built from the same code share it, so ${show(own)} from ${planFile(previous)} no longer applies.`,
      );
    }
  }
  let target = fresh.target;
  const was = previous.target;
  const file = planFile(previous);
  if (target.provider === "cloudflare-workers" && was.provider === "cloudflare-workers") {
    if (was.notFound !== target.notFound) {
      if (was.render === target.render) {
        kept("target.notFound", was.notFound, target.notFound, file);
        target = { ...target, notFound: was.notFound };
      } else {
        lines.push(
          `Set target.notFound to ${target.notFound}: the app now renders ${target.render === "ssr" ? "on the server" : "static files"}, so ${was.notFound} from ${file} no longer applies.`,
        );
      }
    }
  }
  if (isServerlessTarget(target) && isServerlessTarget(was)) {
    const folder = fresh.app.buildContext;
    const sameSite =
      siteKind(was.site, previous.app.buildContext) === siteKind(target.site, folder);
    let site = target.site;
    for (const field of ["command", "outputDir"] as const) {
      const value = was.site[field];
      const derived = target.site[field];
      if (value === derived) continue;
      const show = (text: string | undefined) =>
        text === undefined ? "none" : field === "command" ? `\`${text}\`` : text;
      if (sameSite) {
        kept(`target.site.${field}`, show(value), show(derived), file);
        site = { ...site, [field]: value };
      } else {
        lines.push(
          `Set target.site.${field} to ${show(derived)}: analyze found another site (${siteKind(target.site, folder)}), so ${show(value)} from ${file} no longer applies.`,
        );
      }
    }
    target = { ...target, site };
  }
  return { plan: { ...fresh, app, target }, lines };
}

/**
 * What decides a site's build command and output folder, in words: its tool, package manager,
 * server rendering (the adapter's Worker module) and folder.
 */
function siteKind(site: Site, folder: string): string {
  const manager = site.packageManager === undefined ? "" : ` with ${site.packageManager}`;
  const rendering = site.entry === undefined ? "" : ", rendered on the server";
  return `${site.tool}${manager}${rendering} in ${folder}`;
}
