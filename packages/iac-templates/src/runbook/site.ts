import { formatMoney, upperFirst } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { verificationRecordName } from "../infra/serverless";
import { siteHosts } from "../runtime";
import { HEADERS_ENTRY } from "../serverless/headers";
import {
  cloudflareDir,
  SITE_ARTIFACT,
  serverlessTarget,
  siteEnvSecret,
  siteFiles,
  workersPlan,
} from "../serverless/site";
import { wranglerConfigPath } from "../serverless/wrangler";
import type { RenderedFile } from "../types";
import { CLOUDFLARE_DEPLOY_SECRETS } from "../workflow/cloudflare-workers";
import {
  deploySecretName,
  promoteCommand,
  promoted,
  runbookFilePath,
  workflowName,
} from "../workflow/shared";
import {
  cell,
  deployAgain,
  environmentRows,
  opscrew,
  type RunbookContext,
  runbookFolders,
  runbookTitle,
} from "./shared";

/** What {@link renderSiteRunbook} renders from besides the plan. */
export interface SiteRunbookContext
  extends Pick<RunbookContext, "opscrewVersion" | "environments"> {
  /**
   * The repository's owner on GitHub, for GitHub Pages' verification record and settings page;
   * `<owner>` when unknown.
   */
  owner?: string;
}

/**
 * The runbook of a site on Cloudflare's hosting or GitHub Pages (`RUNBOOK.md` beside the plan,
 * feature 016): what runs where, how a deploy works, `opscrew status`, the rollback (a version of
 * the Worker, or a re-run of an earlier Pages run), promotion by the build's SHA-256 on Cloudflare,
 * the secrets by name, GitHub's manual Verify step, and `opscrew destroy` in its order. No secret,
 * no address and no absolute path.
 */
