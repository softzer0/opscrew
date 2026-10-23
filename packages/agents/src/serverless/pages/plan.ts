/**
 * The Pages plan (`pages-apply`, data-model.md "The Pages plan"): the change from the GitHub
 * Pages site GitHub reports to the site OpsCrew wants, in steps, bound by its hash. Applying
 * re-reads the site and changes nothing when it no longer matches the plan.
 */
import { join } from "node:path";
import type { GitHubClient, PagesHealth, PagesSite } from "@opscrew/connector-github";
import {
  canonicalJson,
  isPlanHash,
  OpsCrewError,
  type ProjectPaths,
  sha256Hex,
} from "@opscrew/core";
import { z } from "zod";
import { type AdapterPlanItem, describeAdapterPlan } from "../../shared";

/** The GitHub Pages calls OpsCrew makes: a `GitHubClient`, or a fake in tests. */
export type PagesApi = Pick<
  GitHubClient,
  "getPages" | "createPages" | "updatePages" | "pagesHealth" | "pagesAllowed"
>;

const PagesStateSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    buildType: z.enum(["workflow", "legacy"]),
    cname: z.string().min(1).optional(),
    httpsEnforced: z.boolean(),
  }),
]);

const PagesStepSchema = z.discriminatedUnion("kind", [
  // Turns Pages on, published by the deploy workflow (`build_type: "workflow"`).
  z.strictObject({ kind: z.literal("create") }),
  // Switches a site published from a branch to the workflow; the site and its domain stay.
  z.strictObject({ kind: z.literal("use-workflow") }),
  // Sets the custom domain, replacing the one the site had (`replaces`).
  z.strictObject({
    kind: z.literal("set-domain"),
    cname: z.string().min(1),
    replaces: z.string().min(1).optional(),
  }),
  // Removes the custom domain and sets it straight back, so GitHub requests the certificate.
  z.strictObject({ kind: z.literal("save-domain-again"), cname: z.string().min(1) }),
  z.strictObject({ kind: z.literal("enforce-https") }),
]);

/** A Pages plan as saved in `.opscrew/plans/pages-<hash>.json`. */
export const PagesPlanSchema = z.strictObject({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** The site as GitHub reported it when the plan was made. */
  site: PagesStateSchema,
  /** The changes, in the order they are applied. */
  steps: z.array(PagesStepSchema),
});

export type PagesPlan = z.infer<typeof PagesPlanSchema>;
export type PagesStep = PagesPlan["steps"][number];
export type PagesState = PagesPlan["site"];

/** Where a Pages plan is saved: `.opscrew/plans/pages-<hash>.json`. */
export function pagesPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `pages-${hash}.json`);
}

/** The site as a plan records it: off, or on with its source, custom domain and HTTPS. */
export function pagesState(site: PagesSite | undefined): PagesState {
  if (site === undefined) return { enabled: false };
  return {
    enabled: true,
    buildType: site.buildType,
    ...(site.cname !== undefined ? { cname: site.cname } : {}),
    httpsEnforced: site.httpsEnforced,
  };
}

/** True when the site is on and its custom domain is `cname` (names compare in any case). */
export function claimsDomain(site: PagesState, cname: string): boolean {
  return site.enabled && site.cname?.toLowerCase() === cname.toLowerCase();
}

/**
 * The steps from `site` to GitHub Pages on, published by the workflow, with the custom domain
 * `cname`: the site turned on (or switched from a branch to the workflow), then the domain. Once
 * the site claims the domain, GitHub's `health` decides: with the DNS valid and no certificate
 * yet the domain is saved again, once (`savedAgain`: an applied plan of this app did that
 * already); with the certificate issued, HTTPS is enforced.
 */
export function planPages(input: {
  owner: string;
  repo: string;
  site: PagesSite | undefined;
  cname: string;
  health?: PagesHealth;
  savedAgain: boolean;
}): PagesPlan {
  const site = pagesState(input.site);
  const steps: PagesStep[] = [];
  if (!site.enabled) steps.push({ kind: "create" });
  else if (site.buildType === "legacy") steps.push({ kind: "use-workflow" });
  const { health } = input;
  if (!claimsDomain(site, input.cname)) {
    const replaces = site.enabled ? site.cname : undefined;
    steps.push({
      kind: "set-domain",
      cname: input.cname,
      ...(replaces !== undefined ? { replaces } : {}),
    });
  } else if (health?.dns === "ok") {
    if (health.certificate === "issued") {
      if (site.enabled && !site.httpsEnforced) steps.push({ kind: "enforce-https" });
    } else if (health.certificate === "pending" && !input.savedAgain) {
      steps.push({ kind: "save-domain-again", cname: input.cname });
    }
  }
  return { owner: input.owner, repo: input.repo, site, steps };
}

