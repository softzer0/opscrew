/**
 * `opscrew init` for an app on a hosting account (feature 027, ADR 0030 D1): the variables that
 * reach its panel (`OPSCREW_HOSTING_*`) or an SFTP-only host (`OPSCREW_SFTP_*`), and where OpsCrew
 * reaches the account's files over SFTP (an SFTP host, a Plesk account) the `sftp` and
 * `ssh-keyscan` binaries. Nothing is called over the network: `opscrew interview` finds the panel
 * and reads the account.
 */
import { isUserFacingError, listText } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  HOSTING_TOKEN_VAR,
  HOSTING_URL_VAR,
  HOSTING_USER_VAR,
  HOSTING_VARS_HINT,
  hostingReach,
  PANEL_VARS,
  panelHost,
  SFTP_HOST_VAR,
  SFTP_KEY_VAR,
  SFTP_USER_VAR,
  SFTP_VARS,
  unsetVars,
} from "../hosting/panels";
import { sftpLogin } from "../hosting/sftp";
import { requireOwnServerKey } from "../shared/own-server";
import { type CheckResult, failFrom } from "./check-result";

type Env = Record<string, string | undefined>;

/** How the app reaches its hosting account: through the panel's API, or over SFTP alone. */
type HostingReach = ReturnType<typeof hostingReach>;

const PANEL_FIX = `Set ${HOSTING_URL_VAR} to your panel's address (such as https://panel.example.com:2083), ${HOSTING_USER_VAR} to the account's user and ${HOSTING_TOKEN_VAR} to an API token: cPanel's from Security → Manage API Tokens, Plesk's API key, or DirectAdmin's login key. OpsCrew reads the token only from this variable and never saves it.`;

const SFTP_FIX = `Set ${SFTP_HOST_VAR} to your host's address, ${SFTP_USER_VAR} to your SFTP user and ${SFTP_KEY_VAR} to the path of your SSH key file (never the key itself), such as ~/.ssh/id_ed25519.`;

/**
 * How the target reaches the account: the plan's panel (`sftp` or one with an API), else, before
 * design, the variables that are set (`undefined` when neither set is complete).
 */
export function hostingReachOf(plan: DeployPlan | undefined, env: Env): HostingReach {
  if (plan?.target.provider === "hosting") return plan.target.panel === "sftp" ? "sftp" : "panel";
  return hostingReach(env);
}

/**
 * The provider check for a hosting account: the panel's three variables (its address an
 * `https://` one), or the SFTP host's three with its key file on this computer. Before design,
 * with neither set complete, it fails naming both.
 */
export async function checkHostingAccount(
  env: Env,
  reach: HostingReach,
  deploysTo: string,
): Promise<CheckResult> {
  if (reach === undefined) {
    return {
      status: "fail",
      message: `${deploysTo} to a hosting account, but its variables aren't set.`,
      fix: HOSTING_VARS_HINT,
    };
  }
  if (reach === "panel") {
    const missing = unsetVars(env, PANEL_VARS);
    if (missing.length > 0) {
      return {
        status: "fail",
        message: `${deploysTo} to a hosting account with a panel, but ${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set.`,
        fix: PANEL_FIX,
      };
    }
    try {
      panelHost((env[HOSTING_URL_VAR] ?? "").trim());
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      return failFrom(error);
    }
    return {
      status: "pass",
      message: `${listText(PANEL_VARS)} are set. \`opscrew interview\` finds the panel (cPanel, Plesk or DirectAdmin) and reads the account; nothing on it changes before your approval.`,
    };
  }
  const missing = unsetVars(env, SFTP_VARS);
  if (missing.length > 0) {
    return {
      status: "fail",
      message: `${deploysTo} to a host you reach over SFTP, but ${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set.`,
      fix: SFTP_FIX,
    };
  }
  try {
    await requireOwnServerKey(
      { agent: false, keyPath: sftpLogin(env)?.keyFile ?? "" },
      env,
      undefined,
      {
        noun: "your SFTP host",
        missingKey: `Set ${SFTP_KEY_VAR} to the path of the key file your host accepts.`,
      },
    );
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return failFrom(error);
  }
  return {
    status: "pass",
    message: `${listText(SFTP_VARS)} are set and the key file is on this computer. \`opscrew interview\` reads the host's key for you to confirm.`,
  };
}

/**
 * The tools check for a hosting account: `sftp` and `ssh-keyscan` where OpsCrew reaches the
 * account's files over SFTP (the interview reads the host's key, provision uploads over SFTP): an
 * SFTP host, and a Plesk account, whose API can't write files. cPanel's and DirectAdmin's accounts
 * need neither; before design names the panel, missing tools only warn.
 */
export function checkHostingTools(
  which: (name: string) => string | undefined,
  reach: HostingReach,
  plan: DeployPlan | undefined,
): CheckResult {
  const panel = plan?.target.provider === "hosting" ? plan.target.panel : undefined;
  if (reach === "panel" && panel !== undefined && panel !== "plesk") {
    return {
      status: "skip",
      message:
        "Not needed: OpsCrew changes your hosting account through its panel's API and never connects over SSH.",
    };
  }
  const missing = ["sftp", "ssh-keyscan"].filter((name) => which(name) === undefined);
  if (missing.length === 0) return { status: "pass", message: "sftp and ssh-keyscan found." };
  const tools = `${listText(missing)} ${missing.length === 1 ? "is" : "are"} not installed`;
  const them = missing.length === 1 ? "it" : "them";
  const fix =
    "Install the OpenSSH client: Windows: Settings → System → Optional features → OpenSSH Client; Debian/Ubuntu: `sudo apt install openssh-client`; macOS includes it.";
  if (reach === "panel" && panel === undefined) {
    return {
      status: "warn",
      message: `${tools}. A Plesk account needs ${them}, as OpsCrew writes its files over SFTP; cPanel and DirectAdmin don't.`,
      fix,
    };
  }
  return {
    status: "fail",
    message:
      panel === "plesk"
        ? `${tools}, and OpsCrew writes a Plesk account's files over SFTP, which needs ${them}.`
        : `${tools}, and a host you reach over SFTP needs ${them}.`,
    fix,
  };
}