export function renderSiteRunbook(plan: DeployPlan, ctx: SiteRunbookContext): RenderedFile {
  const target = serverlessTarget(plan);
  const cloudflare = target.provider === "cloudflare-workers";
  const { environments } = ctx;
  const command = (text: string) => `\`${opscrew(plan, text, environments)}\``;
  // The schema gives every server-less plan a domain on Cloudflare.
  const domain = plan.dns.domain as string;
  const url = `https://${domain}`;
  const branch = plan.cicd.branch;
  const source = plan.environment?.deploySource;
  const from = source?.from === "promote" ? source.source : undefined;
  const files = siteFiles(plan);
  const { site } = target;
  const worker = cloudflare ? target.worker : undefined;
  const ssr = cloudflare && target.render === "ssr";
  const hosts = siteHosts(plan).map((host) =>
    host === domain
      ? host
      : `${host} (${cloudflare ? "redirects" : "GitHub redirects it"} to ${domain})`,
  );
  const runsOn = cloudflare
    ? `Cloudflare's hosting (Workers with static assets): the Worker \`${worker}\`, ${ssr ? `server-rendered by \`${files.entry}\`` : "a static site"}`
    : "GitHub Pages: the repository's site, published by its workflow";
  const deploys =
    from !== undefined
      ? `only by \`${promoteCommand(plan)}\`, which runs \`${plan.cicd.workflowPath}\` with the build the \`${from}\` environment runs`
      : `every push to \`${branch}\` runs \`${plan.cicd.workflowPath}\``;
  const build =
    site.command === undefined
      ? `none: the files in \`${files.assets}\` are published as they are`
      : `\`${site.command}\` in \`${plan.app.buildContext}\`, the site's files in \`${files.assets}\``;

  const lines = [
    ...runbookTitle(plan, ctx),
    "",
    "## At a glance",
    "",
    "| | |",
    "|---|---|",
    `| App | ${cell(url)} |`,
    `| Runs on | ${cell(runsOn)} |`,
    `| Hostnames | ${cell(`${hosts.join(", ")}: ${cloudflare ? "each a custom domain of the Worker, with Cloudflare's certificate" : "DNS only (Cloudflare's proxy off), with GitHub's certificate"}`)} |`,
    `| Deploys | ${cell(deploys)} |`,
    ...(from === undefined ? [`| Build | ${cell(build)} |`] : []),
    ...(cloudflare ? [`| Settings | \`${wranglerConfigPath(plan)}\` |`] : []),
    `| Cost | ${cell(costText(plan, cloudflare))} |`,
    ...environmentRows(plan, environments),
    "",
    "## How a deploy works",
    "",
    ...(target.provider === "cloudflare-workers"
      ? workersDeploy(plan, { worker: target.worker, from, ssr, url })
      : [
          `1. You push to \`${branch}\` (or run the "${workflowName(plan)}" workflow by hand in GitHub → Actions).`,
          "2. GitHub Actions builds the site, checks it against GitHub Pages' limit of 1 GB per site, and hands it to",
          "   GitHub Pages.",
          `3. The deploy job publishes it in the \`github-pages\` environment and checks that \`${url}/\` answers; while GitHub`,
          "   has not issued the certificate yet, that check is a warning. When the check fails, the run fails, but the new",
          "   site stays published: roll back as below.",
        ]),
    "",
    "## Status",
    "",
    cloudflare
      ? `${command("status")} reads the Worker's deployments from Cloudflare each time (OpsCrew stores none): the version running and the one before, when each was deployed, the run that built it, the command that rolls back to it, and the state of the custom domains.`
      : `${command("status")} reads the GitHub Pages site from GitHub each time: whether OpsCrew's workflow publishes it, its custom domain, the certificate, HTTPS, and the last Pages run and the one before, with the command that rolls back to it.`,
    "",
    "## Roll back",
    "",
    ...(cloudflare
      ? [
          `- **The version before:** \`${promoteCommand(plan)} --version <id>\`, with the id \`${opscrew(plan, "status", environments)}\` lists. Cloudflare`,
          "  serves that version of the Worker for all traffic again within a minute, with no build. OpsCrew shows the version",
          "  with the approval's hash first; in scripts, add `--approve <hash>`. `--yes` never approves it.",
        ]
      : [
          `- **An earlier run:** \`${promoteCommand(plan)} --version <run id>\`, with a run \`${opscrew(plan, "status", environments)}\` lists. GitHub`,
          "  re-runs it: it builds the site again from that run's commit and publishes it. OpsCrew shows the run with the",
          "  approval's hash first; in scripts, add `--approve <hash>`. `--yes` never approves it. GitHub re-runs only runs",
          "  from the last 30 days; for an older one, revert the commit instead.",
        ]),
    from !== undefined
      ? `- **A fix:** push it to \`${branch}\`, let the \`${from}\` environment deploy it, then promote it.`
      : `- **With git:** revert the bad commit and push to \`${branch}\`; the workflow deploys the reverted code.`,
    ...(cloudflare
      ? []
      : [
          `- \`${promoteCommand(plan)}\` without \`--version\` is refused: GitHub Pages has only prod, which builds its own site;`,
          "  roll back with `--version <run id>`.",
        ]),
    "",
    ...(cloudflare ? [] : pagesDomain(plan, ctx.owner, command)),
    ...secretsSection(plan, { cloudflare, ssr, command }),
    "## Other checks",
    "",
    `- ${command("verify")} checks each hostname's DNS, certificate and answer${cloudflare ? ", and OpsCrew's security headers" : ""}.`,
    `- ${command("drift")} compares ${cloudflare ? "the Worker, its workers.dev and preview settings, its custom domains and OpsCrew's rules in the zone" : "the GitHub Pages site, its DNS records and GitHub's verification record"}`,
    `  with what OpsCrew set up, and changes nothing; ${command("provision")} puts them back after showing its plan.`,
    `- ${command("secure")} writes \`${runbookFolders(plan, undefined).artefacts}/SECURITY_REPORT.md\`: ${cloudflare ? "it checks OpsCrew's security headers on the site" : "GitHub Pages cannot set security headers (HSTS, frame and content-type options, the referrer policy), and the report says what that means; Cloudflare's hosting can"}.`,
    "",
    "## If something is wrong",
    "",
    `1. Open the latest "${workflowName(plan)}" run in GitHub → Actions and read the failed step.`,
    `2. Run ${command("verify")} to see which check fails (DNS, certificate, answer …).`,
    ...(cloudflare
      ? [
          "3. The Worker's logs are in the Cloudflare dashboard: Workers & Pages → the Worker → Logs.",
        ]
      : []),
    "",
    ...(cloudflare ? workersTeardown(plan, command) : pagesTeardown(plan, ctx.owner, command)),
    "",
    ...deployAgain(plan, environments),
  ];
  return { path: runbookFilePath(plan), content: lines.join("\n"), kind: "doc" };
}

/** The "Cost" cell: the published plan the design chose, and its monthly price. */
function costText(plan: DeployPlan, cloudflare: boolean): string {
  const { monthly, breakdown, asOf } = plan.cost;
  const items = breakdown.map((entry) => entry.item).join(", ");
  const price =
    monthly.amount === 0
      ? `No monthly cost${items === "" ? "" : ` (${items})`}`
      : `${formatMoney(monthly)} per month${items === "" ? "" : ` (${items})`}`;
  return `${price}, from ${cloudflare ? "Cloudflare" : "GitHub"}'s published plans of ${asOf.slice(0, 10)}`;
}

