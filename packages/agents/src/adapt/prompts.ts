import { type DeployPlan, isServerlessTarget, type ProjectFacts } from "@opscrew/plan-schema";
import { z } from "zod";
import type { CodeChange } from "../design/code-changes";
import { appDirOf } from "../design/code-changes";
import { serverlessName } from "../shared";
import { type Playbook, playbookInstructions } from "./playbooks";

/** Default model for the Code-change agent. */
export const CODE_CHANGE_MODEL = "claude-opus-5-5";

/** Structured output the Code-change agent must return: one status per change it was given. */
export const CodeChangeReportSchema = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        status: z.enum(["applied", "skipped"]),
        notes: z.string().max(2_000).default(""),
      }),
    )
    .max(200),
  /** Packages the agent had to add, as `name` or `name@range`; empty when none. */
  addedDependencies: z.array(z.string().min(1).max(200)).max(50).default([]),
});
export type CodeChangeReport = z.output<typeof CodeChangeReportSchema>;

/** System prompt of the Code-change agent (runs in the `edit-repo` profile). */
export const CODE_CHANGE_SYSTEM_PROMPT = `You are OpsCrew's Code-change agent. You prepare an existing application for its production deployment, described in the task. A person reviews your work in a pull request before anything is deployed.

Rules you must follow:
1. Edit only the files listed in the task, and create new files only at the listed paths. The one exception: you may add variable names, never values, to .env.example when it exists.
2. Keep the app's behaviour the same. Make the smallest change that meets each acceptance check. Do not refactor, rename, reformat or "improve" unrelated code.
3. Never read, print or copy secrets. Do not open .env files, private keys or credential files. Never write a secret value into code, comments, tests, notes or examples; read it from an environment variable instead.
4. Do not add dependencies unless a change is impossible without one. If you add any, list every package in addedDependencies and explain why in the change's notes.
5. Never edit anything under opscrew/ or .opscrew/, and never edit a Dockerfile or .dockerignore unless the task lists it. OpsCrew writes those files itself.
6. Do not commit, push, create branches or call the network. OpsCrew commits your edits only after the user approves them.
7. When a change is not needed, not possible without changing behaviour, or unsafe, leave the code as it is and mark the change skipped with a short reason.

When you are done, return a report with exactly one entry per change id from the task: status "applied" when the change is in place and its acceptance checks hold, or "skipped" otherwise, and short plain-English notes (what you changed, or why you skipped it). Do not put secret values in the notes.`;

export interface CodeChangePromptInput {
  facts: ProjectFacts;
  plan: DeployPlan;
  /** Changes the agent must make (normally the plan's pending changes). */
  changes: readonly CodeChange[];
  playbook: Playbook;
}

/**
 * The task prompt for the Code-change agent: a secret-free project summary (environment variable
 * names only), the framework playbook and each change with how to make it and its acceptance
 * checks. Callers still pass the result through the redactor before sending it.
 */
export function buildCodeChangePrompt(input: CodeChangePromptInput): string {
  const { facts, plan, changes, playbook } = input;
  const frameworks = facts.frameworks.map((f) =>
    f.path === "." ? f.name : `${f.name} (${f.path})`,
  );
  const envNames = plan.app.env.map((variable) => variable.name);
  const appDir = appDirOf(facts);
  const { target } = plan;
  const serverless = isServerlessTarget(target);
  const worker =
    target.provider === "cloudflare-workers" && target.render === "ssr"
      ? " and runs its server-rendered pages as a Cloudflare Worker"
      : "";
  const lines: string[] = [
    serverless
      ? `Prepare the app "${facts.name}" for ${serverlessName(target.provider)}, which serves the site's build output${worker}; there is no container or server.`
      : `Prepare the app "${facts.name}" for a production container.`,
    "",
    "## Project",
    ...(appDir === "."
      ? []
      : [
          `- App folder: ${appDir} (this repository holds several apps; change only this app and the files listed below, never the other apps)`,
          ...(serverless
            ? []
            : [
                `- The container image is built from the repository root with ${plan.app.dockerfile}, so code shared from other folders of the repository is available at build time`,
              ]),
        ]),
    `- Languages: ${facts.languages.join(", ") || "unknown"}`,
    `- Frameworks: ${frameworks.join(", ") || "none detected"}`,
    `- Package manager: ${facts.packageManager}`,
    `- App kind: ${facts.appKind}`,
    ...(serverless
      ? []
      : [
          `- Container port: ${plan.app.port} (read from the PORT environment variable)`,
          `- Health check path: ${plan.app.healthPath}`,
        ]),
    `- Environment variable names (values are never shown): ${envNames.join(", ") || "none"}`,
    "",
    `## Playbook: ${playbook.title}`,
    ...playbook.guidance.map((line) => `- ${line}`),
    "",
    "## Changes to make",
  ];
  for (const change of changes) {
    const { step, checks } = playbookInstructions(playbook, change.kind);
    lines.push(
      "",
      `### ${change.id} (${change.kind})`,
      `- File: ${change.path}`,
      `- Why: ${change.reason}`,
      `- How: ${step}`,
      "- Acceptance checks:",
      ...checks.map((check) => `  - ${check}`),
    );
  }
  lines.push(
    "",
    `Report exactly these change ids: ${changes.map((change) => change.id).join(", ")}.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Plain-English manual instructions for one change (used when no model runs). */
export function manualInstructions(change: CodeChange, playbook: Playbook): string {
  const { step, checks } = playbookInstructions(playbook, change.kind);
  const done = checks.length > 0 ? ` Done when: ${checks.join(" ")}` : "";
  return `${change.path}: ${change.reason} How: ${step}${done}`;
}
