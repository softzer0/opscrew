/**
 * `opscrew secure` for an app on a hosting account (027 plan 9, US6 scenario 1), read-only, in the
 * place of a server's checks: the hostname's PHP version against PHP's supported versions
 * (`phpSupport`, secops), the app's settings outside the web root, OpsCrew's `.htaccess` block
 * with directory listings off and dotfiles refused, and HTTPS forced. The account itself is the
 * host's: no SSH, firewall or kernel of its own for OpsCrew to check.
 */
import type { CheckResult, FetchLike, HostingFiles } from "@opscrew/contracts";
import { errorText, isUserFacingError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { PHP_BRANCHES_READ, PHP_SUPPORTED_VERSIONS_URL, phpSupport } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { checkResult, editCheckText } from "../shared";
import { hostingTarget, hostnameOf } from "./provision-plans";
import { recordedObject } from "./record";
import { type HostingAccountServices, readAgentStatus } from "./status";
import { type CheckedAccount, httpRedirectCheck, reachCheckedAccount } from "./verify";

/** What `opscrew secure` reports of an app on a hosting account in a server's place. */
export interface HostingSecurity {
  checks: CheckResult[];
  /** The account in words, for the report's heading: `your cPanel account`. */
  host: string;
  /** What the report says of a server's checks that don't apply. */
  notes: string[];
  /** Why no port is probed. */
  probesSkipped: string;
}

/** The hostname's PHP version against PHP's supported versions on `now`. */
function phpSupportCheck(plan: DeployPlan, now: Date, flag: string): CheckResult | undefined {
  const target = hostingTarget(plan);
  if (target.app !== "php") return undefined;
  const id = "hosting-php-supported";
  const version = target.php?.version;
  const title =
    version === undefined
      ? "The app's PHP version gets security fixes"
      : `PHP ${version} gets security fixes`;
  if (version === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "skip",
      `Provision hasn't chosen the app's PHP version yet: \`opscrew provision${flag}\` does.`,
    );
  }
  const read = `php.net, read ${PHP_BRANCHES_READ}`;
  const support = phpSupport(version, now);
  if (support.state === "unknown") {
    return checkResult(
      id,
      title,
      "low",
      "warn",
      `OpsCrew's table of PHP's supported versions (${read}) doesn't list PHP ${version}.`,
      { remediation: `Check PHP ${version} on ${PHP_SUPPORTED_VERSIONS_URL}.` },
    );
  }
  const { branch } = support;
  if (support.state === "active") {
    return checkResult(
      id,
      title,
      "high",
      "pass",
      `PHP ${version} gets bug and security fixes until ${branch.activeUntil}, then security fixes until ${branch.securityUntil} (${read}).`,
    );
  }
  if (support.state === "security") {
    return checkResult(
      id,
      title,
      "high",
      "pass",
      `PHP ${version} gets security fixes only, until ${branch.securityUntil} (${read}).`,
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "fail",
    `PHP ${version} gets no security fixes since ${branch.securityUntil} (${read}): holes found in it since stay open.`,
    {
      remediation: `Raise the PHP version the app needs in composer.json (require.php) to a supported one (${PHP_SUPPORTED_VERSIONS_URL}), then run \`opscrew design${flag}\` and \`opscrew provision${flag}\`: they give ${hostnameOf(plan)} that version where the account has it, or say what to ask the host.`,
    },
  );
}

/**
 * The app's settings (`shared/`) are outside the hostname's document root, as the panel reports
 * it: the root must be neither `shared/` nor a folder above it.
 */
async function settingsPlaceCheck(account: CheckedAccount): Promise<CheckResult> {
  const id = "hosting-settings-place";
  const title = "The app's settings are outside the web root";
  const { panel, folder, hostname } = account;
  const shared = `${folder}/shared`;
  if (panel === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "skip",
      `On an SFTP host the hostname's document root is yours to set, and OpsCrew can't read it: point it at the release's folder, never at ~/${folder}/ itself, where ~/${shared}/ holds the app's settings.`,
    );
  }
  const root = await panel.documentRoot(hostname);
  if (root === undefined) {
    return checkResult(id, title, "high", "skip", `The account doesn't serve ${hostname} now.`, {
      remediation: "`opscrew drift` says what changed in the panel.",
    });
  }
  const clean = root.replace(/^\.?\/+|\/+$/g, "");
  if (clean === "" || clean === shared || shared.startsWith(`${clean}/`)) {
    return checkResult(
      id,
      title,
      "critical",
      "fail",
      `${hostname} serves ~/${clean}${clean === "" ? "" : "/"}, which holds ~/${shared}/: the app's settings and its database's login may be read from the web.`,
      {
        remediation: `Set ${hostname}'s document root back to ~/${recordedObject(account.record, "hostname", hostname)?.value ?? `${folder}/current`} in the panel, then change every value in ~/${shared}/.env.`,
      },
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    `${hostname} serves ~/${clean}; the app's settings are in ~/${shared}/, outside it.`,
  );
}

/** Why the files' modes aren't checked. */
const MODES = checkResult(
  "hosting-file-modes",
  "The app's settings files and Laravel's cached config are readable by the account only",
  "medium",
  "skip",
  "OpsCrew reads no file modes on the account (the panel's API and its file calls don't show them), so it can't check them. OpsCrew writes the settings files (shared/.env, env.php, mysql.cnf) 0600, and the agent makes Laravel's cached config 0600 after each release.",
);

/** OpsCrew's block in `htaccess`, between `# BEGIN OpsCrew` and `# END OpsCrew`. */
function opscrewBlock(htaccess: string): string[] | undefined {
  const lines = htaccess.split(/\r?\n/);
  const begin = lines.indexOf("# BEGIN OpsCrew");
  const end = lines.indexOf("# END OpsCrew");
  return begin === -1 || end < begin ? undefined : lines.slice(begin + 1, end);
}

/**
 * Directory listings off (`Options -Indexes`) and dotfiles refused (`<FilesMatch "^\.">` with
 * `Require all denied`) in OpsCrew's block of the running release's served `.htaccess`.
 */
async function htaccessChecks(
  plan: DeployPlan,
  reach: { folder: string; files: HostingFiles } | { skipped: string },
): Promise<CheckResult[]> {
  const listings = { id: "hosting-directory-listings", title: "Directory listings are off" };
  const dotfiles = { id: "hosting-dotfiles", title: "Dotfiles are refused" };
  const all = (status: "skip" | "fail", message: string, remediation?: string) =>
    [listings, dotfiles].map(({ id, title }) =>
      checkResult(
        id,
        title,
        "high",
        status,
        message,
        remediation === undefined ? {} : { remediation },
      ),
    );
  if ("skipped" in reach) return all("skip", reach.skipped);
  const { folder, files } = reach;
  const { webRoot } = hostingTarget(plan);
  const path = `${folder}/current${webRoot === "." ? "" : `/${webRoot}`}/.htaccess`;
  const text = await files.readFile(path);
  const deploy = "Deploy again: the agent writes OpsCrew's block into each release's .htaccess.";
  if (text === undefined) {
    const status = await readAgentStatus(files, folder);
    return status?.running === undefined
      ? all("skip", "No release runs yet: the agent writes OpsCrew's block with the first one.")
      : all("fail", `~/${path} isn't there, so nothing refuses listings or dotfiles.`, deploy);
  }
  const block = opscrewBlock(text);
  if (block === undefined) {
    return all(
      "fail",
      `~/${path} has no OpsCrew block: it was replaced since the release.`,
      deploy,
    );
  }
  const dots = block.indexOf('<FilesMatch "^\\.">');
  return [
    block.includes("Options -Indexes")
      ? checkResult(listings.id, listings.title, "high", "pass", `~/${path} turns them off.`)
      : checkResult(
          listings.id,
          listings.title,
          "high",
          "fail",
          `OpsCrew's block in ~/${path} has no Options -Indexes, so folders without an index are listed.`,
          { remediation: deploy },
        ),
    dots !== -1 && block[dots + 1] === "Require all denied"
      ? checkResult(dotfiles.id, dotfiles.title, "high", "pass", `~/${path} refuses them.`)
      : checkResult(
          dotfiles.id,
          dotfiles.title,
          "critical",
          "fail",
          `OpsCrew's block in ~/${path} doesn't refuse dotfiles, so files such as .env and .htaccess may be read.`,
          { remediation: deploy },
        ),
  ];
}

/**
 * The checks of an app on a hosting account in a server's place (see the module's comment). A
 * part OpsCrew can't reach here (the panel without its token, the files without SFTP) is skipped
 * with the reason. Nothing changes.
 */
export async function hostingSecurityChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { fetch?: FetchLike; services?: HostingAccountServices } = {},
): Promise<HostingSecurity> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const hostname = hostnameOf(plan);
  deps.reporter.step(`Checking the app on the hosting account and ${hostname} (read-only)`);
  const checks: CheckResult[] = [];
  const php = phpSupportCheck(plan, deps.clock.now(), flag);
  if (php !== undefined) checks.push(php);
  let account: CheckedAccount | undefined;
  let unreachable: string | undefined;
  try {
    account = await reachCheckedAccount(deps, plan, options.services);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    unreachable = `OpsCrew could not reach the hosting account. ${errorText(error)}`;
  }
  checks.push(
    account === undefined
      ? checkResult(
          "hosting-settings-place",
          "The app's settings are outside the web root",
          "high",
          "skip",
          unreachable ?? "Skipped.",
        )
      : await settingsPlaceCheck(account),
    MODES,
  );
  checks.push(
    ...(await htaccessChecks(
      plan,
      account?.files !== undefined
        ? { folder: account.folder, files: account.files }
        : {
            skipped:
              unreachable ??
              `OpsCrew can't read the account's files here (${account?.panel === undefined ? "no SFTP access is given" : "the panel's API has no file calls, and no SFTP access is given"}), so it can't read the release's .htaccess.`,
          },
    )),
    await httpRedirectCheck(
      { fetch: options.fetch ?? deps.fetch, hostname, flag },
      "hosting-https-forced",
      "HTTPS is forced",
    ),
  );
  const host = account?.words ?? "your hosting account";
  return {
    checks: checks.map((check) => editCheckText(check, (text) => deps.redactor.redact(text))),
    host,
    notes: [
      `OpsCrew runs no server for this app: ${host} is the host's, which runs its web server, PHP and database and keeps their machines patched, so a server's checks (its SSH settings, firewall, fail2ban, automatic security updates and kernel settings) do not apply.`,
    ],
    probesSkipped:
      "OpsCrew probes no port: the account shares its host's addresses with other accounts, and the host decides which ports answer.",
  };
}