/** "How a deploy works" on Cloudflare's hosting: a build on each push, or a promoted build. */
function workersDeploy(
  plan: DeployPlan,
  o: { worker: string; from: string | undefined; ssr: boolean; url: string },
): string[] {
  const { worker } = o;
  const config = `\`${wranglerConfigPath(plan)}\``;
  const limit = workersPlan(plan);
  const activate = `It activates the new version for all traffic and checks that \`${o.url}/\` answers. When the activation or the check`;
  const fails = "   fails, it activates the version that ran before again and the run fails.";
  if (o.from !== undefined) {
    return [
      `1. \`${promoteCommand(plan)}\` finds the build the \`${o.from}\` environment runs: the version its Worker runs, and the`,
      "   run and SHA-256 that version's message names. It checks that GitHub still keeps that build: its artifact",
      `   (\`${SITE_ARTIFACT}\`) lives for the repository's artifact retention, 90 days by default; for an older build, deploy`,
      `   \`${o.from}\` again, then promote. It shows it all with the approval's hash, and only after your approval does it start`,
      "   the deploy workflow with the run and the SHA-256; `--yes` never approves a promotion.",
      "2. The workflow checks that the run built the site from a push to this repository and downloads the build. It",
      `   refuses it unless its SHA-256 matches, then uploads it as a new version of the Worker \`${worker}\` with`,
      `   ${config}. Nothing is rebuilt.`,
      `3. ${activate}`,
      fails,
    ];
  }
  return [
    `1. You push to \`${plan.cicd.branch}\` (or run the "${workflowName(plan)}" workflow by hand in GitHub → Actions).`,
    `2. GitHub Actions builds the site and checks it against the ${limit.files.toLocaleString("en-US")} files a version may have on ${limit.name}.`,
    ...(o.ssr
      ? [
          `   Wrangler then bundles the Worker: OpsCrew's headers wrapper \`${cloudflareDir(plan)}/${HEADERS_ENTRY}\` around the`,
          "   adapter's module.",
        ]
      : []),
    `   The build is kept as the artifact \`${SITE_ARTIFACT}\`, with its SHA-256.`,
    "3. The deploy job adds OpsCrew's security headers to the site's `_headers` file (the site's own rules are kept),",
    `   then uploads the build as a new version of the Worker \`${worker}\` with ${config}. The version's message,`,
    "   `opscrew <run id> <sha256>`, names the run and the build, for `opscrew status` and promotion.",
    ...(o.ssr
      ? ["   The app's variables go with the version as its secrets, from their GitHub secrets."]
      : []),
    `4. ${activate}`,
    fails,
  ];
}

/** GitHub Pages' "Your domain at GitHub": the one manual Verify step, and HTTPS. */
function pagesDomain(
  plan: DeployPlan,
  owner: string | undefined,
  command: (text: string) => string,
): string[] {
  const domain = plan.dns.domain as string;
  const org = owner ?? "<owner>";
  return [
    "## Your domain at GitHub",
    "",
    `- **Verify it once:** OpsCrew created GitHub's verification record ${verificationRecord(domain, owner)} (a TXT record).`,
    "  One step is yours, because GitHub has no API for it: open <https://github.com/settings/pages> (for a repository",
    `  an organization owns, <https://github.com/organizations/${org}/settings/pages>) and click **Verify** next to`,
    `  ${domain}. A verified domain can be used only by your account's GitHub Pages sites, so no one else can take it over.`,
    "- **HTTPS:** GitHub issues the site's certificate after it has checked the DNS records, which can take up to",
    `  24 hours; until then the site answers over HTTP only, and ${command("verify")} says so. Run ${command("provision")}`,
    "  again then: it asks GitHub for the certificate, and enforces HTTPS once GitHub has issued it.",
    "",
  ];
}

/** GitHub's verification record ({@link verificationRecordName}) in backticks; `<owner>` unknown. */
function verificationRecord(domain: string, owner: string | undefined): string {
  return `\`${verificationRecordName(owner ?? "<owner>", domain)}\``;
}

