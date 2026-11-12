/**
 * The provision pull request's body for an app on a hosting account with a panel (027 plan 4,
 * ADR 0030): what it adds and how a release reaches the account.
 */
import { releaseBranch } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { planFile } from "../runners/words";
import { committedHostingFolder, environmentOf } from "./provision-plans";

/**
 * What the pull request adds (the workflow, the agent and its settings, the DNS root when the
 * domain is on Cloudflare, the plan) and what merging it does. It names the hostname, never the
 * account's address or user.
 */
export function hostingPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: { flag?: string; recoveryCopy?: string } = {},
): string {
  const file = planFile(plan);
  const flag = options.flag ?? "";
  const folder = committedHostingFolder(plan);
  const where = plan.dns.domain ?? "the hosting account";
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`${file}\` for **${plan.app.name}**, which your hosting account serves:`,
    "",
    `- \`${plan.cicd.workflowPath}\`: builds each release on every push to \`${plan.cicd.branch}\`, signs it with the deploy environment's key and publishes it on the branch \`${releaseBranch(plan)}\`, then waits until ${where} serves it. The signing key is the only secret in GitHub: no credential of the account is there.`,
    `- \`${folder}/agent.sh\`: OpsCrew's agent, which cron runs every minute on the account. It deploys only releases signed with the environment's key, switches the hostname to each one in one step, checks the app and switches back if it doesn't answer. The account holds a copy; \`opscrew drift${flag}\` compares them.`,
    `- \`${folder}/${environmentOf(plan)}.sh\`: the agent's settings for this environment (no secret: the app's values stay in a file on the account, outside the web root).`,
    ...(plan.dns.provider === "cloudflare"
      ? [
          `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: the hostname's A record to the account, DNS only (works with OpenTofu and Terraform).`,
        ]
      : []),
    `- \`${file}\`: the deployment plan.`,
    ...(options.recoveryCopy === undefined
      ? []
      : [
          `- \`${options.recoveryCopy}\`: the encrypted recovery copy of what OpsCrew keeps on your computer for this app (its records, the infrastructure state). Only your age key opens it.`,
        ]),
    "",
    `The account is set up and the release signing key is stored in GitHub Actions. **Merging this pull request deploys the app to ${where}** within about a minute of its build. After the first deploy, run \`opscrew verify${flag}\`.`,
    "",
    "Review checklist:",
    "- [ ] The workflow only uses pinned, first-party actions.",
    `- [ ] \`${folder}/agent.sh\` is the script you expect to run on your account.`,
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}
