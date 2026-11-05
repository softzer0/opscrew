/**
 * Shared by the add-on planner and the apply: the refusal when another app has the add-on, when
 * its owner counts as gone, and the check key's fingerprint.
 */
import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { ADDON_NAMES, type AddonKind } from "./constants";

/**
 * The refusal when `owner`, another app, turned the add-on on: a server has one of each, and it
 * stays with that app. `gone`: that app is no longer set up on the server, so turning the add-on
 * off from this project is allowed (and the hint says so).
 */
export function addonTaken(kind: AddonKind, owner: string, gone: boolean): OpsCrewError {
  const { name, command } = ADDON_NAMES[kind];
  const what = {
    beszel: "Beszel already shows every container on this server.",
    alloy: "Its Alloy already sends this server's metrics.",
    monitoring: "Its Prometheus, Loki and Grafana already keep the figures and logs sent here.",
  }[kind];
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${name} is already on this server for the app "${owner}", and a server has only one, so OpsCrew changes nothing.`,
    {
      hint: gone
        ? `"${owner}" is no longer set up on this server. Run \`opscrew addon disable ${command}\` in this project to remove what it left, then run this command again.`
        : `${what} To move it to this app, run \`opscrew addon disable ${command}\` in the project of "${owner}" first, then run this command again.`,
    },
  );
}

/**
 * `owner`, the app that turned the add-on on, is no longer set up on the server (`apps`, the host
 * record's), so another app may turn the add-on off. Never for the monitoring stack: a monitoring
 * server sets up no app at all, and the stack and its data stay its owner's only.
 */
export function ownerGone(kind: AddonKind, owner: string, apps: readonly string[]): boolean {
  return kind !== "monitoring" && !apps.includes(owner);
}

/**
 * An unencrypted OpenSSH private key's shape (Beszel's hub key): its armour lines around base64.
 * The key itself is not parsed.
 */
export function isOpensshPrivateKey(text: string): boolean {
  return /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END OPENSSH PRIVATE KEY-----\r?\n?$/.test(
    text,
  );
}

/** PEM text within 16 KiB: `blocks` armoured as `label` around base64. Not parsed further. */
function isPem(text: string, label: string, blocks: "one" | "some"): boolean {
  const block = `-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ${label}-----\\r?\\n?`;
  return (
    text.length <= 16 * 1024 &&
    new RegExp(blocks === "one" ? `^${block}$` : `^(?:${block})+$`).test(text)
  );
}

/** A PEM certificate (with any chain after it), as Cloudflare's Origin CA issues it. */
export function isPemCertificate(text: string): boolean {
  return isPem(text, "CERTIFICATE", "some");
}

/** A PEM private key: PKCS #8 (`PRIVATE KEY`), or an `EC` or `RSA` one. */
export function isPemPrivateKey(text: string): boolean {
  return ["PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"].some((label) =>
    isPem(text, label, "one"),
  );
}

/** OpenSSH's SHA-256 fingerprint of a public key (`<type> <base64> [comment]`): `SHA256:…`. */
export function keyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
