/**
 * `opscrew verify` for an app on a hosting account (027 plan 9, US1 scenario 6), from this
 * computer over HTTP and HTTPS, changing nothing: the app answers over HTTPS with the release the
 * agent switched to, plain HTTP redirects there, the app's settings, OpsCrew's `.htaccess`, the
 * release folders and (served from a release's root) Composer's packages can't be read from the
 * web, no other hostname of the account serves the app's folder, and the app runs the PHP version
 * its plan chose. Also how the hosting checks after provision reach the account (panel or SFTP).
 */
import type {
  CheckResult,
  FetchLike,
  HostingDomain,
  HostingFiles,
  HostingPanel,
} from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, errorText as userErrorText } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { checkResult, editCheckText, hasDeployment, summarizeChecks } from "../shared";
import { errorText, reportChecks } from "../verify/checks";
import type { VerifyResult } from "../verify/run";
import { PANEL_NAMES } from "./panels";
import { hostingTarget, hostnameOf } from "./provision-plans";
import { type HostingRecord, readHostingRecord } from "./record";
import { type HostingAccountServices, reachHostingAccount } from "./status";

/** How long each request may take. */
const TIMEOUT_MS = 10_000;

/** A release's id, `<run id>-<attempt>`, as the agent's `.htaccess` sends it. */
const RELEASE = /^[1-9][0-9]*-[1-9][0-9]*$/;

/** What the hosting checks after provision reach: the account's record, panel and files. */
export interface CheckedAccount {
  record: HostingRecord;
  /** The account's panel; absent on an SFTP host. */
  panel?: HostingPanel;
  /** The account's files; undefined where neither the panel's API nor SFTP reaches them here. */
  files: HostingFiles | undefined;
  /** The app's folder from the home folder. */
  folder: string;
  hostname: string;
  /** The account in words: `your cPanel account`, `your SFTP host`. */
  words: string;
}

/**
 * The account `opscrew provision` recorded on this computer: through its panel (the token from the
 * environment, `reachHostingAccount`), or an SFTP host through `services.files`, the SFTP
 * connector's files, in the folder its record names.
 * @throws OpsCrewError `PHASE_PRECONDITION` without a record of the account.
 */
export async function reachCheckedAccount(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: HostingAccountServices = {},
): Promise<CheckedAccount> {
  if (hostingTarget(plan).panel !== "sftp") {
    const reach = await reachHostingAccount(deps, plan, services);
    return {
      record: reach.record,
      panel: reach.panel,
      files: reach.files,
      folder: reach.folder,
      hostname: reach.hostname,
      words: `your ${PANEL_NAMES[reach.panel.kind]} account`,
    };
  }
  const record = await readHostingRecord(deps.paths);
  if (record?.sftp === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has no record of the SFTP host on this computer (.opscrew/hosting.json), so it can't reach the app there.",
      {
        hint: "Run the command on the computer that ran `opscrew provision`, or on one where .opscrew/ was restored from OpsCrew's recovery copy.",
      },
    );
  }
  return {
    record,
    files: services.files,
    folder: record.sftp.folder,
    hostname: hostnameOf(plan),
    words: "your SFTP host",
  };
}

/** What the HTTP checks share. */
export interface SiteContext {
  fetch: FetchLike;
  hostname: string;
  /** ` --env <name>` (and ` --app <key>`) for the commands the checks name. */
  flag: string;
}

