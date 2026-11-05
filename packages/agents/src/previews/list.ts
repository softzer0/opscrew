/**
 * `opscrew preview list` (FR-2219, spec.md US6): the previews on the preview server, read-only,
 * from the preview command's `list` (contracts/opscrew-preview.md), each line checked with zod.
 */
import type { RemoteExec } from "@opscrew/contracts";
import { escapeRegExp, plural } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  PREVIEW_NUMBER,
  type PreviewServices,
  PreviewStateSchema,
  previewCommandFailed,
  previewServerTarget,
  previewShell,
  requirePreviews,
  runPreviewCommand,
} from "./remote";

/**
 * One preview on the server. A preview half made or half removed lacks some fields (`-` in the
 * command's line), and is `failed` when its record is missing.
 */
export interface Preview {
  /** Its pull request's number. */
  number: number;
  state: z.infer<typeof PreviewStateSchema>;
  /** The pull request's head commit it runs. */
  commit?: string;
  /** When it was created and last updated (ISO). */
  createdAt?: string;
  updatedAt?: string;
  /** Its image's digest (`sha256:…`). */
  digest?: string;
  /** `https://pr-<n>-<random>.<zone>`, as the server keeps it; absent while it has none. */
  address?: string;
}

/** What `list` read: each preview, how many run and how many may. */
export interface PreviewList {
  previews: Preview[];
  count: number;
  cap: number;
}

/** A field of `list`'s line, or `-` (undefined) when the preview lacks it. */
const orDash = <T extends z.ZodType<string | undefined>>(schema: T) =>
  z.union([z.literal("-").transform(() => undefined), schema]);

const Seconds = z
  .string()
  .regex(/^\d{1,12}$/)
  .transform((text) => new Date(Number(text) * 1000).toISOString());

/**
 * `<n> <state> <commit> <created> <updated> <digest> <address>`, the address a name of the
 * previews' zone `zone` (`pr-<n>-<random>.<zone>`, the number checked against the line's).
 */
function listLineSchema(zone: string) {
  const host = new RegExp(`^pr-([1-9][0-9]{0,5})-[a-z0-9]{10}\\.${escapeRegExp(zone)}$`);
  return z
    .tuple([
      z.string().regex(PREVIEW_NUMBER).transform(Number),
      PreviewStateSchema,
      orDash(z.string().regex(/^[0-9a-f]{40}$/)),
      orDash(Seconds),
      orDash(Seconds),
      orDash(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
      orDash(z.string().regex(host)),
    ])
    .refine(
      ([n, , , , , , address]) => address === undefined || host.exec(address)?.[1] === `${n}`,
    );
}

/** `list`'s last line's detail: `<count>/<cap>`. */
const CountSchema = z
  .string()
  .regex(/^\d+\/\d+$/)
  .transform((text) => text.split("/").map(Number) as [number, number]);

/**
 * The previews on the preview server (read-only), over `remote` or the deploy user's shell with
 * the environment's deploy key. Audited as `remote-exec` without the address.
 * @throws OpsCrewError `INVALID_INPUT` for an environment without previews, `COMMAND_FAILED`
 * when the server does not answer or answers outside the contract.
 */
export async function listPreviews(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { services?: PreviewServices; remote?: RemoteExec } = {},
): Promise<PreviewList> {
  const previews = requirePreviews(plan, deps.paths.environment, "opscrew preview list");
  const remote = options.remote ?? (await previewShell(deps, plan, options.services));
  deps.reporter.step("Reading the previews on the preview server (read-only)");
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "list the previews (read-only)",
    target: previewServerTarget(plan),
    decision: "allow",
  });
  const answer = await runPreviewCommand(deps, plan, remote, "list", 60_000);
  const count = CountSchema.safeParse(answer.reply.detail);
  if (answer.exitCode !== 0 || answer.reply.state !== "listed" || !count.success) {
    throw await previewCommandFailed(deps, answer, "list the previews");
  }
  const found: Preview[] = [];
  const lineSchema = listLineSchema(previews.domain);
  for (const line of answer.lines) {
    const parsed = lineSchema.safeParse(line.trim().split(" "));
    if (!parsed.success)
      throw await previewCommandFailed(deps, answer, "read the list of previews");
    const [number, state, commit, createdAt, updatedAt, digest, host] = parsed.data;
    found.push({
      number,
      state,
      ...(commit === undefined ? {} : { commit }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(digest === undefined ? {} : { digest }),
      ...(host === undefined ? {} : { address: `https://${host}` }),
    });
  }
  const [listed, cap] = count.data;
  return {
    previews: found,
    count: listed,
    cap,
  };
}

/** How long ago `iso` was: `3 days`, `5 hours`, `12 minutes`, `less than a minute`. */
function age(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes >= 2 * 1440) return plural(Math.floor(minutes / 1440), "day");
  if (minutes >= 2 * 60) return plural(Math.floor(minutes / 60), "hour");
  if (minutes >= 1) return plural(minutes, "minute");
  return "less than a minute";
}

/** What each state means, in a preview's line. */
const STATE_WORDS: Record<Preview["state"], string> = {
  running: "running",
  "seed-failed": "running, its seed failed",
  failed: "failed",
};

/**
 * The list in plain lines: the count against the cap, then one line per preview with what it has
 * of its commit and times.
 */
export function previewListLines(list: PreviewList, now: Date): string[] {
  return [
    `Previews: ${list.count} of at most ${list.cap}.`,
    ...list.previews.map((p) =>
      [
        `  pr-${p.number}: ${p.address ?? "no address yet"}`,
        STATE_WORDS[p.state],
        ...(p.commit === undefined ? [] : [`commit ${p.commit.slice(0, 7)}`]),
        ...(p.createdAt === undefined ? [] : [`created ${age(p.createdAt, now)} ago`]),
        ...(p.updatedAt === undefined ? [] : [`updated ${age(p.updatedAt, now)} ago`]),
      ].join(", "),
    ),
  ];
}
