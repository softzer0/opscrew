import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import { z } from "zod";
import { stackPlanFile } from "../provision/portainer";
import { readIfExists } from "./files";
import { hostPlanFile } from "./host-plan";

/** A plan saved beside the infrastructure plan: a server's host plan or a Portainer's stack plan. */
export type SavedPlanKind = "host" | "stack";

const changed = z.looseObject({ state: z.string() });
const SAVED_PLAN_ITEMS = {
  host: z.looseObject({ steps: z.array(changed) }).transform((plan) => plan.steps),
  stack: z.looseObject({ changes: z.array(changed) }).transform((plan) => plan.changes),
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Whether the saved host or stack plan with this hash (`.opscrew/plans/<kind>-<hash>.json`)
 * changes something, so it needs its own approval: `undefined` when no such plan was saved. A
 * file that is not a plan stops with `ARTIFACT_INVALID` and `hint`, and any read error other than
 * a missing file is thrown, so a damaged plan never passes for one that changes nothing.
 */
export async function readSavedPlanChanges(
  paths: Pick<ProjectPaths, "files">,
  kind: SavedPlanKind,
  hash: string,
  hint: string,
): Promise<boolean | undefined> {
  const file = kind === "host" ? hostPlanFile(paths, hash) : stackPlanFile(paths, hash);
  const text = await readIfExists(file);
  if (text === undefined) return undefined;
  const items = SAVED_PLAN_ITEMS[kind].safeParse(parseJson(text));
  if (!items.success) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved ${kind} plan ${hash} (.opscrew/plans/${kind}-${hash}.json) is damaged, so OpsCrew cannot tell what it changes.`,
      { hint },
    );
  }
  return items.data.some((item) => item.state === "change");
}
