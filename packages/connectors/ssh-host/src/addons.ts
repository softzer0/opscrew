/**
 * Shared by the add-on planner and the apply: the refusal when another app has the add-on, and
 * the check key's fingerprint.
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
  const what =
    kind === "beszel"
      ? "Beszel already shows every container on this server."
      : "Its Alloy already sends this server's metrics.";
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
 * An unencrypted OpenSSH private key's shape (Beszel's hub key): its armour lines around base64.
 * The key itself is not parsed.
 */
export function isOpensshPrivateKey(text: string): boolean {
  return /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END OPENSSH PRIVATE KEY-----\r?\n?$/.test(
    text,
  );
}

/** OpenSSH's SHA-256 fingerprint of a public key (`<type> <base64> [comment]`): `SHA256:…`. */
export function keyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
