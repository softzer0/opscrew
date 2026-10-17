import {
  PORTAINER_TOKEN_STEPS,
  PortainerApiError,
  PortainerCertificateError,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEndpoint,
  portainerClient,
} from "@opscrew/connector-portainer";
import { isUserFacingError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { hasEnv } from "../domain/registrars";
import { PORTAINER_TOKEN_VAR } from "../providers";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import { REGISTRY_TOKEN_HINT, REPOSITORY_TOKEN_HINT } from "../provision/stack-plan";
import { hidePortainerAddress } from "../shared";
import { type PortainerConnection, readPortainerConnection } from "../shared/server-record";
import { type CheckResult, failFrom } from "./check-result";

/** Makes the Portainer client of the init check (default: the adapter's pinned `portainerClient`). */
export type InitPortainerClient = (
  endpoint: PortainerEndpoint,
  token: string,
  deps: PortainerClientDeps,
) => Pick<PortainerClient, "currentUser">;

/** Where the Portainer target was read from, for the messages. */
export type PortainerSource = "plan" | "requirements";

/** What the Portainer checks share: the recorded connection, read once. */
export interface PortainerRecord {
  /** The connection, `undefined` when none is recorded, or the plain error of a damaged record. */
  connection?: PortainerConnection;
  problem?: CheckResult;
}

const TOKEN_FIX = `${PORTAINER_TOKEN_STEPS}, then set ${PORTAINER_TOKEN_VAR} to it. OpsCrew reads it only from this environment variable and never saves it.`;

const INTERVIEW_FIX =
  "Run `opscrew interview` and answer the Portainer questions: its address, its certificate's fingerprint (OpsCrew shows it for you to confirm) and the environment to deploy to.";

/**
 * Reads the Portainer connection the interview recorded in `.opscrew/server.json` and registers
 * Portainer's address with the redactor, so no check shows it. A damaged record becomes a plain
 * failure.
 */
export async function readPortainerRecord(deps: PhaseDeps): Promise<PortainerRecord> {
  try {
    const connection = await readPortainerConnection(deps.paths);
    if (connection !== undefined) hidePortainerAddress(deps.redactor, connection.url);
    return { connection };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { problem: failFrom(error) };
  }
}

/**
 * The "Your Portainer" check: the recorded connection and its pinned certificate, the access token
 * in `PORTAINER_API_KEY`, and (unless `offline`) one read-only call through the pinned client that
 * confirms Portainer accepts the token. Never shows Portainer's address or the token.
 */
export async function checkPortainer(
  deps: PhaseDeps,
  offline: boolean,
  source: PortainerSource,
  record: PortainerRecord,
  makeClient: InitPortainerClient = portainerClient,
): Promise<CheckResult> {
  if (record.problem !== undefined) return record.problem;
  const { connection } = record;
  const deploysTo = source === "plan" ? "The plan deploys" : "Your interview answers deploy";
  if (connection === undefined) {
    return {
      status: "fail",
      message: `${deploysTo} to your Portainer, but OpsCrew does not know how to reach your Portainer on this computer (no address or confirmed certificate is recorded).`,
      fix: INTERVIEW_FIX,
    };
  }
  const https = new URL(connection.url).protocol === "https:";
  if (https && connection.certFingerprint === undefined) {
    return {
      status: "fail",
      message:
        "Portainer's certificate has not been confirmed yet, so OpsCrew does not connect to your Portainer.",
      fix: INTERVIEW_FIX,
    };
  }
  const token = deps.env[PORTAINER_TOKEN_VAR]?.trim();
  if (token === undefined || token === "") {
    return {
      status: "fail",
      message: `${PORTAINER_TOKEN_VAR} is not set, and OpsCrew needs it to deploy the app as stacks in your Portainer.`,
      fix: TOKEN_FIX,
    };
  }
  deps.redactor.addLiteral(token, PORTAINER_TOKEN_VAR);
  const pin = https
    ? "Portainer's certificate is pinned; a different certificate stops every command."
    : "Portainer runs on this computer and is reached over plain HTTP (no certificate to pin).";
  const environment = `OpsCrew deploys to the environment ${connection.environmentName} (${connection.environmentId}).`;
  if (offline) {
    return {
      status: "pass",
      message: `${PORTAINER_TOKEN_VAR} is set (offline: only checked that it is set, not that it works). ${pin} ${environment}`,
    };
  }
  let role: "admin" | "user";
  try {
    const client = makeClient(
      { url: connection.url, certFingerprint: connection.certFingerprint },
      token,
      { redactor: deps.redactor },
    );
    role = (await client.currentUser()).role;
  } catch (error) {
    if (error instanceof PortainerCertificateError) return failFrom(error);
    if (error instanceof PortainerApiError && error.status === 401) {
      return {
        status: "fail",
        message: `Portainer rejected the access token in ${PORTAINER_TOKEN_VAR} (HTTP 401).`,
        fix: TOKEN_FIX,
      };
    }
    if (!isUserFacingError(error)) throw error;
    return failFrom(
      error,
      `OpsCrew could not check ${PORTAINER_TOKEN_VAR} with your Portainer: ${error.message}`,
    );
  }
  const whose = role === "admin" ? "an administrator's token" : "a limited user's token";
  return {
    status: "pass",
    message: `${PORTAINER_TOKEN_VAR} works (${whose}). ${pin} ${environment}`,
  };
}

/**
 * The optional check of the read-only GitHub tokens Portainer pulls with: `OPSCREW_GHCR_READ_TOKEN`
 * for the app's image (private unless the user said it is public, recorded as `publicImage`) and
 * `OPSCREW_REPO_READ_TOKEN` for a repository known to be private (`repoPrivate`; `undefined` when
 * it could not be read). Missing ones only warn, with how to create them.
 */
export function checkPortainerTokens(
  deps: PhaseDeps,
  record: PortainerRecord,
  repoPrivate: boolean | undefined,
): CheckResult {
  const env = deps.env;
  const publicImage = record.connection?.publicImage === true;
  const notes: string[] = [];
  const missing: string[] = [];
  const fixes: string[] = [];
  if (publicImage) {
    notes.push("The app's image is public, so Portainer needs no registry token.");
  } else if (hasEnv(env, REGISTRY_TOKEN_VAR)) {
    notes.push(`${REGISTRY_TOKEN_VAR} is set for the app's private image.`);
  } else {
    missing.push(
      `${REGISTRY_TOKEN_VAR} (the app's image on GitHub Container Registry is private by default)`,
    );
    fixes.push(REGISTRY_TOKEN_HINT);
  }
  if (repoPrivate === true) {
    if (hasEnv(env, REPOSITORY_TOKEN_VAR)) {
      notes.push(`${REPOSITORY_TOKEN_VAR} is set for the private repository.`);
    } else {
      missing.push(`${REPOSITORY_TOKEN_VAR} (the repository is private)`);
      fixes.push(REPOSITORY_TOKEN_HINT);
    }
  } else if (repoPrivate === false) {
    notes.push("The repository is public, so Portainer needs no repository token.");
  }
  if (missing.length === 0) return { status: "pass", message: notes.join(" ") };
  const known = notes.length > 0 ? ` ${notes.join(" ")}` : "";
  return {
    status: "warn",
    message: `Portainer needs ${missing.length > 1 ? "read-only GitHub tokens that are" : "a read-only GitHub token that is"} not set yet: ${missing.join(" and ")}. \`opscrew provision\` stops without ${missing.length > 1 ? "them" : "it"}.${known}`,
    fix: `${fixes.join(" ")} Set ${missing.length > 1 ? "them" : "it"} before you run \`opscrew provision\`.`,
  };
}