/** SHA-256 (lower-case hex) of the plan's canonical JSON: the hash `pages-apply` binds. */
export function pagesPlanHash(plan: PagesPlan): string {
  return sha256Hex(canonicalJson(plan));
}

/**
 * True when the plan takes a custom domain away from the site (it replaces another one), so its
 * approval needs `allowDestroy` and the typed app name.
 */
export function pagesPlanDeletes(plan: PagesPlan): boolean {
  return plan.steps.some((step) => step.kind === "set-domain" && step.replaces !== undefined);
}

/** The Pages plan in plain English, as shown before its approval, ending with its hash. */
export function describePagesPlan(plan: PagesPlan, hash: string): string {
  const { site } = plan;
  const repository = `${plan.owner}/${plan.repo}`;
  const step = <K extends PagesStep["kind"]>(kind: K) =>
    plan.steps.find((s): s is Extract<PagesStep, { kind: K }> => s.kind === kind);
  const items: AdapterPlanItem[] = [];
  if (step("create")) {
    items.push({
      title: `Turn GitHub Pages on for ${repository}, published by OpsCrew's deploy workflow`,
      state: "change",
    });
  } else if (step("use-workflow")) {
    items.push({
      title: `Publish the GitHub Pages site of ${repository} with OpsCrew's deploy workflow instead of from a branch`,
      state: "change",
      reason:
        "GitHub Pages is on and built from a branch now; the site and its custom domain stay.",
    });
  } else {
    items.push({
      title: `GitHub Pages on for ${repository}, published by the deploy workflow`,
      state: "in-place",
    });
  }
  const domain = step("set-domain");
  if (domain !== undefined) {
    items.push({
      title: `Set the custom domain ${domain.cname}`,
      state: "change",
      reason:
        domain.replaces === undefined
          ? "It is set before its DNS records exist, so no record ever points at GitHub while no site claims the domain."
          : `It replaces ${domain.replaces}: delete every DNS record that still points ${domain.replaces} at GitHub, or another GitHub Pages site could take it over.`,
    });
  } else if (site.enabled && site.cname !== undefined) {
    items.push({ title: `Custom domain ${site.cname}`, state: "in-place" });
  }
  const again = step("save-domain-again");
  if (again !== undefined) {
    items.push({
      title: `Save the custom domain ${again.cname} again, so GitHub requests the site's certificate`,
      state: "change",
      reason:
        "GitHub requests it only when the domain is saved while its DNS records are valid, so OpsCrew removes the domain and sets it straight back, about a second apart. Verifying the domain in your GitHub settings removes even that second's gap.",
    });
  }
  if (step("enforce-https") !== undefined) {
    items.push({
      title: "Enforce HTTPS (GitHub has issued the site's certificate)",
      state: "change",
    });
  } else if (site.enabled && site.httpsEnforced) {
    items.push({ title: "HTTPS enforced", state: "in-place" });
  }
  return describeAdapterPlan({
    heading: `Pages plan for the GitHub Pages site of ${repository}`,
    items,
    findings: [],
    note: "OpsCrew changes only this repository's GitHub Pages settings, and it reads the site again before it does: if the site changed since this plan, nothing changes. The site's DNS records come in the infrastructure plan after this one.",
    hashLabel: "Pages plan hash",
    hash,
  });
}

/** An apply that stopped at a failure: `applied` lists the steps done before it. */
export class PagesApplyError extends OpsCrewError {
  readonly applied: PagesStep["kind"][];

  constructor(cause: unknown, message: string, applied: PagesStep["kind"][]) {
    const known = cause instanceof OpsCrewError;
    super(known ? cause.code : "PROVIDER_ERROR", message, {
      ...(known && cause.hint !== undefined ? { hint: cause.hint } : {}),
      cause,
    });
    this.name = "PagesApplyError";
    this.applied = applied;
  }
}

