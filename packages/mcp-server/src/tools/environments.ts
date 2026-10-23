import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addEnvironment,
  deployJobPlace,
  listEnvironments,
  type PromoteServices,
  promote,
  removeEnvironment,
  setEnvironment,
} from "@opscrew/agents";
import type { ApprovalHandler, ComputeCatalog } from "@opscrew/contracts";
import { formatMoney, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { projectDirInput, runTool, withHint } from "./shared";

/** Test-only collaborators for the environment tools. */
export interface EnvironmentToolOptions {
  /** The price list `opscrew_env_add` designs with (production: the provider's, live or dated). */
  catalog?: ComputeCatalog;
  /** GitHub and the target's read-only check for `opscrew_promote`. */
  promote?: PromoteServices;
}

const NAME_INPUT = z
  .string()
  .min(1)
  .describe("The environment's name, for example staging or dev (lower-case letters, digits, -).");

/**
 * The environment tools (contracts/environments.md "Commands"): `opscrew_env_add`,
 * `opscrew_env_set`, `opscrew_env_list`, `opscrew_env_remove`, and `opscrew_promote`, whose
 * `promote` approval only the user grants, in a dialog that shows the promotion's hash.
 * `options` is for tests only.
 */
export function registerEnvironmentTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: EnvironmentToolOptions = {},
): void {
  server.registerTool(
    "opscrew_env_list",
    {
      title: "List the app's environments",
      description:
        "List the app's environments (prod, then each one added beside it): where each runs, how it gets new versions (each push to the branch it follows, or promoted from another environment), where its deploy job runs (GitHub's machines, a runner on the server, on the user's computer or on a runner machine of the user's) and whether it is deployed. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_env_list", projectDir, async (call) => {
        const environments = await listEnvironments((await call.phaseDeps()).paths);
        const lines = environments.map(
          (env) =>
            `- ${env.name}: runs on ${env.target}, ${env.from === "main" ? `deployed on each push to ${env.branch}` : `promoted from ${env.from}`}, deploy job on ${deployJobPlace(env.runner, env.runnerHost)}, ${env.deployed ? "deployed" : "not deployed"}`,
        );
        return {
          text:
            environments.length === 0
              ? "The app has no environment yet: design prod first (opscrew_design_options, opscrew_select_design)."
              : ["The app's environments:", ...lines].join("\n"),
          data: { environments },
        };
      }),
  );

  server.registerTool(
    "opscrew_env_add",
    {
      title: "Add an environment",
      description:
        "Add an environment beside prod (staging, dev, …): write its own answers (only those that differ from prod's) to opscrew/environments/<name>/requirements.yaml and design it, with its monthly cost. Its build, components and port follow the image: its own design's when it is built from a branch, or the plan's of the environment it is promoted from. Ask the user its questions first; answers left out take their defaults: provider (prod's, or localhost, the user's computer, for dev), region, expectedMonthlyUsers (<1k), domain (<name>.<prod's domain>), from (main: built and deployed on each push; or an environment it is promoted from), branch (with from main: the branch whose pushes build and deploy it, one the repository has and no other environment follows; default: the repository's default branch. When the repository has a branch named like the environment, such as develop for dev, OpsCrew's note names it: offer the user promotion first, where only the first environment follows a branch and one image moves dev → staging → prod, or each environment on its own branch), runner (github, server, local, or host: a runner machine of the user's, opscrew_runner_host_list), runnerHost (with host: the machine's name; the only one by default) and build (github, the default, or runner: built on its own runner, a runner machine with the server's CPU or the user's computer, never the server). Next: the user provisions it with `npx opscrew provision --env <name>` or opscrew_plan with environment.",
      inputSchema: {
        ...projectDirInput,
        name: NAME_INPUT,
        answers: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe(
            "The user's answers by question id: provider, region, expectedMonthlyUsers, domain, from, branch, runner, runnerHost, build (and a server's server.* or a Portainer's portainer.* follow-ups).",
          ),
        optionId: z
          .string()
          .optional()
          .describe("The design option the user chose (default: the recommended one)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ projectDir, name, answers, optionId }) =>
      runTool(deps, "opscrew_env_add", projectDir, async (call) => {
        const phase = await call.phaseDeps({ environment: name });
        const { design } = await addEnvironment(phase, {
          answers: answers ?? {},
          design: {
            ...(optionId === undefined ? {} : { optionId }),
            ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
          },
        });
        const { chosen, plan } = design;
        return {
          text: [
            `Added the ${name} environment: ${chosen.title} (${chosen.id}), about ${formatMoney(chosen.cost.monthly)} a month.`,
            ...design.warnings.map((warning) => `Warning: ${warning}`),
            `Next: the user provisions it with \`npx opscrew provision --env ${name}\` in a terminal, or call opscrew_plan with environment ${name}.`,
          ].join("\n"),
          data: {
            environment: plan.environment,
            branch: plan.cicd.branch,
            option: chosen.id,
            monthly: chosen.cost.monthly,
            options: design.options.map((option) => option.id),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_env_set",
    {
      title: "Change how an environment gets new versions",
      description:
        "Change an environment's plan: its deploy source (from: main, built and deployed on each push, or another existing environment it is promoted from, never itself and never in a cycle), the branch whose pushes build and deploy it from main (branch: one the repository has and no other environment follows), and where its deploy job runs (runner: github, server, local or host, a runner machine of the user's, with runnerHost its name) and where its image is built (build: github, or runner on a runner machine with the server's CPU or the local runner; never the server's runner). The change reaches GitHub and the runners with its next provision, which shows each change first.",
      inputSchema: {
        ...projectDirInput,
        name: NAME_INPUT,
        from: z
          .string()
          .min(1)
          .optional()
          .describe("main, or the environment it is promoted from (for example staging)."),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("The branch it follows from main (for example develop)."),
        runner: z.enum(["github", "server", "local", "host"]).optional(),
        runnerHost: z
          .string()
          .min(1)
          .optional()
          .describe("With runner host: the runner machine (default: the project's only one)."),
        build: z
          .enum(["github", "runner"])
          .optional()
          .describe("With runner: where the image is built (default: the plan's, where it fits)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ projectDir, name, from, branch, runner, runnerHost, build }) =>
      runTool(deps, "opscrew_env_set", projectDir, async (call) => {
        if (runner === undefined && (runnerHost !== undefined || build !== undefined)) {
          throw new OpsCrewError("INVALID_INPUT", "runnerHost and build go with runner.", {
            hint: 'For example runner "host", runnerHost "home" and build "runner".',
          });
        }
        if (from === undefined && branch === undefined && runner === undefined) {
          throw new OpsCrewError("INVALID_INPUT", "Pass from, branch, runner or several of them.", {
            hint: "from changes how the environment gets new versions; branch the branch it follows from main; runner (with runnerHost and build) where its deploy job runs.",
          });
        }
        const lines: string[] = [];
        const phase = await call.phaseDeps({ environment: name });
        const plan = await setEnvironment(phase, {
          ...(from === undefined ? {} : { from }),
          ...(branch === undefined ? {} : { branch }),
          ...(runner === undefined
            ? {}
            : {
                runner: {
                  runner,
                  ...(runnerHost === undefined ? {} : { runnerHost }),
                  ...(build === undefined ? {} : { build }),
                },
              }),
        });
        const environment = plan.environment;
        const source = environment?.deploySource ?? { from: "main" as const };
        if (runner !== undefined) {
          lines.push(
            `The ${name} environment's deploy job runs on ${deployJobPlace(environment?.runner ?? "github", environment?.runnerHost?.name)}${environment?.build === "runner" ? ", which also builds its image" : "; GitHub's machines build its image"}.`,
          );
        }
        if (branch !== undefined && from === undefined) {
          lines.push(
            source.from === "promote"
              ? `The ${name} environment follows ${plan.cicd.branch} once it is built from main again (from main); until then only opscrew_promote deploys it.`
              : `The ${name} environment is built and deployed on each push to ${plan.cicd.branch}.`,
          );
        }
        if (from !== undefined) {
          lines.push(
            `The ${name} environment ${source.from === "promote" ? `is deployed only by opscrew_promote, with the image ${source.source} runs` : `is built and deployed on each push to ${plan.cicd.branch}`}.`,
          );
        }
        lines.push(
          `Next: apply the change with \`npx opscrew provision --env ${name}\`, or opscrew_plan with environment ${name}.`,
        );
        return {
          text: lines.join(" "),
          data: {
            deploySource: source,
            branch: plan.cicd.branch,
            runner: environment?.runner ?? "github",
            ...(environment?.runnerHost === undefined
              ? {}
              : { runnerHost: environment.runnerHost }),
            build: environment?.build ?? "github",
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_env_remove",
    {
      title: "Remove an environment",
      description:
        "Remove an environment's files: its plan and answers, its infrastructure code and deploy workflow, and what OpsCrew keeps for it on this computer. Refused while it is deployed (the user destroys it first with `npx opscrew destroy --env <name>`) or while another environment is promoted from it. Never prod. Only when the user asks for it: the user confirms by typing the environment's name in a dialog. Refuses when the client cannot show dialogs.",
      inputSchema: { ...projectDirInput, name: NAME_INPUT },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name }, extra: CallExtra) =>
      runTool(deps, "opscrew_env_remove", projectDir, async (call) => {
        requireDialogs(server, `npx opscrew env remove ${name}`);
        const phase = await call.phaseDeps({
          approvalHandler: dialogHandler(server, deps, extra),
          environment: name,
        });
        // It deletes the environment's deploy key, passphrase and secrets: the user types its name.
        // prod is refused by removeEnvironment before anything is asked.
        if (name !== "prod") {
          const approval = await phase.approvals.request({
            kind: "repo-write",
            title: `Remove the ${name} environment's files`,
            details: `This removes the ${name} environment's files: its plan and answers, its infrastructure code and deploy workflow, and what OpsCrew keeps for it on this computer (its deploy key, state passphrase and generated secrets). OpsCrew refuses while it is deployed.`,
            allowDestroy: true,
            confirmPhrase: name,
          });
          if (!approval.approved) {
            throw new OpsCrewError(
              "APPROVAL_REFUSED",
              `The user did not confirm removing the ${name} environment, so nothing was removed.`,
              { hint: "Call opscrew_env_remove again only when the user asks." },
            );
          }
        }
        const removed = await removeEnvironment(phase);
        return {
          text: `Removed the ${name} environment's files${removed.length === 0 ? "; none were left" : `: ${removed.join(", ")}`}.`,
          data: { removed },
        };
      }),
  );

  server.registerTool(
    "opscrew_promote",
    {
      title: "Promote an image to an environment",
      description:
        "Deploy to an environment promoted from another (environment.deploySource) exactly the image its source runs, or with digest its previous image to roll back, without rebuilding. OpsCrew checks the image's build provenance (a push of this repository to the branch the environment that built the image follows), that nothing is waiting for provision in the target, and that its workflow on the default branch is the one its plan generates; then the USER approves the promotion, bound to its hash, in a dialog (the coding agent cannot approve it); then OpsCrew starts the target's deploy workflow with the digest and waits for its run. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        to: NAME_INPUT.describe("The environment to deploy to, for example prod."),
        digest: z
          .string()
          .optional()
          .describe(
            "Only for a rollback the user asked for: the image digest (sha256:…) of the target's previous image, or the one its source runs.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, to, digest }, extra: CallExtra) =>
      runTool(deps, "opscrew_promote", projectDir, async (call) => {
        requireDialogs(
          server,
          `npx opscrew promote --to ${to}${digest === undefined ? "" : ` --digest ${digest}`}`,
        );
        const dialogs = dialogHandler(server, deps, extra);
        // The hash the user's dialog shows, for the result.
        let hash: string | undefined;
        const approvals: ApprovalHandler = {
          request: (request) => {
            if (request.kind === "promote") hash = request.planHash;
            return dialogs.request(request);
          },
        };
        const phase = await call.phaseDeps({ approvalHandler: approvals, environment: to });
        let result: Awaited<ReturnType<typeof promote>>;
        try {
          result = await promote(phase, {
            target: to,
            ...(digest === undefined ? {} : { digest }),
            ...(options.promote === undefined ? {} : { services: options.promote }),
          });
        } catch (error) {
          // Promote's own hint names `--approve <hash>` for a terminal: never offered here.
          if (isUserFacingError(error) && error.code === "APPROVAL_REFUSED") {
            withHint(
              error,
              `The user declined; nothing was deployed. Call opscrew_promote again only when the user asks, or ask them to run \`npx opscrew promote --to ${to}\` in their terminal.`,
            );
          }
          throw error;
        }
        if (result.status === "waiting") {
          // Not a failure or a timeout: GitHub holds the run for the environment's reviewer.
          return {
            text: `The deploy run for ${result.digest} to ${to} (promotion ${hash}) waits in GitHub for a required reviewer: ${result.runUrl}\nThe deploy goes on once the reviewer approves it in GitHub. Once the run succeeded, call opscrew_promote with to ${to} again: it records the image without a new deploy.`,
            data: { ...result, promotionHash: hash, approvals: dialogs.decisions },
          };
        }
        return {
          text: `Deployed ${result.digest} to ${to} (promotion ${hash}): ${result.runUrl}\nNext: call opscrew_verify with environment ${to}.`,
          data: { ...result, promotionHash: hash, approvals: dialogs.decisions },
        };
      }),
  );
}
