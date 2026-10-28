import type { DeployPlan } from "@opscrew/plan-schema";
import { CHECK_LABEL, CHECK_WORKFLOW_FILE, checkDiskVia } from "../check";
import { BESZEL_PORT, beszelHostname, tunnelMode } from "../tunnel";
import { opscrew, runbookFolders } from "./shared";

/** What the check does with the environment's disk, after "and its certificate's days left". */
function diskText(plan: DeployPlan): string {
  switch (checkDiskVia(plan)) {
    case "own-runner":
      return ", and the server's free disk, read by a job on the server's own runner (an issue at 85% full, and at 95%).";
    case "github":
    case "runner-host":
      return ", and the server's free disk over SSH, with a key the server lets run only `df` (an issue at 85% full, and at 95%).";
    case undefined:
      return tunnelMode(plan)
        ? ". It reads no disk here: the check's SSH can't pass the tunnel's Cloudflare Access login (deploying from the server's own runner would let it read the disk there)."
        : ".";
  }
}

/**
 * "The scheduled check", when the plan has it on: what it checks for this environment, what an
 * `opscrew-check` issue means and how to pause it. Nothing without the check.
 */
export function checkSection(plan: DeployPlan, environments?: readonly string[]): string[] {
  if (plan.observability?.check?.enabled !== true) return [];
  const status = opscrew(plan, "status", environments);
  return [
    "## The scheduled check",
    "",
    `\`.github/workflows/${CHECK_WORKFLOW_FILE}\` checks this environment in GitHub Actions on a schedule: each of the app's hostnames over`,
    `HTTPS, each certificate's days left (an issue below 14)${diskText(plan)}`,
    "",
    `- **An open issue labelled \`${CHECK_LABEL}\`** means a check still fails: its title names the app, the environment and`,
    `  what failed, and its body when it started. \`${status}\` shows the check's state and its open issues, and`,
    `  \`${opscrew(plan, "logs", environments)}\` the app's lines. The check closes the issue itself when it passes again, with how long`,
    "  the problem lasted, and adds a comment only when what fails changes.",
    `- **Pause it** for maintenance with \`gh workflow disable ${CHECK_WORKFLOW_FILE}\` (every app of the repository), and turn it`,
    `  on again with \`gh workflow enable ${CHECK_WORKFLOW_FILE}\`. OpsCrew pauses this environment by itself while`,
    "  `opscrew retarget` moves it or `opscrew destroy` removes it.",
    "- **In a public repository,** GitHub turns scheduled workflows off after 60 days without activity. The check opens",
    `  an issue from day 50; push any commit to keep it running. \`${status}\` says when GitHub turned it off.`,
    "",
  ];
}

/**
 * The sections of the add-ons the plan has on: Beszel (how to open its dashboard, or that it reports
 * to the user's hub) and Grafana Cloud (where the lines and metrics go), each with how to turn it
 * off. Never a secret: the password and the token are named by their files.
 */
export function addonSections(
  plan: DeployPlan,
  ctx: { projectId?: string; environments?: readonly string[] },
): string[] {
  const { projectId, environments } = ctx;
  const addon = (command: string) => `\`${opscrew(plan, `addon ${command}`, environments)}\``;
  const { beszel, grafanaCloud } = plan.observability ?? {};
  const home = runbookFolders(plan, projectId).home;
  const lines: string[] = [];
  if (beszel?.enabled) {
    const hostname = beszelHostname(plan);
    lines.push(
      "## Beszel",
      "",
      ...(beszel.mode === "agent"
        ? [
            `Beszel's agent ${beszel.version} runs on the server and reports the server's and its containers' CPU, memory, disk and`,
            `network to your Beszel hub at ${beszel.hubUrl}: open it there. Its token is in \`${home}/beszel_secrets.json\``,
            "on the machine that turned it on, never in this repository.",
          ]
        : [
            `Beszel ${beszel.version} charts the server's and its containers' CPU, memory, disk and network. Its dashboard listens`,
            `only on the server (127.0.0.1:${BESZEL_PORT}). ${addon("open beszel")} keeps an SSH tunnel to it open; then open`,
            `http://localhost:${BESZEL_PORT} and log in as \`admin@opscrew.invalid\` with the \`password\` in`,
            `\`${home}/beszel_secrets.json\` on the machine that turned it on (never in this repository).`,
            ...(hostname === undefined
              ? []
              : [
                  `It is also served on https://${hostname}, behind Cloudflare Access: only the email addresses listed in`,
                  `\`${runbookFolders(plan, undefined).artefacts}/plan.yaml\` get in, with a one-time PIN sent to that address, and Beszel's own login still applies.`,
                ]),
            "Set Beszel's own alerts in its dashboard, under Settings → Notifications.",
          ]),
      "",
      "Beszel reads Docker only through OpsCrew's read-only proxy: the containers and their figures, never their settings or",
      `logs. ${addon("status")} shows its containers and their memory.`,
      beszel.mode === "agent"
        ? `${addon("disable beszel")} removes the agent and its token; remove the system from your hub too.`
        : `${addon("disable beszel")} removes it and deletes its history after you type the app name (\`--keep-data\` keeps the history).`,
      "",
    );
  }
  if (grafanaCloud?.enabled) {
    const sampled = grafanaCloud.logSampling < 100 ? ` (${grafanaCloud.logSampling}% of them)` : "";
    lines.push(
      "## Grafana Cloud",
      "",
      `Grafana Alloy ${grafanaCloud.version} sends the app's log lines${sampled}, labelled \`app="${plan.app.name}"\`, \`env\` and \`service\`, to`,
      `${grafanaCloud.logs?.url} and the server's CPU, load, memory and disk to ${grafanaCloud.metrics?.url}.`,
      "Values shaped like secrets, and the app's own secret values, are masked on the server before they leave it. Search",
      "them in your Grafana Cloud stack; the free tier keeps them 14 days. The token is in",
      `\`${home}/grafana_cloud_token\` on the machine that turned it on, never in this repository.`,
      "",
      `${addon("disable grafana-cloud")} removes Alloy, its buffer, its token and the masking file from the server. The data`,
      "already in Grafana Cloud stays in your account.",
      "",
    );
  }
  return lines;
}
