/**
 * The hosting account's panel (feature 027, ADR 0030 D1, D2): its access from the environment on
 * this computer, which panel answers, its connector, and where the account's files are written.
 */
import { CpanelPanel } from "@opscrew/connector-cpanel";
import { DirectAdminPanel } from "@opscrew/connector-directadmin";
import { PleskPanel } from "@opscrew/connector-plesk";
import type {
  FetchLike,
  HostingFiles,
  HostingPanel,
  HostingPanelAccess,
  HostingPanelKind,
} from "@opscrew/contracts";
import { listText, normalizeHostName, OpsCrewError, orText, type Redactor } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type { HostingPanelRecord } from "./record";

/** The panel's address, `https://<host>` or `https://<host>:<port>`. */
export const HOSTING_URL_VAR = "OPSCREW_HOSTING_URL";
/** The account's user name. */
export const HOSTING_USER_VAR = "OPSCREW_HOSTING_USER";
/** cPanel's API token, Plesk's API key or password, DirectAdmin's login key. */
export const HOSTING_TOKEN_VAR = "OPSCREW_HOSTING_TOKEN";
/** An SFTP-only host's address. */
export const SFTP_HOST_VAR = "OPSCREW_SFTP_HOST";
/** The SFTP user. */
export const SFTP_USER_VAR = "OPSCREW_SFTP_USER";
/** The path of the SFTP user's private key file (never the key itself). */
export const SFTP_KEY_VAR = "OPSCREW_SFTP_KEY";

/** The variables that reach a panel's account. */
export const PANEL_VARS = [HOSTING_URL_VAR, HOSTING_USER_VAR, HOSTING_TOKEN_VAR] as const;
/** The variables that reach an SFTP-only host. */
export const SFTP_VARS = [SFTP_HOST_VAR, SFTP_USER_VAR, SFTP_KEY_VAR] as const;

/** Each panel's name in a sentence. */
export const PANEL_NAMES: Readonly<Record<HostingPanelKind, string>> = {
  cpanel: "cPanel",
  plesk: "Plesk",
  directadmin: "DirectAdmin",
};

/** The port each panel answers on, in the order they are tried. */
const PANEL_PORTS: readonly { port: number; kind: HostingPanelKind }[] = [
  { port: 2083, kind: "cpanel" },
  { port: 8443, kind: "plesk" },
  { port: 2222, kind: "directadmin" },
];

/** How a panel names itself in its `Server` header: cpsrvd, sw-cp-server, DirectAdmin Daemon. */
const SERVER_HEADERS: readonly { pattern: RegExp; kind: HostingPanelKind }[] = [
  { pattern: /\bcpsrvd\b/i, kind: "cpanel" },
  { pattern: /\bsw-cp-server\b/i, kind: "plesk" },
  { pattern: /\bdirectadmin\b/i, kind: "directadmin" },
];

/** How long each panel's port may take to answer. */
const PROBE_TIMEOUT_MS = 10_000;

type Env = PhaseDeps["env"];

const isSet = (env: Env, name: string) => (env[name]?.trim() ?? "") !== "";

/** The variables of `names` that are unset or blank in `env`. */
export function unsetVars(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => !isSet(env, name));
}

/**
 * How the environment reaches a hosting account: `panel` when the three `OPSCREW_HOSTING_*`
 * variables are set, else `sftp` when the three `OPSCREW_SFTP_*` are, else `undefined`.
 */
export function hostingReach(env: Env): "panel" | "sftp" | undefined {
  if (PANEL_VARS.every((name) => isSet(env, name))) return "panel";
  if (SFTP_VARS.every((name) => isSet(env, name))) return "sftp";
  return undefined;
}

/** What to set for a hosting account, for a hint. */
export const HOSTING_VARS_HINT = `Set ${listText([...PANEL_VARS])} for an account with cPanel, Plesk or DirectAdmin, or ${listText([...SFTP_VARS])} (the path of your key file) for a host you reach over SFTP only.`;

/**
 * The panel's access from `OPSCREW_HOSTING_URL`, `OPSCREW_HOSTING_USER` and
 * `OPSCREW_HOSTING_TOKEN`; the token is registered with the redactor first, so no output shows it.
 */
export function panelAccess(env: Env, redactor: Redactor): HostingPanelAccess {
  const missing = unsetVars(env, PANEL_VARS);
  if (missing.length > 0) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set, so OpsCrew can't reach your hosting account's panel.`,
      { hint: HOSTING_VARS_HINT },
    );
  }
  const token = (env[HOSTING_TOKEN_VAR] ?? "").trim();
  redactor.addLiteral(token, HOSTING_TOKEN_VAR);
  const url = (env[HOSTING_URL_VAR] ?? "").trim();
  return { url, user: (env[HOSTING_USER_VAR] ?? "").trim(), token };
}

/** The host of a panel's address, lower-case, or a plain error naming the variable. */
function panelHost(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed.protocol !== "https:" || parsed.hostname === "") {
    throw new OpsCrewError("INVALID_INPUT", `${HOSTING_URL_VAR} isn't a panel's address.`, {
      hint: `Set ${HOSTING_URL_VAR} to your panel's address, such as https://panel.example.com:2083: it must start with https://.`,
    });
  }
  return normalizeHostName(parsed.hostname);
}

