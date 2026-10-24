import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addApp,
  chooseEngine,
  listApps,
  type PhaseDeps,
  pagesVerificationStateFile,
  removeApp,
  stateContents,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { readOptionalArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { projectDirInput, runTool, toolApp } from "./shared";

const KEY_INPUT = z
  .string()
  .min(1)
  .describe("The app's key, for example docs (lower-case letters, digits, -).");

/**
 * False when `removeApp` refuses the further app `deps.paths` belong to before removing anything:
 * it is deployed, or the state of its GitHub Pages verification root may still hold the record.
 */
async function appRemovable(deps: PhaseDeps): Promise<boolean> {
  const { paths } = deps;
  if ((await listApps(paths)).some((one) => one.key === paths.app && one.deployed)) return false;
  const prod = await readOptionalArtifact("plan", paths.files.plan);
  const held = await stateContents(deps, pagesVerificationStateFile(paths), () =>
    chooseEngine(deps, prod?.infra.engine ?? "auto"),
  );
  return held === "nothing";
}

/**
 * The tools for several apps in one repository (contracts/apps.md "CLI and MCP"):
 * `opscrew_app_add`, `opscrew_app_list` and `opscrew_app_remove`, which the user confirms by
 * typing the app's key in a dialog.
 */
export function registerAppTools(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_app_list",
    {
      title: "List the repository's apps",
      description:
        "List the repository's apps: the first app (the repository's own, which has no key; pass app . for it), then each further app opscrew_app_add added, with its key, its folder and whether it is deployed. Pass a further app's key as app to every other tool to act on it. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_app_list", projectDir, async (call) => {
        const apps = await listApps((await call.phaseDeps()).paths);
        const lines = apps.map(
          (app) =>
            `- ${app.key ?? "the first app (app .)"}: in ${app.dir}, ${app.deployed ? "deployed" : "not deployed"}`,
        );
        return { text: ["The repository's apps:", ...lines].join("\n"), data: { apps } };
      }),
  );

  server.registerTool(
    "opscrew_app_add",
    {
      title: "Add an app of the repository",
      description:
        "Add a further app of the repository in its own folder (for example a documentation site in sites/docs beside the landing page): checks that the folder holds an app OpsCrew can deploy and that none of the names the key gives (workflow, deploy secrets, GitHub environment, image, branches) is another app's or environment's, then writes only its record, opscrew/apps/<key>/app.yaml. The app then has its own plans, environments, workflows, secrets, state and approvals. Next: the planning tools with app set to its key (opscrew_interview_questions, opscrew_save_requirements, opscrew_design_options, opscrew_select_design).",
      inputSchema: {
        ...projectDirInput,
        key: KEY_INPUT,
        dir: z
          .string()
          .min(1)
          .describe("The app's folder in the repository, for example sites/docs."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ projectDir, key, dir }) =>
      runTool(deps, "opscrew_app_add", projectDir, async (call) => {
        const app = await addApp(call.projectDir, key.trim(), dir);
        return {
          text: `Added the app ${app.key} in ${app.dir} (opscrew/apps/${app.key}/app.yaml). Next: call opscrew_interview_questions with app ${app.key}, then opscrew_save_requirements and the design tools with app ${app.key}.`,
          data: { app },
        };
      }),
  );

  server.registerTool(
    "opscrew_app_remove",
    {
      title: "Remove an app of the repository",
      description:
        "Remove a further app's files: its record, plans and answers in opscrew/apps/<key>, its infrastructure code and deploy workflows, and what OpsCrew keeps for it on this computer (its deploy keys, state passphrases and generated secrets). Its folder in the repository stays. Refused while the app is deployed (the user destroys it first with `npx opscrew destroy --app <key>`), and never the first app. Only when the user asks for it: the user confirms by typing the app's key in a dialog. Refuses when the client cannot show dialogs.",
      inputSchema: { ...projectDirInput, key: KEY_INPUT },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, key }, extra: CallExtra) =>
      runTool(deps, "opscrew_app_remove", projectDir, async (call) => {
        const appKey = await toolApp(call.projectDir, key);
        requireDialogs(server, `npx opscrew app remove ${key.trim()}`);
        const phase = await call.phaseDeps({
          approvalHandler: dialogHandler(server, deps, extra),
          app: appKey,
        });
        // removeApp refuses the first app, a deployed one and one whose GitHub Pages verification
        // record may still be in DNS: nothing is asked for those.
        if (appKey !== undefined && (await appRemovable(phase))) {
          // It deletes the app's deploy keys, passphrases and secrets: the user types its key.
          const approval = await phase.approvals.request({
            kind: "repo-write",
            title: `Remove the app ${appKey}'s files`,
            details: `This removes the app ${appKey}'s files: its record, plans and answers in opscrew/apps/${appKey}, its infrastructure code and deploy workflows, and what OpsCrew keeps for it on this computer (its deploy keys, state passphrases and generated secrets). Its folder in the repository stays.`,
            allowDestroy: true,
            confirmPhrase: appKey,
          });
          if (!approval.approved) {
            throw new OpsCrewError(
              "APPROVAL_REFUSED",
              `The user did not confirm removing the app ${appKey}, so nothing was removed.`,
              { hint: "Call opscrew_app_remove again only when the user asks." },
            );
          }
        }
        const removed = await removeApp(phase);
        return {
          text: `Removed the app ${appKey}'s files${removed.length === 0 ? "; none were left" : `: ${removed.join(", ")}`}.`,
          data: { removed },
        };
      }),
  );
}
