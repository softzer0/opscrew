import { formatMoney, taxLabel } from "@opscrew/core";
import {
  type CloudDeployTarget,
  type DeployPlan,
  ghcrImageFor,
  serviceOf,
} from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { cloudTarget, PROVIDER_TEXT, type ProviderText } from "../providers";
import { siteHosts } from "../runtime";
import { artefactsFolder } from "../runtime-dir";
import type { RenderedFile } from "../types";
import { runbookFilePath } from "../workflow/shared";
import {
  componentsSection,
  dataCell,
  edgeSection,
  objectStorageSection,
  recoverySection,
} from "./components";
import { renderOwnRunbook } from "./own";
import {
  cell,
  DATABASE_DUMP,
  deployAgain,
  deployKeyStored,
  deployRows,
  deploySections,
  driftFiles,
  externalDatabaseCell,
  opscrew,
  type RunbookContext,
  runbookFolders,
  runbookHead,
  securityHead,
  serverCommands,
  settingsSection,
  troubleshooting,
} from "./shared";

export { componentsSection, objectStorageSection, recoverySection } from "./components";
export { renderLocalRunbook } from "./localhost";
export {
  cell,
  deployRows,
  externalDatabaseCell,
  type RunbookContext,
  runbookHead,
} from "./shared";

const PENDING = "_(set by `opscrew provision`)_";

function money(plan: DeployPlan, provider: ProviderText): string {
  const { monthly } = plan.cost;
  const tax = taxLabel(monthly.currency, plan.cost.pricesIncludeVat);
  const source =
    plan.cost.source === "static"
      ? `, estimate from ${provider.name}'s price list of ${plan.cost.asOf.slice(0, 10)}`
      : "";
  return `${formatMoney(monthly)} per month (${tax}${source})`;
}

/**
 * `opscrew/RUNBOOK.md`: how this deployment works and how to operate it, in plain English, with
 * the real values from the plan. Deterministic; contains no secrets or absolute paths. The
 * server's address (`ctx.serverIpv4`/`serverIpv6`) is shown only when the domain is not behind
 * Cloudflare's proxy: a published origin address would let anyone go around Cloudflare. A server
 * the user owns gets its own runbook (see `renderOwnRunbook`). Another environment's runbook is
 * `opscrew/environments/<env>/RUNBOOK.md`, with its own folders and `--env <env>` on every command;
 * prod's is unchanged.
 */