/** The panel a `Server` header names, or `undefined`. */
function namedPanel(server: string | null): HostingPanelKind | undefined {
  if (server === null) return undefined;
  return SERVER_HEADERS.find((entry) => entry.pattern.test(server))?.kind;
}

/**
 * Which panel answers at the address's host, without asking (plan 7): each of cPanel's 2083,
 * Plesk's 8443 and DirectAdmin's 2222 is asked for `/` (only the address's own port when it names
 * one). A panel that names itself in its `Server` header wins; otherwise the first port that
 * answers at all gives its panel. Answers the panel's kind and the address OpsCrew reaches it on,
 * `https://<host>:<port>`.
 */
export async function findPanel(
  url: string,
  fetch: FetchLike,
): Promise<{ kind: HostingPanelKind; url: string }> {
  const host = panelHost(url);
  const own = new URL(url).port;
  const ports =
    own === ""
      ? PANEL_PORTS
      : [
          PANEL_PORTS.find((entry) => String(entry.port) === own) ?? {
            port: Number(own),
            kind: undefined,
          },
        ];
  const answers = await Promise.all(
    ports.map(async ({ port, kind }) => {
      const address = `https://${host}:${port}`;
      try {
        const response = await fetch(`${address}/`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await response.body?.cancel();
        return { address, kind, named: namedPanel(response.headers.get("server")) };
      } catch {
        return undefined;
      }
    }),
  );
  const answered = answers.filter((answer) => answer !== undefined);
  const named = answered.find((answer) => answer.named !== undefined);
  if (named?.named !== undefined) return { kind: named.named, url: named.address };
  const first = answered.find((answer) => answer.kind !== undefined);
  if (first?.kind !== undefined) return { kind: first.kind, url: first.address };
  const tried = ports.map(({ port }) => String(port));
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    answered.length === 0
      ? `No control panel answered at ${host} on port ${orText(tried)}.`
      : `The panel at ${host} doesn't say whether it is cPanel, Plesk or DirectAdmin.`,
    {
      hint: `Check ${HOSTING_URL_VAR}: it is your panel's address, such as https://panel.example.com:2083 for cPanel, :8443 for Plesk or :2222 for DirectAdmin. If it is right, check that this computer can reach it, then try again.`,
    },
  );
}

/** The connector of the panel `kind` at `access.url`. */
export function panelConnector(
  kind: HostingPanelKind,
  access: HostingPanelAccess,
  deps: Pick<PhaseDeps, "fetch" | "redactor">,
): HostingPanel {
  const options = { fetch: deps.fetch, redactor: deps.redactor };
  switch (kind) {
    case "cpanel":
      return new CpanelPanel(access, options);
    case "plesk":
      return new PleskPanel(access, options);
    case "directadmin":
      return new DirectAdminPanel(access, options);
  }
}

/**
 * The account's panel from the environment: the panel and address `recorded` (the interview's
 * record), else the one {@link findPanel} finds. A record of another host or user stops: what
 * OpsCrew made is on that account.
 */
export async function connectPanel(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor">,
  recorded?: HostingPanelRecord,
): Promise<{ panel: HostingPanel; url: string; user: string }> {
  const access = panelAccess(deps.env, deps.redactor);
  if (
    recorded !== undefined &&
    (panelHost(recorded.url) !== panelHost(access.url) || recorded.user !== access.user)
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${HOSTING_URL_VAR} and ${HOSTING_USER_VAR} name another account than the one OpsCrew recorded for this app (${recorded.user} at ${panelHost(recorded.url)}).`,
      {
        hint: "Set them back to that account, or run `opscrew interview` to choose the new one.",
      },
    );
  }
  const found = recorded ?? (await findPanel(access.url, deps.fetch));
  return {
    panel: panelConnector(found.kind, { ...access, url: found.url }, deps),
    url: found.url,
    user: access.user,
  };
}

/**
 * Where the account's files are written: the panel itself when its API writes files (`writeFile`
 * in its `operations`). Otherwise `undefined`: the file steps are steps the user takes in the
 * panel (`panel.panelStep`), until the SFTP connector (`@opscrew/connector-sftp`) writes them over
 * SFTP when `OPSCREW_SFTP_*` are set.
 */
export function hostingFiles(panel: HostingPanel): HostingFiles | undefined {
  return panel.operations.has("writeFile") ? panel : undefined;
}
