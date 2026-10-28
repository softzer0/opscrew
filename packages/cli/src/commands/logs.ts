import { type LogLine, readLogs } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isServerlessProvider, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { endProcess, stopSignal } from "../ui/stop";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface LogsFlags extends AppEnvFlags {
  follow?: boolean;
  service?: string;
  since?: string;
  tail?: string;
  hostKey?: string;
}

/** One line as `logs` prints it: `<time> <service> <text>`. */
function lineText(line: LogLine): string {
  return `${line.time} ${line.service} ${line.text}`;
}

/**
 * Refuses `--follow` and `--service` on a site whose host keeps no request logs (GitHub Pages, a
 * static site on Cloudflare): `logs` shows its last deploy runs, which have neither.
 */
function refuseOnSite(plan: DeployPlan, flags: LogsFlags, flag: string): void {
  const { target } = plan;
  if (!isServerlessProvider(target.provider)) return;
  if (target.provider === "cloudflare-workers" && target.render === "ssr") return;
  const option =
    flags.follow === true ? "--follow" : flags.service !== undefined ? "--service" : "";
  if (option === "") return;
  const host = target.provider === "github-pages" ? "GitHub Pages" : "Cloudflare";
  const why =
    option === "--follow"
      ? "so there are no new lines to follow"
      : "so it has no parts whose lines --service could choose";
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${host} keeps no request logs for this site: its files are served without running any code, ${why}.`,
    { hint: `Run \`opscrew logs${flag}\` without ${option} to see the site's last deploy runs.` },
  );
}

/**
 * `opscrew logs` (FR-1701): the app's latest lines on its target, newest last, each with its time
 * and part, read-only and masked (FR-1702, FR-1703). `--follow` then shows new lines until Ctrl-C,
 * and the process ends once the follow has stopped and the output has flushed. On GitHub Pages and
 * a static site on Cloudflare, which keep no request logs, it shows the last deploy runs and
 * refuses `--follow` and `--service`.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("logs")
    .description("Show the app's latest log lines, or follow new ones (read-only; secrets masked)")
    .option("--follow", "Keep showing new lines as they come, until Ctrl-C")
    .option(
      "--service <name>",
      "The part whose lines to show: app (the default), a worker, a cron job or a service by its name, cron, or edge (the proxy in front of the app)",
    )
    .option("--since <duration>", "Only lines of the last 30s, 15m, 2h or 3d")
    .option("--tail <lines>", "How many of the latest lines to show (default 200)");
  addEnvOption(command);
  addHostKeyOption(command).action(async (flags: LogsFlags) => {
    checkApproveFlags("logs", flags);
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "logs");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    refuseOnSite(plan, flags, flag);
    const follow = flags.follow === true;
    const stop = follow ? stopSignal(ctx) : undefined;
    const services = servicesOf(ctx).logs;
    const hostKey = flags.hostKey?.trim();
    try {
      const read = await readLogs(deps, plan, {
        ...(flags.service === undefined ? {} : { service: flags.service.trim() }),
        ...(flags.since === undefined ? {} : { since: flags.since.trim() }),
        // readLogs refuses anything but a positive whole number, with an example.
        ...(flags.tail === undefined ? {} : { tail: Number(flags.tail) }),
        ...(follow ? { follow: true } : {}),
        ...(stop === undefined ? {} : { signal: stop.signal }),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(services === undefined ? {} : { services }),
      });
      ctx.stdout(`${read.first}\n`);
      for await (const line of read) ctx.stdout(`${lineText(line)}\n`);
    } finally {
      stop?.release();
      if (follow) endProcess(ctx);
    }
  });
}
