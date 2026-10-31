import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { placementEstimate, resolveCatalog } from "@opscrew/agents";
import type { ComputeCatalog } from "@opscrew/contracts";
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/** Test-only collaborators for `opscrew_placement_estimate` (production reads the provider's prices). */
export interface PlacementToolOptions {
  /** The cloud provider's catalogue (production: design's, live when its token verifies, else its dated price list). */
  catalog?: ComputeCatalog;
}

/**
 * `opscrew_placement_estimate` (feature 018, FR-1821): what one of the app's services would cost
 * on a server of its own (the server's type, size and monthly price, and the app's new monthly
 * total) and how much slower each query from the app gets, from design's estimate. Reads the plan
 * and the provider's prices; writes nothing and makes no key.
 */
export function registerPlacementTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: PlacementToolOptions = {},
): void {
  server.registerTool(
    "opscrew_placement_estimate",
    {
      title: "Estimate a service on a server of its own",
      description:
        "Estimate what giving one of the app's services (a database, a cache, a broker) a server of its own would cost and how much slower each query from the app would get: the new server's type, vCPUs, memory and monthly price, the app's monthly total with it, and the estimated delay of each query (with what it adds to a page making 20 queries in a row, and a warning when it is large). For a server the user owns there is no price, and the delay is measured by `opscrew status` once the servers are linked. Reads opscrew/plan.yaml and the provider's prices; writes nothing. To place the service, the user sets `server` on it and adds the server under `servers` in opscrew/plan.yaml, then calls opscrew_select_design (or runs `npx opscrew design`).",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        service: z.string().min(1).describe("The service's name in opscrew/plan.yaml, e.g. db."),
        provider: z
          .enum(["hetzner", "digitalocean", "own"])
          .describe(
            "Where the server would be: a new Hetzner or DigitalOcean server, or the user's own.",
          ),
        location: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A new cloud server's location (e.g. fsn1, nbg1, hel1 at Hetzner; fra1, ams3 at DigitalOcean). Required for hetzner and digitalocean.",
          ),
        serverType: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A new cloud server's type (e.g. cx23). Default: the smallest that holds the service.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment, service, provider, location, serverType }) =>
      runTool(deps, "opscrew_placement_estimate", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        if (provider !== "own" && location === undefined) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            `A new ${provider === "hetzner" ? "Hetzner" : "DigitalOcean"} server needs its location for the estimate.`,
            {
              hint: "Pass location, for example the app's own server's location for the shortest hop.",
            },
          );
        }
        // Design's catalogue: live when the token verifies, else the dated price list, which it says.
        let catalog = options.catalog;
        if (catalog === undefined && provider !== "own") {
          const found = await resolveCatalog(phase, provider, location as string);
          if (found.warning !== undefined) phase.reporter.warn(found.warning);
          catalog = found.catalog;
        }
        const estimate = await placementEstimate({
          plan,
          service,
          server:
            provider === "own"
              ? { provider }
              : {
                  provider,
                  location: location as string,
                  ...(serverType === undefined ? {} : { serverType }),
                },
          ...(catalog === undefined ? {} : { catalog }),
        });
        const lines = [
          estimate.server === undefined
            ? `${service} on a server of yours: no server price (you already pay for it).`
            : `${service} on a new ${estimate.server.serverType} (${estimate.server.vcpus} vCPU, ${estimate.server.memoryGb} GB memory): ${formatMoney(estimate.server.cost.monthly)} per month${estimate.server.cost.source === "static" ? " (from the provider's published price list, an estimate)" : ""}.`,
          `The app's monthly total with it: ${formatMoney(estimate.total)}.`,
          estimate.delay.text,
          ...(estimate.delay.warning === undefined ? [] : [estimate.delay.warning]),
        ];
        return { text: lines.join("\n"), data: { service, provider, ...estimate } };
      }),
  );
}
