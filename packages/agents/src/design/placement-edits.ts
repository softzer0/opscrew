import { isRecord, OpsCrewError, readTextIfExists, stripBom } from "@opscrew/core";
import {
  CloudProviderSchema,
  type DeployPlan,
  DeployPlanSchema,
  type Move,
  MoveSchema,
  type Network,
  NetworkSchema,
  parseArtifact,
  ServerNameSchema,
} from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";

/**
 * An extra server as the user wrote it in `opscrew/plan.yaml`. Design fills in what its target
 * leaves out: a cloud server's provider and location (the app server's) and its size (from its
 * services), a server the user owns' architecture (from inspection).
 */
const EditedServerSchema = z.strictObject({
  name: ServerNameSchema,
  target: z
    .union([
      z.strictObject({
        provider: z.literal("own"),
        mode: z.literal("vps-compose").optional(),
        arch: z.enum(["amd64", "arm64"]).optional(),
      }),
      z.strictObject({
        provider: CloudProviderSchema.optional(),
        mode: z.literal("vps-compose").optional(),
        location: z.string().min(1).optional(),
        serverType: z.string().min(1).optional(),
        image: z.string().min(1).optional(),
        backups: z.boolean().optional(),
      }),
    ])
    .optional(),
});

/** An extra server as the user wrote it ({@link EditedServerSchema}). */
export type EditedServer = z.output<typeof EditedServerSchema>;

const EditsSchema = z.strictObject({
  servers: z.array(EditedServerSchema).optional(),
  network: NetworkSchema.optional(),
  move: MoveSchema.optional(),
});

/** What `opscrew/plan.yaml` says about where the services run, read before its rules across them. */
export interface PlacementEdits {
  /** The extra servers, in plan order. */
  servers: EditedServer[];
  /** The server each service names (`services[].server`), by the service's name. */
  placed: Record<string, string>;
  network?: Network;
  move?: Move;
}

/** {@link readPlanWithEdits}'s result. */
export interface PlanWithEdits {
  /** The plan without its placement (`servers`, `services[].server`, `network`, `move`). */
  plan: DeployPlan;
  /** The plan as the file holds it, when the file is valid as a whole. */
  whole?: DeployPlan;
  edits: PlacementEdits;
}

/** True when the user placed something: an extra server, a service on one, a network or a move. */
export function hasPlacement(edits: PlacementEdits): boolean {
  return (
    edits.servers.length > 0 ||
    Object.keys(edits.placed).length > 0 ||
    edits.network !== undefined ||
    edits.move !== undefined
  );
}

/**
 * Reads `opscrew/plan.yaml` for design: the plan without its placement, validated, and the
 * placement as the user wrote it. The user adds a server by hand, with or without its size, and
 * names it on a service; design then completes it and adds the network, which the plan's own rules
 * require, so those fields are read on their own before the rest is validated. `undefined` when
 * the file does not exist.
 * @throws ArtifactError `ARTIFACT_INVALID` when the rest of the plan is not valid (with every
 * problem of the file).
 * @throws OpsCrewError `INVALID_INPUT` when a placement field is not, naming it.
 */
export async function readPlanWithEdits(file: string): Promise<PlanWithEdits | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let whole: DeployPlan | undefined;
  let failure: unknown;
  try {
    whole = parseArtifact("plan", text, file);
  } catch (error) {
    failure = error;
  }
  let raw: unknown = whole;
  if (raw === undefined) {
    try {
      raw = parse(stripBom(text).replace(/\r\n?/g, "\n"));
    } catch {
      throw failure;
    }
  }
  if (!isRecord(raw)) throw failure;
  const { servers, network, move, ...rest } = raw;
  const placed: Record<string, string> = {};
  const issues: { path: string; message: string }[] = [];
  const services = Array.isArray(rest.services)
    ? rest.services.map((service: unknown, i) => {
        if (!isRecord(service) || service.server === undefined) return service;
        const { server, ...others } = service;
        const name = ServerNameSchema.safeParse(server);
        if (!name.success) {
          issues.push({
            path: `services.${i}.server`,
            message: name.error.issues[0]?.message ?? "",
          });
        } else if (typeof others.name === "string") {
          placed[others.name] = name.data;
        }
        return others;
      })
    : rest.services;
  const plan = DeployPlanSchema.safeParse({ ...rest, services });
  if (!plan.success) throw failure;
  const edits = EditsSchema.safeParse({ servers, network, move });
  for (const issue of edits.error?.issues ?? []) {
    issues.push({ path: issue.path.map(String).join("."), message: issue.message });
  }
  if (!edits.success || issues.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `opscrew/plan.yaml places services in a way OpsCrew cannot read: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}. Nothing was written.`,
      { hint: "Fix the field shown above in opscrew/plan.yaml, then run `opscrew design` again." },
    );
  }
  return {
    plan: plan.data,
    ...(whole === undefined ? {} : { whole }),
    edits: {
      servers: edits.data.servers ?? [],
      placed,
      ...(edits.data.network === undefined ? {} : { network: edits.data.network }),
      ...(edits.data.move === undefined ? {} : { move: edits.data.move }),
    },
  };
}