/** How a site state reads in a sentence. */
function stateText(site: PagesState): string {
  if (!site.enabled) return "off";
  const source = site.buildType === "workflow" ? "published by a workflow" : "built from a branch";
  const domain = site.cname === undefined ? "no custom domain" : `the custom domain ${site.cname}`;
  return `on, ${source}, with ${domain}${site.httpsEnforced ? " and HTTPS enforced" : ""}`;
}

/** What a failure says: its own message when it is OpsCrew's. */
function said(error: unknown): string {
  return error instanceof OpsCrewError ? error.message : "GitHub's answer was unexpected.";
}

/** What each step does, as the audit log and a failure name it. */
export const PAGES_STEP_TEXT = {
  create: "turned GitHub Pages on, published by the deploy workflow",
  "use-workflow": "switched the site from a branch to the deploy workflow",
  "set-domain": "set the custom domain",
  "save-domain-again": "saved the custom domain again",
  "enforce-https": "enforced HTTPS",
} as const satisfies Record<PagesStep["kind"], string>;

/** What the steps done so far are, in a sentence. */
function doneText(applied: readonly PagesStep["kind"][]): string {
  return applied.length === 0
    ? "Nothing was changed before it."
    : `Done before it: OpsCrew ${applied.map((kind) => PAGES_STEP_TEXT[kind]).join(", then ")}.`;
}

/**
 * Applies an approved Pages plan: refuses with `PLAN_HASH_MISMATCH` when its hash is not
 * `approvedHash`, and with `PHASE_PRECONDITION` when GitHub reports the site differently than the
 * plan saw it, both before any change. The steps then run in order; the first failure stops with
 * a {@link PagesApplyError} that says what was done. `command` is what sets the domain again when
 * GitHub took it away and did not set it back. Returns the steps applied.
 */
export async function applyPagesPlan(
  api: PagesApi,
  plan: PagesPlan,
  opts: { approvedHash: string; command: string },
): Promise<PagesStep["kind"][]> {
  if (!isPlanHash(opts.approvedHash) || opts.approvedHash.toLowerCase() !== pagesPlanHash(plan)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This Pages plan is not the one that was approved, so OpsCrew changes nothing in GitHub Pages.",
      { hint: "Look at the current Pages plan and approve it by its hash." },
    );
  }
  const { owner, repo } = plan;
  const now = pagesState(await api.getPages(owner, repo));
  if (canonicalJson(now) !== canonicalJson(plan.site)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The GitHub Pages site of ${owner}/${repo} changed after this Pages plan was made: it was ${stateText(plan.site)}, and it is ${stateText(now)} now. OpsCrew changed nothing.`,
      {
        hint: `Run \`${opts.command}\` again to make a new Pages plan from the site as it is, and approve that one.`,
      },
    );
  }
  const applied: PagesStep["kind"][] = [];
  for (const step of plan.steps) {
    try {
      await applyStep(api, plan, step, opts.command);
    } catch (error) {
      throw new PagesApplyError(error, `${said(error)} ${doneText(applied)}`, [...applied]);
    }
    applied.push(step.kind);
  }
  return applied;
}

async function applyStep(
  api: PagesApi,
  plan: PagesPlan,
  step: PagesStep,
  command: string,
): Promise<void> {
  const { owner, repo } = plan;
  switch (step.kind) {
    case "create":
      return api.createPages(owner, repo);
    case "use-workflow":
      return api.updatePages(owner, repo, { buildType: "workflow" });
    case "set-domain":
      return api.updatePages(owner, repo, { cname: step.cname });
    case "save-domain-again":
      await api.updatePages(owner, repo, { cname: null });
      try {
        await api.updatePages(owner, repo, { cname: step.cname });
      } catch (error) {
        throw new OpsCrewError(
          error instanceof OpsCrewError ? error.code : "PROVIDER_ERROR",
          `GitHub removed the custom domain ${step.cname} from the site but did not take it back (${said(error)}). While no site claims it, its DNS records point at GitHub, so another GitHub Pages site could take the domain over.`,
          {
            hint: `Run \`${command}\` again right away: it sets the domain again. If GitHub keeps refusing, delete the domain's DNS records in Cloudflare until it works.`,
            cause: error,
          },
        );
      }
      return;
    case "enforce-https":
      return api.updatePages(owner, repo, { httpsEnforced: true });
    default:
      return step satisfies never;
  }
}