/** A GET of `url`, following redirects or not. */
function get(ctx: SiteContext, url: string, redirect: "manual" | "follow"): Promise<Response> {
  return ctx.fetch(url, { method: "GET", redirect, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Drops a response's body unread. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to clean up.
  }
}

/** The app's answer over HTTPS: the check, and the release and PHP the answer names. */
interface HttpsAnswer {
  check: CheckResult;
  release?: string;
  /** The answer's `X-Powered-By` header (`PHP/8.3.12`), when there was an answer. */
  poweredBy?: string | null;
}

/**
 * The health path over HTTPS answers 2xx or 3xx with `X-OpsCrew-Release`, as the agent checks it
 * after each switch (the certificate checked by the request itself).
 */
async function httpsCheck(ctx: SiteContext, plan: DeployPlan): Promise<HttpsAnswer> {
  const id = "hosting-https";
  const title = "The app answers over HTTPS with a release the agent deployed";
  const path = plan.app.healthPath.startsWith("/")
    ? plan.app.healthPath
    : `/${plan.app.healthPath}`;
  const target = `https://${ctx.hostname}${path}`;
  const status = `\`opscrew status${ctx.flag}\``;
  let response: Response;
  try {
    response = await get(ctx, target, "manual");
  } catch (error) {
    return {
      check: checkResult(
        id,
        title,
        "high",
        "fail",
        `Could not reach ${target}: ${errorText(error)}.`,
        {
          remediation: `Check that ${ctx.hostname} points at the hosting account and has its certificate: ${status} shows the certificate and what the agent last did.`,
          target,
        },
      ),
    };
  }
  await discard(response);
  const release = response.headers.get("x-opscrew-release") ?? undefined;
  const poweredBy = response.headers.get("x-powered-by");
  const answered = response.status >= 200 && response.status < 400;
  if (answered && release !== undefined && RELEASE.test(release)) {
    return {
      check: checkResult(
        id,
        title,
        "high",
        "pass",
        `${target} answered ${response.status} with release ${release}.`,
        { target },
      ),
      release,
      poweredBy,
    };
  }
  return {
    check: checkResult(
      id,
      title,
      "high",
      "fail",
      answered
        ? `${target} answered ${response.status} without OpsCrew's release header, so the hostname doesn't serve a release the agent deployed.`
        : `${target} answered HTTP ${response.status}${release === undefined ? "" : ` (release ${release})`}.`,
      {
        remediation: `${status} shows the release that runs and the agent's last attempt; \`opscrew logs${ctx.flag}\` shows its lines.`,
        target,
      },
    ),
    ...(release !== undefined ? { release } : {}),
    poweredBy,
  };
}

/**
 * Plain HTTP redirects to HTTPS on the hostname: the agent's block forces it once the hostname's
 * certificate verifies from the account.
 */
export async function httpRedirectCheck(
  ctx: SiteContext,
  id = "hosting-http-redirect",
  title = "HTTP redirects to HTTPS",
): Promise<CheckResult> {
  const target = `http://${ctx.hostname}/`;
  const remediation = `The agent forces HTTPS once ${ctx.hostname}'s certificate verifies from the account: \`opscrew status${ctx.flag}\` shows the certificate.`;
  try {
    const response = await get(ctx, target, "manual");
    await discard(response);
    const location = response.headers.get("location") ?? "";
    if (
      response.status >= 300 &&
      response.status < 400 &&
      location.startsWith(`https://${ctx.hostname}`)
    ) {
      return checkResult(id, title, "medium", "pass", `${target} redirects to ${location}.`, {
        target,
      });
    }
    return checkResult(
      id,
      title,
      "medium",
      "fail",
      `${target} answered HTTP ${response.status}${location === "" ? "" : ` → ${location}`} instead of redirecting to https://${ctx.hostname}.`,
      { remediation, target },
    );
  } catch (error) {
    return checkResult(
      id,
      title,
      "medium",
      "fail",
      `Could not reach ${target}: ${errorText(error)}.`,
      {
        remediation,
        target,
      },
    );
  }
}

/** A path that must not be readable from the web, and how its content gives itself away. */
interface Refused {
  id: string;
  title: string;
  path: string;
  /**
   * True when a 2xx answer (the start of its body, its headers) is the file or folder itself, not
   * an app's page for an unknown path.
   */
  looksServed: (body: string, headers: Headers) => boolean;
  /** What a served one means. */
  served: string;
  remediation: string;
}

const HTML = /<html|<!doctype/i;

/**
 * `refused.path` over HTTPS isn't served: any answer but 2xx passes, and so does a 2xx page that
 * isn't the thing itself (the app's own page for an unknown path). Only the start of a body is
 * read, to tell them apart; it is never kept or shown.
 */
async function refusedCheck(ctx: SiteContext, refused: Refused): Promise<CheckResult> {
  const { id, title } = refused;
  const target = `https://${ctx.hostname}${refused.path}`;
  try {
    const response = await get(ctx, target, "manual");
    if (response.status < 200 || response.status >= 300) {
      await discard(response);
      return checkResult(
        id,
        title,
        "critical",
        "pass",
        `${target} answered HTTP ${response.status}.`,
        {
          target,
        },
      );
    }
    const body = (await response.text()).slice(0, 4096);
    if (!refused.looksServed(body, response.headers)) {
      return checkResult(
        id,
        title,
        "critical",
        "pass",
        `${target} answered ${response.status} with the app's own page, not the thing itself.`,
        { target },
      );
    }
    return checkResult(id, title, "critical", "fail", `${target} ${refused.served}`, {
      remediation: refused.remediation,
      target,
    });
  } catch (error) {
    return checkResult(
      id,
      title,
      "critical",
      "warn",
      `Could not request ${target}: ${errorText(error)}.`,
      {
        target,
      },
    );
  }
}

/** The paths of an app on a hosting account that must not be readable from the web. */
function refusedPaths(plan: DeployPlan, release: string | undefined, flag: string): Refused[] {
  const target = hostingTarget(plan);
  const blockGone = `OpsCrew's block in the release's .htaccess refuses it: check that the panel or the app didn't replace the file, then deploy again (the agent writes the block for each release); \`opscrew secure${flag}\` checks the block.`;
  const refused: Refused[] = [
    {
      id: "hosting-env-file",
      title: "/.env is not served",
      path: "/.env",
      looksServed: (body) =>
        /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(body) && !HTML.test(body),
      served: "serves the app's settings file: anyone can read its values.",
      remediation: `${blockGone} Then change every value it holds.`,
    },
    {
      id: "hosting-htaccess",
      title: "/.htaccess is not served",
      path: "/.htaccess",
      looksServed: (body) =>
        /^\s*(# BEGIN OpsCrew|RewriteEngine|RewriteCond|RewriteRule|Options|Header|AddHandler|php_value|<IfModule|<FilesMatch)\b/m.test(
          body,
        ) && !HTML.test(body),
      served: "serves the release's .htaccess: anyone can read its rules.",
      remediation: blockGone,
    },
    {
      id: "hosting-release-folders",
      title: "The release folders are not served from the web",
      path: `/releases/${release === undefined ? "" : `${release}/`}`,
      // A release answers with its release header; a listing of the folders names them.
      looksServed: (body, headers) =>
        headers.get("x-opscrew-release") !== null || /Index of \/releases/i.test(body),
      served:
        "serves a release folder: the hostname's document root is above the release it should serve.",
      remediation: `Set ${hostnameOf(plan)}'s document root back to the one OpsCrew made (\`opscrew drift${flag}\` names it) in the panel.`,
    },
  ];
  if (target.webRoot === "." && target.app === "php") {
    refused.push({
      id: "hosting-composer-packages",
      title: "Composer's packages are not served",
      path: "/vendor/composer/installed.json",
      looksServed: (body) => /^\s*[[{]/.test(body) && /"name"\s*:/.test(body),
      served:
        "serves Composer's list of the app's packages: anyone can read them and their versions.",
      remediation: blockGone,
    });
  }
  return refused;
}

/** The account's hostnames as its panel lists them, or why they weren't read. */
type HostnameList = { domains: readonly HostingDomain[]; panel: string } | { skipped: string };

/**
 * No other hostname of the account serves the app's folder (plan 5: a document root inside
 * `public_html` can be reached as a folder of the main domain): each domain the panel lists whose
 * document root is the app's, or holds it, is asked for the app's folder over HTTP and must not
 * serve the app (OpsCrew's block answers 403). Needs the panel: skipped with the reason without it.
 */
async function otherHostnamesCheck(ctx: SiteContext, listed: HostnameList): Promise<CheckResult> {
  const id = "hosting-other-hostnames";
  const title = "No other hostname serves the app";
  if ("skipped" in listed) return checkResult(id, title, "high", "skip", listed.skipped);
  const { domains } = listed;
  const root = domains.find((domain) => domain.name === ctx.hostname)?.documentRoot;
  if (root === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `${listed.panel} doesn't list ${ctx.hostname} with a document root.`,
      { remediation: `\`opscrew drift${ctx.flag}\` says what changed in the panel.` },
    );
  }
  const others = domains.flatMap((domain) => {
    const own = domain.documentRoot;
    if (domain.name === ctx.hostname || own === undefined) return [];
    if (own === root) return [`http://${domain.name}/`];
    return root.startsWith(`${own}/`)
      ? [`http://${domain.name}/${root.slice(own.length + 1)}/`]
      : [];
  });
  if (others.length === 0) {
    return checkResult(
      id,
      title,
      "high",
      "pass",
      `No other hostname of the account has the app's document root (~/${root}) or a folder above it.`,
    );
  }
  const serving: string[] = [];
  const unreached: string[] = [];
  for (const url of others) {
    try {
      const response = await get(ctx, url, "follow");
      await discard(response);
      const ok = response.status >= 200 && response.status < 400;
      if (ok && response.headers.get("x-opscrew-release") !== null) serving.push(url);
    } catch {
      unreached.push(url);
    }
  }
  if (serving.length > 0) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `${serving.join(", ")} ${serving.length === 1 ? "serves" : "serve"} the app as well as https://${ctx.hostname}.`,
      {
        remediation: `OpsCrew's block in the release's .htaccess refuses every hostname but ${ctx.hostname}: check that the panel or the app didn't replace the file; \`opscrew secure${ctx.flag}\` checks the block.`,
      },
    );
  }
  const reached = others.filter((url) => !unreached.includes(url));
  return checkResult(
    id,
    title,
    "high",
    unreached.length > 0 ? "warn" : "pass",
    [
      reached.length > 0 ? `${reached.join(", ")} refused the app.` : "",
      unreached.length > 0 ? `OpsCrew could not reach ${unreached.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * The PHP version the app answers with is the plan's: read from the answer's `X-Powered-By`
 * (`PHP/8.3.12`), which PHP sends unless the account hides it (`expose_php` off). From outside
 * there is no other sign of it without a page of the app's own, so a hidden one is skipped.
 */
function phpVersionCheck(
  plan: DeployPlan,
  answer: HttpsAnswer,
  flag: string,
): CheckResult | undefined {
  const target = hostingTarget(plan);
  if (target.app !== "php") return undefined;
  const id = "hosting-php-version";
  const wanted = target.php?.version;
  const title = `The app runs PHP ${wanted ?? "as provision chose"}`;
  if (wanted === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "skip",
      `Provision hasn't chosen the app's PHP version yet: \`opscrew provision${flag}\` does.`,
    );
  }
  if (answer.poweredBy === undefined) {
    return checkResult(id, title, "high", "skip", "Skipped because the app didn't answer.");
  }
  const [, full, version] = /\bPHP\/((\d+\.\d+)(?:\.\d+)?)/i.exec(answer.poweredBy ?? "") ?? [];
  if (full === undefined || version === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "skip",
      `The app's answer doesn't say which PHP runs it (the account doesn't send X-Powered-By), so OpsCrew can't check PHP ${wanted} from outside.`,
    );
  }
  if (version === wanted) {
    return checkResult(id, title, "high", "pass", `The app answers from PHP ${full}.`);
  }
  const hostname = hostnameOf(plan);
  const how =
    target.php?.via === "handler"
      ? `The handler line in OpsCrew's block (AddHandler) gives ${hostname} PHP ${wanted}: check that the panel didn't change the release's .htaccess, then deploy again`
      : target.php?.via === "multiphp"
        ? `Set ${hostname}'s PHP version back to ${wanted} in the panel's MultiPHP Manager`
        : `The account's PHP version was ${wanted} at provision and changed since, for every site of the account, in the panel's PHP selector`;
  return checkResult(
    id,
    title,
    "high",
    "fail",
    `The app answers from PHP ${full}, not ${wanted}, the version provision chose for it.`,
    {
      remediation: `${how}; \`opscrew provision${flag}\` chooses again if the app needs another version now.`,
    },
  );
}

