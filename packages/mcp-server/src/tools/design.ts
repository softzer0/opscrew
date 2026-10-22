import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type DesignPreview,
  type DesignResult,
  inspectOwnServerForDesign,
  isUnpriced,
  type OwnServerDesignInput,
  type OwnServerServices,
  type PhaseDeps,
  previewDesignOptions,
  priceLabel,
  providerProfile,
  readEnvironmentRequirements,
  readOwnServer,
  requestedProvider,
  runAnalyze,
  runDesign,
} from "@opscrew/agents";
import type { ApprovalHandler } from "@opscrew/contracts";
import { formatMoney, OpsCrewError, taxLabel, toPosixRelative } from "@opscrew/core";
import { detectProject } from "@opscrew/detect";
import { type DesignOption, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { CollectingReporter, type ResolvedMcpDeps } from "../deps";
import {
  type CallExtra,
  clientSupportsElicitation,
  dialogHandler,
  hostKeyNeedsTerminal,
} from "./elicitation";
import {
  environmentInput,
  IDEMPOTENT_WRITE,
  isMissingArtifact,
  projectDirInput,
  runTool,
  toolEnvironment,
  withHint,
} from "./shared";

const REQUIREMENTS_HINT =
  "Call opscrew_interview_questions, ask the user the questions, then call opscrew_save_requirements.";

/** Fails with a tool-oriented hint unless `opscrew/requirements.yaml` exists and is valid. */
async function requireRequirements(phase: PhaseDeps): Promise<void> {
  const file = toPosixRelative(phase.paths.root, phase.paths.files.requirements);
  try {
    await readEnvironmentRequirements(phase.paths);
  } catch (error) {
    if (isMissingArtifact(error)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The deployment requirements are not saved yet (${file} does not exist).`,
        { hint: REQUIREMENTS_HINT },
      );
    }
    withHint(error, `Fix ${file}, or save the answers again with opscrew_save_requirements.`);
  }
}

/** Fails with a tool-oriented hint when `opscrew/architecture.json` exists but is invalid. */
async function checkArchitecture(phase: PhaseDeps): Promise<boolean> {
  try {
    await readArtifact("architecture", phase.paths.files.architecture);
    return true;
  } catch (error) {
    if (isMissingArtifact(error)) return false;
    const file = toPosixRelative(phase.paths.root, phase.paths.files.architecture);
    return withHint(
      error,
      `Fix ${file}, or delete it so OpsCrew detects the project again, then retry.`,
    );
  }
}

/** Test-only collaborators for the design tools (production connects over SSH). */
export interface DesignToolOptions {
  /** A server the user owns: its admin shell, the host adapter's inspection and home directory. */
  own?: OwnServerServices;
}

/**
 * The approval handler of a design tool call: a dialog for the user (MCP elicitation) when the
 * client can show one. Design asks only one thing: trusting the SSH host key of the user's own
 * server on the first connection. The model never approves it.
 */
function designApprovals(
  server: McpServer,
  deps: ResolvedMcpDeps,
  extra: CallExtra,
): { approvalHandler?: ApprovalHandler } {
  if (!clientSupportsElicitation(server)) return {};
  return { approvalHandler: dialogHandler(server, deps, extra) };
}

/**
 * A server the user owns: connects with the login the interview recorded and inspects the server
 * read-only, so design can check that it fits the app. A host key that was never confirmed is
 * shown to the user in a dialog (MCP elicitation); a client without dialogs gets the terminal
 * command instead. `undefined` for the other providers.
 */
async function ownServerInput(
  server: McpServer,
  phase: PhaseDeps,
  options: DesignToolOptions,
): Promise<OwnServerDesignInput | undefined> {
  const requirements = await readEnvironmentRequirements(phase.paths);
  if (requirements.provider !== "own") return undefined;
  const recorded = await readOwnServer(phase.paths).catch(() => undefined);
  const pinned = recorded?.hostKey !== undefined;
  if (recorded !== undefined && !pinned && !clientSupportsElicitation(server)) {
    throw hostKeyNeedsTerminal("design", "Nothing was changed.");
  }
  // Only the first connection asks (a dialog for the user); a pinned key is checked silently.
  return inspectOwnServerForDesign(
    { ...phase, interactive: !pinned },
    options.own === undefined ? {} : { services: options.own },
  );
}

/**
 * Prices the options without writing anything to the project (`previewDesignOptions`). Without a
 * saved `architecture.json`, the facts come from a fresh deterministic detection.
 */
async function previewDesign(
  deps: ResolvedMcpDeps,
  phase: PhaseDeps,
  hasArchitecture: boolean,
  ownServer: OwnServerDesignInput | undefined,
): Promise<DesignPreview> {
  const quiet: PhaseDeps = { ...phase, reporter: new CollectingReporter(deps.redactor.redact) };
  const facts = hasArchitecture ? undefined : await detectProject(phase.paths.root);
  return previewDesignOptions(quiet, {
    ...(facts ? { facts } : {}),
    ...(ownServer === undefined ? {} : { ownServer }),
  });
}

/** The option's cost in words: never a price for the user's own server or their Portainer. */
function costText(option: DesignOption): string {
  if (option.target.provider === "portainer") {
    return "no server price (the user already runs this Portainer)";
  }
  return option.target.provider === "own"
    ? "no server price (the user already pays for this server)"
    : `${formatMoney(option.cost.monthly)}/month, ${priceLabel(option.cost)}`;
}

/**
 * What runs next to the app, one line each (workers, cron, services and storage, with their
 * licences and the edits kept from plan.yaml), for the preview; nothing for an app alone.
 */
function componentText(preview: Pick<DesignPreview, "lines">): string[] {
  if (preview.lines.length === 0) return [];
  return ["What runs next to the app:", ...preview.lines.map((line) => `- ${line}`), ""];
}

/** Plain-text block for one option. */
function renderOption(option: DesignOption): string {
  const unpriced = isUnpriced(option);
  const marks = [
    ...(unpriced ? [] : [option.fitsBudget ? "fits the budget" : "over budget"]),
    ...(option.recommended ? ["RECOMMENDED"] : []),
  ];
  const t = option.target;
  return [
    `${option.title} (id: ${option.id}) — ${costText(option)}${marks.length > 0 ? `; ${marks.join(", ")}` : ""}`,
    `  ${option.summary}`,
    // The user's Portainer: OpsCrew does not size the host, so it shows no sizes at all.
    ...(t.provider === "portainer"
      ? []
      : [
          `  Server: ${t.serverType} in ${t.location}, ${t.vcpus} vCPU (${t.cpuType}), ${t.memoryGb} GB RAM, ${t.diskGb} GB ${t.provider === "own" ? "free disk" : "disk"}`,
        ]),
    ...(unpriced
      ? []
      : [
          `  Cost: ${option.cost.breakdown.map((b) => `${b.item} ${formatMoney(b.monthly)}`).join("; ")}`,
        ]),
    ...option.tradeoffs.map((tradeoff) => `  - ${tradeoff}`),
  ].join("\n");
}

/**
 * Where the options' prices come from, for the heading: live from the provider's API; or, when its
 * token is set but some rate is not in the API (DigitalOcean's backup percentage), live where the
 * API returns them with the rest labelled by its published date (each option names the exact
 * label); or the dated price list when no token is set.
 */
function priceSourceText(
  deps: Pick<ResolvedMcpDeps, "env">,
  provider: Parameters<typeof providerProfile>[0],
  priceSource: DesignPreview["priceSource"],
): string {
  const profile = providerProfile(provider);
  if (priceSource === "live") return `prices live from ${profile.displayName}`;
  const tokenSet = profile.tokenVars.some((name) => (deps.env[name] ?? "").trim() !== "");
  return tokenSet
    ? `prices live from ${profile.displayName}'s API where it returns them; rates it does not return are labelled with their published date on each option`
    : "prices from a dated price list; estimates";
}

/** A plan for the result data without its `cost` (the user's own server has no price). */
function withoutCost(plan: DesignResult["plan"]): Record<string, unknown> {
  const { cost: _cost, ...rest } = plan;
  return rest;
}

/**
 * An option for the result data: the user's own server carries no cost and no budget check; the
 * user's Portainer carries neither, nor the placeholder sizes of its target.
 */
function optionData(option: DesignOption): Record<string, unknown> {
  if (!isUnpriced(option)) return option;
  const { cost: _cost, fitsBudget: _fits, ...rest } = option;
  if (option.target.provider === "portainer") {
    const {
      vcpus: _vcpus,
      memoryGb: _memory,
      diskGb: _disk,
      cpuType: _cpu,
      ...target
    } = option.target;
    return { ...rest, target, price: "none: the user already runs this Portainer" };
  }
  return { ...rest, price: "none: the user already pays for this server" };
}

/** The heading of the one unpriced option: the user's own server or their Portainer. */
const UNPRICED_HEADING = {
  own: "Deployment on the user's own server (no server price: they already pay for it; OpsCrew cannot turn on backups there, so backups are the user's responsibility):",
  portainer:
    "Deployment in the user's existing Portainer (no server price: they already run it; OpsCrew does not change the host, and backups of the app's data are the user's responsibility):",
} as const;

/**
 * `opscrew_design_options` (read-only preview of 2–3 priced options on the chosen provider, or the
 * user's own server without a price) and `opscrew_select_design` (writes `opscrew/plan.yaml` for
 * the chosen option). On a server the user owns both connect over SSH and inspect it read-only
 * first; a host key seen for the first time is confirmed by the user in a dialog. `options` is for
 * tests only.
 */
export function registerDesignTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: DesignToolOptions = {},
): void {
  server.registerTool(
    "opscrew_design_options",
    {
      title: "Deployment options",
      description:
        "Offer 2–3 concrete deployment options on the cloud provider chosen in the interview (Hetzner Cloud or DigitalOcean) for this app and the saved requirements, each with monthly cost and breakdown, whether it fits the budget and its trade-offs; exactly one is recommended. Prices read from the provider's API (with HCLOUD_TOKEN or DIGITALOCEAN_TOKEN set) are live; rates the API does not return (DigitalOcean's backup percentage) are labelled with their published date; without a token the prices come from a dated price list labelled as an estimate. For a server the user already has, it connects over SSH, inspects the server read-only (the first time the user confirms its SSH host key in a dialog) and offers that server as the one option, without a price, warning when it is smaller than the app needs. For a Portainer the user already runs it offers one option, the app's stacks in the environment the user picked, without a price or sizes (OpsCrew does not size or change the host). Needs opscrew_save_requirements first. Writes nothing; call opscrew_select_design with the option the user chooses.",
      inputSchema: { ...projectDirInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, environment }, extra: CallExtra) =>
      runTool(deps, "opscrew_design_options", projectDir, async (call) => {
        const { name } = await toolEnvironment(call.projectDir, environment);
        const phase = await call.phaseDeps({
          ...designApprovals(server, deps, extra),
          environment: name,
        });
        await requireRequirements(phase);
        const hasArchitecture = await checkArchitecture(phase);
        const ownServer = await ownServerInput(server, phase, options);
        const result = await previewDesign(deps, phase, hasArchitecture, ownServer);
        for (const warning of result.warnings) call.reporter.warn(warning);
        const recommended = result.options.find((o) => o.recommended);
        const requirements = await readEnvironmentRequirements(phase.paths);
        const unpriced =
          requirements.provider === "own" || requirements.provider === "portainer"
            ? requirements.provider
            : undefined;
        if (unpriced !== undefined) {
          const text = [
            UNPRICED_HEADING[unpriced],
            "",
            ...result.options.map(renderOption),
            "",
            ...componentText(result),
            `After the user agrees, call opscrew_select_design with the option id (${recommended?.id ?? result.options[0]?.id}).`,
          ].join("\n");
          return {
            text,
            data: {
              options: result.options.map(optionData),
              recommendedId: recommended?.id,
              ...(unpriced === "own" ? { ownServer: true } : { portainer: true }),
              components: result.components,
              warnings: result.warnings,
            },
          };
        }
        const fitting = result.options.some((o) => o.fitsBudget);
        const provider = requestedProvider(requirements);
        const providerName = providerProfile(provider).displayName;
        const first = result.options[0]?.cost;
        const tax = first ? `, ${taxLabel(first.monthly.currency, first.pricesIncludeVat)}` : "";
        const prices = priceSourceText(deps, provider, result.priceSource);
        const text = [
          `Deployment options on ${providerName} (budget ${formatMoney(requirements.budgetMonthly)}/month, ${prices}${tax}):`,
          "",
          ...result.options.map(renderOption),
          "",
          ...componentText(result),
          ...(fitting ? [] : ["None of the options fits the budget."]),
          `OpsCrew recommends ${recommended?.id ?? "the first option"}. After the user chooses, call opscrew_select_design with the option id.`,
        ].join("\n");
        return {
          text,
          data: {
            options: result.options,
            recommendedId: recommended?.id,
            priceSource: result.priceSource,
            budget: requirements.budgetMonthly,
            fitsBudget: fitting,
            components: result.components,
            warnings: result.warnings,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_select_design",
    {
      title: "Choose a deployment option",
      description:
        "Write opscrew/plan.yaml for the deployment option the user chose (an id from opscrew_design_options), including the code changes the app needs before it can be deployed. Returns the image builder, the deploy strategy and the supply-chain settings (image signing, deploy tags, image retention), each with its reason; settings the user changed in opscrew/plan.yaml (app.build.builder with app.build.chosen: user, deploy.strategy, supplyChain.sign, cicd.deployTags, cicd.imageRetention) are kept. Also writes opscrew/architecture.json from deterministic detection when it does not exist yet. Creates no infrastructure.",
      inputSchema: {
        ...projectDirInput,
        ...environmentInput,
        optionId: z
          .string()
          .min(1)
          .describe("Id of the chosen option, as returned by opscrew_design_options."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, environment, optionId }, extra: CallExtra) =>
      runTool(deps, "opscrew_select_design", projectDir, async (call) => {
        const { name } = await toolEnvironment(call.projectDir, environment);
        const phase = await call.phaseDeps({
          ...designApprovals(server, deps, extra),
          environment: name,
        });
        await requireRequirements(phase);
        const hasArchitecture = await checkArchitecture(phase);
        const notes: string[] = [];
        if (!hasArchitecture) {
          await runAnalyze(phase, { ai: false });
          notes.push(
            `Wrote ${toPosixRelative(phase.paths.root, phase.paths.files.architecture)} from deterministic detection.`,
          );
        }
        const ownServer = await ownServerInput(server, phase, options);
        let result: DesignResult;
        try {
          result = await runDesign(phase, {
            optionId,
            ...(ownServer === undefined ? {} : { ownServer }),
          });
        } catch (error) {
          if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") {
            withHint(
              error,
              `${error.hint ?? ""} Call opscrew_design_options to see the current option ids.`.trim(),
            );
          }
          throw error;
        }
        const { chosen, plan } = result;
        const planFile = toPosixRelative(phase.paths.root, phase.paths.files.plan);
        const pending = plan.codeChanges.filter((change) => change.status === "pending");
        const text = [
          ...notes,
          `Saved ${planFile}: ${chosen.title} (${chosen.id}), ${costText(chosen)}.`,
          "",
          // The image builder, deploy strategy and supply-chain settings, as design reported them.
          ...result.lines,
          "",
          plan.codeChanges.length === 0
            ? "The app needs no code changes."
            : `Code changes the app needs (${pending.length} pending):`,
          ...plan.codeChanges.map(
            (change) => `- [${change.status}] ${change.kind} (${change.path}): ${change.reason}`,
          ),
          "",
          "Next: apply the pending code changes (opscrew-adapt skill) and let the user review and commit them. Nothing has been created in the cloud.",
        ].join("\n");
        // A server the user owns or their Portainer has no price: its plan is returned without `cost`.
        const unpriced = isUnpriced(chosen);
        return {
          text,
          data: {
            chosen: optionData(chosen),
            planFile,
            plan: unpriced ? withoutCost(plan) : plan,
            codeChanges: plan.codeChanges,
            ...(unpriced ? {} : { priceSource: result.priceSource }),
            warnings: result.warnings,
          },
        };
      }),
  );
}
