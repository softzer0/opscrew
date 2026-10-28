/**
 * Shared by the add-on planner and the apply: the refusal when another app has the add-on, and
 * the Ed25519 and OpenSSH key helpers (the Beszel hub's key, the check key's fingerprint).
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import type { AddonKind } from "./constants";

/** The add-on's name as users know it, and its `opscrew addon` name. */
const ADDON_NAMES: Readonly<Record<AddonKind, { name: string; command: string }>> = {
  beszel: { name: "Beszel", command: "beszel" },
  alloy: { name: "Grafana Cloud (Grafana Alloy)", command: "grafana-cloud" },
};

/**
 * The refusal when `owner`, another app on the server, turned the add-on on: a server has one of
 * each, and it stays with that app.
 */
export function addonTaken(kind: AddonKind, owner: string): OpsCrewError {
  const { name, command } = ADDON_NAMES[kind];
  const what =
    kind === "beszel"
      ? "Beszel already shows every container on this server."
      : "Its Alloy already sends this server's metrics.";
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${name} is already on this server for the app "${owner}", and a server has only one, so OpsCrew changes nothing.`,
    {
      hint: `${what} To move it to this app, run \`opscrew addon disable ${command}\` in the project of "${owner}" first, then run this command again.`,
    },
  );
}

/** An OpenSSH string field: its length (4 bytes, big-endian), then its bytes. */
function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * The OpenSSH public key line (`ssh-ed25519 <base64>`) of an Ed25519 private key in PKCS #8 PEM
 * form; undefined for anything else.
 */
export function ed25519PublicKey(pem: string): string | undefined {
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    const { x } = createPublicKey(key).export({ format: "jwk" });
    if (x === undefined) return undefined;
    const blob = Buffer.concat([
      sshString(Buffer.from("ssh-ed25519")),
      sshString(Buffer.from(x, "base64url")),
    ]);
    return `ssh-ed25519 ${blob.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** OpenSSH's SHA-256 fingerprint of a public key (`<type> <base64> [comment]`): `SHA256:…`. */
export function keyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