/**
 * `opscrew verify` on a hosting account (see the module's comment): the checks over HTTP and
 * HTTPS, and the panel's list of the account's hostnames for the other-hostname check (skipped
 * with its reason on an SFTP host or without the panel here). Changes nothing, writes no runbook,
 * and marks `verify`.
 * @throws OpsCrewError `PHASE_PRECONDITION` before provision.
 */
export async function verifyHosting(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { fetch?: FetchLike; services?: HostingAccountServices } = {},
): Promise<VerifyResult> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The hosting account isn't set up for the app yet, so there is nothing to verify.",
      {
        hint: `Run \`opscrew provision${flag}\` first, merge its pull request, then run \`opscrew verify${flag}\`.`,
      },
    );
  }
  const hostname = hostnameOf(plan);
  const ctx: SiteContext = { fetch: options.fetch ?? deps.fetch, hostname, flag };
  deps.reporter.step(`Checking https://${hostname} from this computer (read-only)`);
  const https = await httpsCheck(ctx, plan);
  const checked: CheckResult[] = [https.check, await httpRedirectCheck(ctx)];
  for (const refused of refusedPaths(plan, https.release, flag)) {
    checked.push(await refusedCheck(ctx, refused));
  }
  let listed: HostnameList;
  if (hostingTarget(plan).panel === "sftp") {
    listed = {
      skipped: `OpsCrew can't list an SFTP host's other hostnames; the agent's block in the release's .htaccess refuses every hostname but ${hostname}.`,
    };
  } else {
    try {
      const { panel } = await reachHostingAccount(deps, plan, options.services);
      listed = { domains: (await panel.inspect()).domains, panel: PANEL_NAMES[panel.kind] };
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      listed = {
        skipped: `OpsCrew could not read the account's hostnames from the panel. ${userErrorText(error)}`,
      };
    }
  }
  checked.push(await otherHostnamesCheck(ctx, listed));
  const php = phpVersionCheck(plan, https, flag);
  if (php !== undefined) checked.push(php);

  const checks = checked.map((check) => editCheckText(check, (t) => deps.redactor.redact(t)));
  reportChecks(deps.reporter, checks);
  const passed = checks.every((check) => check.status !== "fail");
  const summary = summarizeChecks(checks);
  const url = `https://${hostname}`;
  if (passed) deps.reporter.success(`${url} is live on the hosting account (${summary}).`);
  else {
    deps.reporter.error(
      `Verification found problems (${summary}). Fix them and run \`opscrew verify${flag}\` again.`,
    );
  }
  await deps.state.markPhase("verify", passed ? "ok" : "failed", summary);
  return { checks, passed, url, plan };
}
