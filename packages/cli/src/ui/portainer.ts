import type {
  ConfirmPortainerCertificate,
  PortainerAccess,
  PortainerInterviewOptions,
} from "@opscrew/agents";
import { normalizeCertFingerprint } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import { createPortainerAccess, hidePortainerAddress } from "@opscrew/mcp-server";
import type { CliContext } from "../context";
import { deployServicesOf } from "./deploy-services";
import type { UiPrompts } from "./prompts";

/** Help text of `--portainer-cert <fingerprint>`. */
export const PORTAINER_CERT_DESCRIPTION =
  "Your existing Portainer: trust this certificate fingerprint (SHA256:…) on the first connection, for scripts; check it first";

/** How to check a certificate fingerprint before trusting it (no address in it). */
export const CHECK_CERTIFICATE =
  "Check it before you trust it: in your browser open Portainer, click the padlock and view the certificate's SHA-256 fingerprint, or run `openssl s_client -connect <host>:<port> </dev/null | openssl x509 -noout -fingerprint -sha256` on the Portainer host itself.";

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
      { hint: CHECK_CERTIFICATE },
    );
  }
  return fingerprint;
}

/**
 * How the CLI reaches the user's Portainer for the interview: the attached fake (tests) or the
 * adapter, with Portainer's address registered with the redactor before anything is sent, so the
 * terminal never shows it.
 */
export function portainerAccessFor(ctx: CliContext): PortainerAccess {
  const base =
    deployServicesOf(ctx).portainerAccess ?? createPortainerAccess({ redactor: ctx.redactor });
  return {
    fetchCertificateFingerprint: async (url) => {
      hidePortainerAddress(ctx.redactor, url);
      return base.fetchCertificateFingerprint(url);
    },
    listEnvironments: async (url, token, certFingerprint) => {
      hidePortainerAddress(ctx.redactor, url);
      return base.listEnvironments(url, token, certFingerprint);
    },
  };
}

/**
 * Asks the user in the terminal to trust Portainer's certificate: shows its fingerprint (and the
 * one pinned before, when it changed) and how to check it. Declining or cancelling trusts nothing.
 */
export function terminalCertificateConfirmation(
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
        CHECK_CERTIFICATE,
        ...(previous === undefined
          ? []
          : [
              "Trust the new one only if you changed Portainer's certificate yourself; otherwise someone may be intercepting the connection.",
            ]),
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
    access: portainerAccessFor(ctx),
    ...(ctx.isInteractive
      ? { confirmCertificate: terminalCertificateConfirmation(ctx, prompts) }
      : {}),
    ...(certFingerprint === undefined ? {} : { certFingerprint }),
  };
}
