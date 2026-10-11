import { detectStack } from "@opscrew/iac-templates";
import type { CodeChangeKind, ProjectFacts } from "@opscrew/plan-schema";
import { djangoPlaybook } from "./django";
import { fastapiPlaybook } from "./fastapi";
import { genericPlaybook } from "./generic";
import { nextjsPlaybook } from "./nextjs";
import { nodeServerPlaybook } from "./node-server";
import { staticSpaPlaybook } from "./static-spa";
import type { Playbook, PlaybookId } from "./types";

export type { Playbook, PlaybookId } from "./types";

/** Every playbook by id. */
export const PLAYBOOKS: Readonly<Record<PlaybookId, Playbook>> = Object.freeze({
  nextjs: nextjsPlaybook,
  "node-server": nodeServerPlaybook,
  "static-spa": staticSpaPlaybook,
  fastapi: fastapiPlaybook,
  django: djangoPlaybook,
  generic: genericPlaybook,
});

/** The playbook for the app's container stack (the generic one when there is no better match). */
export function playbookFor(facts: ProjectFacts): Playbook {
  switch (detectStack(facts)) {
    case "next-standalone":
      return nextjsPlaybook;
    case "node-server":
      return nodeServerPlaybook;
    case "static-spa":
      return staticSpaPlaybook;
    case "python-fastapi":
      return fastapiPlaybook;
    case "python-django":
      return djangoPlaybook;
    default:
      return genericPlaybook;
  }
}

/** How to make a change of `kind` and how to check it, falling back to the generic playbook. */
export function playbookInstructions(
  playbook: Playbook,
  kind: CodeChangeKind,
): { step: string; checks: readonly string[] } {
  return {
    step:
      playbook.steps[kind] ??
      genericPlaybook.steps[kind] ??
      (genericPlaybook.steps.other as string),
    checks: playbook.checks[kind] ?? genericPlaybook.checks[kind] ?? [],
  };
}
