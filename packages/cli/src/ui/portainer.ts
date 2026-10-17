import {
  CHECK_PORTAINER_CERTIFICATE,
  type ConfirmPortainerCertificate,
  createPortainerAccess,
  NEW_CERTIFICATE_WARNING,
  type PortainerInterviewOptions,
} from "@opscrew/agents";
import { normalizeCertFingerprint } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import type { CliContext } from "../context";
import { servicesOf } from "../deps";
import type { UiPrompts } from "./prompts";

/** Help text of `--portainer-cert <fingerprint>`. */
export const PORTAINER_CERT_DESCRIPTION =
  "Your existing Portainer: trust this certificate fingerprint (SHA256:…) on the first connection, for scripts; check it first";

/**
 * `--portainer-cert` checked before anything runs: a SHA-256 fingerprint in any spelling the
 * adapter accepts (hex with or without colons, or base64). Returns the canonical form.
 */
export function checkPortainerCert(value: string | undefined): string | undefined {
  const given = value?.trim();
  if (given === undefined) return undefined;
  const fingerprint = normalizeCertFingerprint(given);
  if (fingerprint === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--portainer-cert expects the SHA-256 fingerprint of Portainer's certificate: SHA256: followed by 64 hex characters (with or without colons) or the base64 form.",
      { hint: CHECK_PORTAINER_CERTIFICATE },
    );
  }
  return fingerprint;
}

/**
 * Asks the user in the terminal to trust Portainer's certificate: shows its fingerprint (and the
 * one pinned before, when it changed) and how to check it. Declining or cancelling trusts nothing.
 */
function terminalCertificateConfirmation(
  ctx: CliContext,
  prompts: UiPrompts,
): ConfirmPortainerCertificate {
  return async ({ fingerprint, previous }) => {
    ctx.stdout(
      [
        "",
        previous === undefined
          ? "Your Portainer presents this certificate (SHA-256 fingerprint):"
          : "Your Portainer's certificate has changed. OpsCrew pinned this one before:",
        ...(previous === undefined ? [] : [`    ${previous}`, "It now presents:"]),
        `    ${fingerprint}`,
        "",
        CHECK_PORTAINER_CERTIFICATE,
        ...(previous === undefined ? [] : [NEW_CERTIFICATE_WARNING]),
        "",
      ].join("\n"),
    );
    const answer = await prompts.confirm({
      message: "Trust this certificate and send the access token to your Portainer?",
      initialValue: false,
    });
    return !prompts.isCancel(answer) && answer === true;
  };
}

/**
 * The interview's Portainer options: the adapter, the terminal confirmation when a person can
 * answer, and the fingerprint from `--portainer-cert` (scripts).
 */
export function portainerInterviewOptions(
  ctx: CliContext,
  prompts: UiPrompts,
  certFingerprint: string | undefined,
): PortainerInterviewOptions {
  return {
    access: servicesOf(ctx).portainerAccess ?? createPortainerAccess({ redactor: ctx.redactor }),
    ...(ctx.isInteractive
      ? { confirmCertificate: terminalCertificateConfirmation(ctx, prompts) }
      : {}),
    ...(certFingerprint === undefined ? {} : { certFingerprint }),
  };
}
