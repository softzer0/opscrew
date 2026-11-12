import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Release signatures as GitHub Actions makes them and the agent checks them (ADR 0030 D4), with a
 * throwaway ECDSA P-256 key made by openssl for each test: the test vector T2704's agent and
 * T2705's workflow share.
 * - message: `<tree id> <run id> <attempt> <env>`, single spaces, no newline;
 * - signature: `openssl dgst -sha256 -sign <key>` over the message (DER), base64 on one line;
 * - the commit's line: `OpsCrew-Release: <run id> <attempt> <env> <signature>`;
 * - the agent's check: `openssl dgst -sha256 -verify keys/release.pub -signature <file>`.
 */

/** Runs openssl; throws with its output when it fails. */
function openssl(args: string[]): void {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

/** A new ECDSA P-256 key pair in `dir`: the private key's PEM file and the public key's. */
export function releaseKeyPair(dir: string, name = "release"): { key: string; pub: string } {
  const key = join(dir, `${name}.key`);
  const pub = join(dir, `${name}.pub`);
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
  openssl(["pkey", "-in", key, "-pubout", "-out", pub]);
  return { key, pub };
}

/** The signed message of a release. */
export function releaseMessage(tree: string, run: number, attempt: number, env: string): string {
  return `${tree} ${run} ${attempt} ${env}`;
}

/** `message` signed with the private key file `key` as the workflow signs it, base64 on one line. */
export function signRelease(dir: string, key: string, message: string): string {
  const input = join(dir, "release.message");
  const output = join(dir, "release.signature");
  writeFileSync(input, message);
  openssl(["dgst", "-sha256", "-sign", key, "-out", output, input]);
  return readFileSync(output).toString("base64");
}

/** Whether `signature` (base64) verifies over `message` with the public key file `pub`, as the agent checks. */
export function verifyRelease(dir: string, pub: string, message: string, signature: string): boolean {
  const input = join(dir, "verify.message");
  const sig = join(dir, "verify.signature");
  writeFileSync(input, message);
  writeFileSync(sig, Buffer.from(signature, "base64"));
  const result = spawnSync("openssl", ["dgst", "-sha256", "-verify", pub, "-signature", sig, input], {
    encoding: "utf8",
  });
  return result.status === 0;
}

/** The release commit's line the agent reads. */
export function releaseTrailer(run: number, attempt: number, env: string, signature: string): string {
  return `OpsCrew-Release: ${run} ${attempt} ${env} ${signature}`;
}
