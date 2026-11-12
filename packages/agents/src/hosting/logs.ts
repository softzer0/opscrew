/**
 * `opscrew logs` for an app on a hosting account with a panel (027 plan 6): the agent's last lines
 * (`state/agent.log`, which it keeps to 1,000), read through the panel's files and redacted. The
 * account runs no container whose lines OpsCrew could read, and keeps the web server's logs in the
 * panel.
 */
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { type LogLine, type LogRead, logRead } from "../logs/lines";
import { type HostingAccountServices, reachHostingAccount, requireFiles } from "./status";

/** The time the agent writes at the start of each line (`say`). */
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (.*)$/;

/**
 * The last `tail` lines of the agent's log on the account, each redacted; a line without the
 * agent's time (a tool's own output) takes the time of the line before it. `service`, `since`,
 * `follow` and `failed` don't apply there and are refused before anything is read. Audited.
 * @throws OpsCrewError `INVALID_INPUT` for a flag that doesn't apply.
 */
export async function hostingLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { tail: number; service?: string; since?: string; follow?: boolean; failed?: boolean },
  services: HostingAccountServices = {},
): Promise<LogRead> {
  const given = [
    ...(options.service !== undefined && options.service !== "app" ? ["--service"] : []),
    ...(options.since !== undefined ? ["--since"] : []),
    ...(options.follow === true ? ["--follow"] : []),
    ...(options.failed === true ? ["--failed"] : []),
  ];
  if (given.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `On a hosting account \`opscrew logs\` shows the agent's log, which names each release it deployed, refused or switched back from and why: ${given.join(", ")} ${given.length === 1 ? "doesn't" : "don't"} apply there.`,
      {
        hint: "Run `opscrew logs` without them (add --tail <lines> for more or fewer). The web server's own logs are in the panel.",
      },
    );
  }
  const reach = await reachHostingAccount(deps, plan, services);
  const files = requireFiles(reach, "read the agent's log");
  const path = `${reach.folder}/state/agent.log`;
  deps.reporter.step("Reading the agent's log on the hosting account (read-only)");
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "read the agent's log (read-only)",
    target: "hosting account",
    decision: "allow",
  });
  const text = (await files.readFile(path)) ?? "";
  const lines: LogLine[] = [];
  let time = "";
  for (const raw of text.split(/\r?\n/).filter((line) => line !== "")) {
    const match = TIME.exec(raw);
    if (match !== null) time = match[1] as string;
    lines.push({
      time,
      service: "agent",
      stream: "stdout",
      text: deps.redactor.redact(match === null ? raw : (match[2] as string)),
    });
  }
  const past = lines.slice(-options.tail);
  const oldest = past.find((line) => line.time !== "")?.time;
  const first =
    past.length === 0
      ? `The agent on the hosting account has logged nothing yet (~/${path}).`
      : `The agent's log on the hosting account (~/${path}, its last 1,000 lines kept)${oldest === undefined ? "" : `; the oldest line here is from ${formatUtc(oldest)}`}.`;
  return logRead(deps.redactor.redact(first), past);
}