export function renderRunbook(plan: DeployPlan, ctx: RunbookContext): RenderedFile {
  if (plan.target.provider === "own") return renderOwnRunbook(plan, plan.target, ctx);
  const target = cloudTarget(plan.target);
  const provider = PROVIDER_TEXT[target.provider];
  const hidden = usesCloudflare(plan) && plan.dns.proxied;
  const ip = hidden ? undefined : ctx.serverIpv4;
  const ipv6 = hidden ? undefined : ctx.serverIpv6;
  const hosts = siteHosts(plan);
  const url = hosts.length > 0 ? `https://${hosts[0]}` : ip ? `http://${ip}` : PENDING;
  const { environments } = ctx;
  const folders = runbookFolders(plan, ctx.projectId);
  const projectDir = folders.home;
  const keyPath = `${projectDir}/deploy_key`;
  const status = opscrew(plan, "status", environments);
  const statusIp = opscrew(plan, "status --ip", environments);
  const provision = opscrew(plan, "provision", environments);
  const ssh = `ssh -i ${keyPath} deploy@${ip ?? `$(${statusIp})`}`;
  const addresses = hidden
    ? `kept private behind Cloudflare: \`${status}\` shows them`
    : `${ip ?? PENDING} / ${ipv6 ?? PENDING}`;
  const repo = `${ctx.github.owner}/${ctx.github.repo}`;
  const db = dataCell(
    plan,
    target.backups ? provider.runbook.backupsOnDatabaseCell : "automated backups are off",
    externalDatabaseCell(plan),
  );
  const dns = usesCloudflare(plan)
    ? `Cloudflare, ${plan.dns.proxied ? "proxied (the server IP is hidden behind Cloudflare)" : "DNS only"}`
    : "No domain yet: the app is served over plain HTTP on the server IP";

  const lines = [
    ...runbookHead(plan, ctx, url),
    `| Server | ${cell(`${plan.app.name} — ${provider.serverLabel(target.serverType, target.location)}`)} |`,
    `| IPv4 / IPv6 | ${cell(addresses)} |`,
    ...deployRows(plan, repo),
    `| Database | ${cell(db)} |`,
    `| DNS | ${cell(dns)} |`,
    `| Cost | ${cell(money(plan, provider))} |`,
    "",
    ...deploySections(plan, ctx),
    ...componentsSection(plan, environments),
    ...edgeSection(plan, false, environments),
    ...objectStorageSection(plan, projectDir, environments),
    "## Connect to the server",
    "",
    ...serverCommands(plan, [
      ssh,
      ...(ip === undefined
        ? [`# without a global install: ssh -i ${keyPath} deploy@$(npx ${statusIp})`]
        : []),
    ]),
    "",
    deployKeyStored(plan, environments),
    "secret). Password login and root login are disabled on the server.",
    "",
    ...(ip === undefined
      ? [
          ...(hidden
            ? [
                "The server's IP address is not written in this repository: Cloudflare's proxy hides it, and a published",
                "address would let anyone go around Cloudflare.",
              ]
            : []),
          `\`${status}\` shows the address on the machine that ran \`${provision}\` (\`${statusIp}\` prints`,
          "only the IPv4 address, as used above).",
          "",
        ]
      : []),
    ...provider.runbook.connectNote,
  ];

  if (serviceOf(plan, "postgres")) {
    lines.push(
      "## Database backups",
      "",
      target.backups
        ? provider.runbook.backupsOn
        : `Automated server backups are **off**. Turn them on with \`${opscrew(plan, "design", environments)}\` (they cost extra; it shows the price) or make your own backups:`,
      "",
      ...DATABASE_DUMP,
    );
  }

  lines.push(
    ...settingsSection(plan, environments, [
      `- **Server size, location, domain:** run \`${opscrew(plan, "design", environments)}\` and \`${provision}\`. OpsCrew shows the plan and the cost`,
      "  change and applies nothing without your approval. Destroying or replacing the server always needs a typed confirmation.",
    ]),
    ...recoverySection(plan, environments),
    ...moving(plan, ctx.environments),
    "## Check for drift",
    "",
    `Run \`${opscrew(plan, "drift", environments)}\` on the machine that ran \`${provision}\` (the state lives there). It compares three things:`,
    "",
    "- **The real infrastructure with the state:** a refresh-only plan shows anything changed outside OpsCrew, for example",
    `  a firewall rule edited in ${provider.console} or a DNS record changed in Cloudflare.`,
    `- **The state with the code:** a normal plan shows changes in \`${folders.infra}/\` that have not been applied yet.`,
    ...driftFiles(plan),
    "",
    `\`${opscrew(plan, "drift", environments)}\` never changes anything and leaves no plan behind that could be applied. It exits with 0 when`,
    `everything matches and 1 when something differs (\`--json\` for scripts). To fix drift, run \`${provision}\`,`,
    "which shows the plan and applies nothing without your approval.",
    "",
    ...securityHead(plan, environments),
    "- What OpsCrew set up on the server: a `deploy` user with key-only SSH, no root login, fail2ban against brute force,",
    `  automatic security updates, a host firewall (22/80/443) in addition to ${provider.runbook.cloudFirewall}, and Docker log limits.`,
  );
  if (hidden) {
    lines.push(
      "- Web traffic reaches the server only through Cloudflare; the server's firewall accepts ports 80 and 443 only from",
      "  Cloudflare's IP ranges.",
    );
  }
  lines.push(
    "",
    ...troubleshooting(plan, environments),
    ...teardown(plan, target, repo, provider, ctx.environments),
  );
  return { path: runbookFilePath(plan), content: lines.join("\n"), kind: "doc" };
}

/**
 * "Moving to another provider": `opscrew retarget`, the maintenance window (only with a database
 * on the server), the cost of running both servers until `--finish`, and `--abort` before the DNS
 * switch.
 */
function moving(plan: DeployPlan, environments: readonly string[] | undefined): string[] {
  const confirm = "it continues once you confirm; in scripts, pass `--dns-switched`";
  const dns = usesCloudflare(plan)
    ? "switches the Cloudflare DNS records to it."
    : plan.dns.domain !== undefined
      ? `shows you the DNS records to change at your DNS provider (${confirm}).`
      : `shows you the new server's address (${confirm}).`;
  const copy = serviceOf(plan, "postgres") ? ", copies the database" : "";
  const retarget = (options: string) => `\`${opscrew(plan, `retarget${options}`, environments)}\``;
  return [
    "## Moving to another provider",
    "",
    ...wrap(
      `${retarget(" --to <provider>")} moves this app to another provider without losing its data. Run it on the ` +
        `machine that ran \`${opscrew(plan, "provision", environments)}\`, with the tokens of both providers set. OpsCrew creates a new server next ` +
        `to the current one, deploys the app there with the deploy workflow${copy} and ${dns} Every change shows its ` +
        "plan and waits for your approval; in scripts, each plan stops with its hash and " +
        `${retarget(" --approve <hash>")} continues, and \`--yes\` approves storing the GitHub deploy secrets, ` +
        `pushing and opening the pull request. If a run is interrupted, run ${retarget("")} again: it ` +
        `continues where it stopped, and \`${opscrew(plan, "status", environments)}\` shows how far the move got.`,
    ),
    "",
    ...wrap(
      serviceOf(plan, "postgres")
        ? "- **Maintenance window:** the database is copied while the app is stopped, so the app is offline for a few " +
            "minutes. OpsCrew shows the database size and the expected downtime first and asks before it stops the app " +
            "(in scripts, pass `--allow-downtime`). If the copy or the new app fails, the app starts again on the current server." +
            manualSwitchDowntime(plan, environments)
        : "- **No maintenance window:** this app keeps no database on the server, so there is nothing to copy and the " +
            "current server serves users until DNS points at the new one.",
      "  ",
    ),
    ...wrap(
      `- **Both servers cost money:** the old server keeps running until you run ${retarget(" --finish")} (its app ` +
        "is stopped after the DNS switch), and both servers are billed until then. Finish deletes the old server the " +
        `way \`${opscrew(plan, "destroy", environments)}\` would: it offers a snapshot, asks you to type the app name ` +
        `(\`--confirm ${plan.app.name}\` in scripts) and opens a pull request with the final infrastructure files.`,
      "  ",
    ),
    ...wrap(
      `- **Abort:** ${retarget(" --abort")} deletes the new server and puts the app back on the current one, but ` +
        `only before the DNS switch. After the switch, the way back is another ${retarget("")}.`,
      "  ",
    ),
    "",
  ];
}

