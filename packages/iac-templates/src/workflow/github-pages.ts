// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { ACTIONS } from "../pins";
import { wrongTarget } from "../providers";
import { shellQuote } from "../runtime/services";
import { answerCheck, siteBuildSteps, siteExists, siteFiles, siteUrl } from "../serverless/site";
import type { RenderedFile } from "../types";
import { job, promoted, provisionCommand, run, workflowStart } from "./shared";

/** The largest site GitHub Pages publishes: 1 GB. */
const PAGES_SITE_BYTES = 1024 ** 3;

/**
 * `cicd.workflowPath` for GitHub Pages (`renderWorkflow` delegates here): on each push, the build
 * job builds the site ({@link siteBuildSteps}), checks it against GitHub Pages' 1 GB, and hands it
 * to GitHub with the pinned `configure-pages` and `upload-pages-artifact` (hidden files such as
 * `.well-known` kept), holding `contents: read` and `pages: read` only. The deploy job publishes it
 * with `deploy-pages` in the `github-pages` environment, the only job with `pages: write` and
 * `id-token: write`, then checks the site's answer on its domain; while GitHub has not issued the
 * certificate yet, that is a warning ({@link answerCheck}). The triggers, permissions and
 * concurrency are as for servers.
 * @throws OpsCrewError `INVALID_INPUT` for a promoted environment: GitHub Pages publishes from a
 * build, so each environment builds its own.
 */
export function renderGithubPagesWorkflow(plan: DeployPlan): RenderedFile {
  if (plan.target.provider !== "github-pages") {
    throw wrongTarget("This step only applies to a site on GitHub Pages.");
  }
  if (promoted(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A site on GitHub Pages cannot be promoted: GitHub Pages publishes from a build, so each environment builds its own.",
      {
        hint: "Set environment.deploySource to { from: main } in the environment's plan, then run `opscrew provision` for it again.",
      },
    );
  }
  const files = siteFiles(plan);
  const build = job({
    id: "build",
    name: "Build the site",
    permissions: ["contents: read", "pages: read"],
    steps: [
      ...siteBuildSteps(plan, []),
      "- name: Check the site against GitHub Pages' limit",
      ...run([
        "set -euo pipefail",
        ...siteExists(plan, files),
        `bytes="$(du -sb ${shellQuote(files.assets)} | cut -f 1)"`,
        `if [[ "$bytes" -gt ${PAGES_SITE_BYTES} ]]; then`,
        `  echo "::error::The site in ${files.assets} is $(( bytes / 1048576 )) MB, over the 1 GB GitHub Pages publishes. Leave out the files the site does not need, or host it on Cloudflare (\\\`opscrew design\\\`), then push again."`,
        "  exit 1",
        "fi",
      ]),
      `- uses: ${ACTIONS.configurePages}`,
      "- name: Keep the built site for GitHub Pages",
      `  uses: ${ACTIONS.uploadPagesArtifact}`,
      "  with:",
      `    path: ${JSON.stringify(files.assets)}`,
      "    # Keeps files such as .well-known, which the action leaves out otherwise.",
      "    include-hidden-files: true",
    ],
  });
  const deploy = job({
    id: "deploy",
    name: "Publish on GitHub Pages",
    needs: "build",
    environment: "github-pages",
    permissions: ["pages: write", "id-token: write"],
    steps: [
      "- name: Publish the site",
      `  uses: ${ACTIONS.deployPages}`,
      "- name: Check that the site answers",
      "  env:",
      `    URL: ${siteUrl(plan)}`,
      ...run(
        answerCheck(
          `GitHub has not issued the certificate for ${plan.dns.domain} yet, so this run could not check the site over HTTPS. GitHub issues it once it has checked the domain's DNS records, which can take up to 24 hours; \\\`opscrew verify\\\` says when it is there. Then run \\\`${provisionCommand(plan)}\\\` to enforce HTTPS.`,
        ),
      ),
    ],
  });
  const lines = [
    ...workflowStart(plan, [
      "# Builds the site and publishes it on GitHub Pages. Secrets are set by `opscrew provision`; their",
      "# values never appear in this file, but whatever the build puts into the site is public.",
    ]),
    ...build,
    "",
    ...deploy,
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