/** "Secrets and settings": the deploy secrets by name, and where the settings live. */
function secretsSection(
  plan: DeployPlan,
  o: { cloudflare: boolean; ssr: boolean; command: (text: string) => string },
): string[] {
  const { state, infra } = runbookFolders(plan, undefined);
  const names = plan.app.env.map(
    ({ name }) => `\`${deploySecretName(plan, siteEnvSecret(name))}\``,
  );
  const provision = o.command("provision");
  const infraLine = (what: string) => [
    `- **Infrastructure code:** \`${infra}/\` is plain Terraform/OpenTofu that you own; it creates ${what}. Its`,
    `  state is kept in \`${state}/tfstate/\` on the machine that ran ${provision}.`,
  ];
  if (o.cloudflare) {
    const app = names.length === 0 ? "" : `, and the app's variables, ${names.join(", ")}`;
    // A promoted environment builds nothing: its source's build had the values it needed.
    const readers = [
      promoted(plan) ? undefined : "The build reads them",
      o.ssr ? "the deploy job gives them to the new version as its secrets" : undefined,
    ].filter((reader) => reader !== undefined);
    const use =
      names.length === 0 || readers.length === 0 ? "" : ` ${upperFirst(readers.join(", and "))}.`;
    return [
      "## Secrets and settings",
      "",
      `- **Deploy secrets**, repository secrets in GitHub that ${provision} sets (their values are never in a file, a`,
      `  plan, the state or a log): \`${deploySecretName(plan, CLOUDFLARE_DEPLOY_SECRETS.apiToken)}\`, the deploy token, which holds only Account → Workers`,
      `  Scripts → Edit; \`${deploySecretName(plan, CLOUDFLARE_DEPLOY_SECRETS.accountId)}\`${app}.${use}`,
      `- **To change a value:** run ${provision} again; it updates the GitHub secrets. Then re-run the workflow, so a`,
      "  new version gets it.",
      `- **The Worker's settings** (the not-found handling, preview URLs and the workers.dev address) are in`,
      `  \`${wranglerConfigPath(plan)}\`, generated from \`target\` in \`${runbookFolders(plan, undefined).artefacts}/plan.yaml\`: change them there and run ${provision}.`,
      ...infraLine("the Worker and its custom domains"),
      "",
    ];
  }
  return [
    "## Secrets and settings",
    "",
    names.length === 0
      ? "- **No secrets:** GitHub Pages gives a site no runtime secrets, and whatever its build puts into the site is public, so anyone can read it."
      : `- **The app's values for its build**, ${names.join(", ")}: repository secrets that ${provision} sets. Whatever the build puts into the site is public, so anyone can read it; GitHub Pages gives a site no runtime secrets.`,
    `- **The GitHub Pages site's settings** (published by the workflow, the custom domain, HTTPS) change only through`,
    `  ${provision}'s Pages plan, approved by its hash.`,
    ...infraLine(
      "the site's DNS records, DNS only: Cloudflare's proxy would stop GitHub from issuing and renewing the certificate",
    ),
    "",
  ];
}

/** "Tear it down" on Cloudflare's hosting: the shared rules, then the Worker, then the secrets. */
function workersTeardown(plan: DeployPlan, command: (text: string) => string): string[] {
  const name = plan.app.name;
  const rules = [
    plan.dns.www ? "the `www` redirect" : undefined,
    plan.security.wafCustomRules ? "the probe block" : undefined,
  ].filter((rule) => rule !== undefined);
  return [
    "## Tear it down",
    "",
    `Run ${command("destroy")} on the machine that ran ${command("provision")} (the state lives there). It lists what it`,
    `deletes, then asks you to type the app's name (\`${name}\`) before anything is deleted; in scripts, pass \`--confirm ${name}\`.`,
    "Then, each after its own approval:",
    "",
    ...(rules.length === 0
      ? []
      : [
          `- this app's hostnames leave OpsCrew's shared rules in the zone (${rules.join(" and ")});`,
        ]),
    "- the Worker's custom domains and the Worker are deleted; its secrets go with it;",
    "- the deploy secrets in GitHub are removed.",
    "",
    "Running it again continues with what is left. What remains: the files in the repository (pushes still run the",
    `workflow, but its deploy fails until ${command("provision")} creates the Worker again), and the deploy token you created`,
    "for the workflow: OpsCrew never deletes tokens, so delete it in Cloudflare's dashboard (My Profile → API Tokens) if no",
    "other app uses it.",
  ];
}

/** "Tear it down" on GitHub Pages, in the takeover-safe order. */
function pagesTeardown(
  plan: DeployPlan,
  owner: string | undefined,
  command: (text: string) => string,
): string[] {
  const name = plan.app.name;
  const domain = plan.dns.domain as string;
  return [
    "## Tear it down",
    "",
    `Run ${command("destroy")} on the machine that ran ${command("provision")} (the state lives there). It lists what it`,
    `changes, then asks you to type the app's name (\`${name}\`) before anything is deleted; in scripts, pass \`--confirm ${name}\`.`,
    "Then, each after its own approval and in an order that never leaves the domain to be taken over:",
    "",
    `- it deletes the site's DNS records first, while the GitHub Pages site still claims ${domain};`,
    "- then it removes the custom domain, turns GitHub Pages off and deletes its `github-pages` environment;",
    "- then it removes the app's values for its build from GitHub.",
    "",
    `GitHub's verification record ${verificationRecord(domain, owner)} stays, so ${domain} stays verified for your`,
    `GitHub account; ${command("destroy --delete-verification")} deletes it too, also in a later run on its own. Running it`,
    "again continues with what is left; the files in the repository stay.",
  ];
}