/**
 * Without OpsCrew-managed DNS (Cloudflare with a domain) the app on the old server stays stopped
 * after the copy until the user's own switch has taken effect: say so (leading space included),
 * or nothing when OpsCrew switches DNS itself.
 */
function manualSwitchDowntime(
  plan: DeployPlan,
  environments: readonly string[] | undefined,
): string {
  if (usesCloudflare(plan)) return "";
  if (plan.dns.domain === undefined) {
    return (
      " Without a domain, the downtime lasts for the copy plus the time your users need to switch to the new " +
      "address: the app on the current server stays stopped from the copy on. In scripts, pass " +
      "`--allow-downtime --dns-switched` together only when your users can switch right after the copy."
    );
  }
  return (
    " Without OpsCrew-managed DNS, the downtime lasts for the copy plus your DNS change: the app on the current " +
    "server stays stopped until the records point to the new server and the change has reached your users, so " +
    "lower the TTL of the DNS records beforehand (for example to 60 seconds). In scripts, pass " +
    "`--allow-downtime --dns-switched` together only when the records are ready to change right after the copy; " +
    "with `--allow-downtime` alone the run stops after the copy, with the app offline, until you change them and " +
    `run \`${opscrew(plan, "retarget --dns-switched", environments)}\`.`
  );
}

/**
 * Wraps Markdown source text at `width` columns without breaking inline code spans; continuation
 * lines start with `indent`.
 */
function wrap(text: string, indent = "", width = 118): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.match(/(?:`[^`]*`|[^\s`])+/g) ?? []) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** "Tear it down": what `opscrew destroy` deletes, the snapshot offer and what remains. */
function teardown(
  plan: DeployPlan,
  { backups }: CloudDeployTarget,
  repo: string,
  provider: ProviderText,
  environments: readonly string[] | undefined,
): string[] {
  const name = plan.app.name;
  const text = provider.runbook;
  const noun = provider.serverNoun;
  const deletes = usesCloudflare(plan)
    ? `${text.deletes(name)}, and the Cloudflare DNS records and rules OpsCrew created`
    : text.deletes(name);
  const keepsData = serviceOf(plan, "postgres") !== undefined || backups;
  const reason = serviceOf(plan, "postgres")
    ? `the database lives on the ${noun}`
    : text.snapshotReason;
  const [snapshotLead = "", ...snapshotRest] = text.snapshotFirst;
  return [
    "## Tear it down",
    "",
    `Run \`${opscrew(plan, "destroy", environments)}\` on the machine that ran \`${opscrew(plan, "provision", environments)}\`. It deletes`,
    `${deletes}.`,
    `It first lists everything it will delete and the data at risk, then asks you to type the ${noun} name`,
    `(\`${name}\`) before anything is deleted. In scripts, pass \`--confirm ${name}\`.`,
    "",
    ...text.deleteProtectionNote,
    ...(keepsData
      ? [`- **Snapshot first:** because ${reason}, ${snapshotLead}`, ...snapshotRest]
      : text.noSnapshot),
    ...text.whatRemains(
      ghcrImageFor(repo, plan.app.key),
      artefactsFolder(plan, "prod"),
      plan.cicd.workflowPath,
      backups,
    ),
    ...(plan.storage?.objectStorage === undefined
      ? []
      : [
          `- **The bucket \`${plan.storage.objectStorage.bucket}\`** stays with the app's files, and is billed, unless you add \`--delete-data\`.`,
        ]),
    "- **What is removed besides the infrastructure:** the GitHub deploy secrets, so the workflow can no longer deploy,",
    `  and ${text.hostKey} on this machine. \`${runbookFolders(plan, undefined).artefacts}/plan.yaml\` records that the deployment was destroyed.`,
    "",
    ...deployAgain(plan, environments),
  ];
}
