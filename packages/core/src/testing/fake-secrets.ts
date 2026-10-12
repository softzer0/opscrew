import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Kinds of secret-shaped test values. Values are generated at runtime so that no secret-shaped
 * literal is ever committed (avoids GitHub push protection and secret-scanning noise), and every
 * value contains the marker `FAKE` so a human can tell it is synthetic.
 */
export const FAKE_SECRET_KINDS = [
  "github-token",
  "github-pat",
  "anthropic-key",
  "openai-key",
  "aws-access-key-id",
  "aws-secret-access-key",
  "stripe-live-key",
  "slack-bot-token",
  "google-api-key",
  "supabase-service-role-jwt",
  "supabase-anon-jwt",
  "private-key-pem",
  "hcloud-token",
  "cloudflare-token",
  "digitalocean-token",
  "generic-password",
] as const;
export type FakeSecretKind = (typeof FAKE_SECRET_KINDS)[number];

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BASE64 = `${ALNUM}+/`;
const BASE64URL = `${ALNUM}-_`;
const DIGITS = "0123456789";
const HEX = "0123456789abcdef";

/** Deterministic pseudo-random string that starts with `FAKE` when the alphabet allows it. */
function filler(seed: string, length: number, alphabet: string = ALNUM): string {
  const prefix = [..."FAKE"].every((c) => alphabet.includes(c)) ? "FAKE" : "";
  let out = prefix;
  let counter = 0;
  while (out.length < length) {
    const block = createHash("sha256").update(`${seed}:${counter++}`).digest();
    for (const byte of block) {
      if (out.length >= length) break;
      out += alphabet[byte % alphabet.length];
    }
  }
  return out.slice(0, length);
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fakeJwt(role: "service_role" | "anon", seed: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "supabase",
      ref: "fakeprojectref00",
      role,
      iat: 1700000000,
      exp: 2000000000,
    }),
  );
  return `${header}.${payload}.${filler(`${seed}:sig`, 43, BASE64URL)}`;
}

/**
 * Returns a synthetic, obviously fake value of the given kind that still matches the detection
 * and redaction rules for that kind. Same `kind` + `seed` → same value.
 */
export function fakeSecret(kind: FakeSecretKind, seed = "opscrew"): string {
  const s = `${kind}:${seed}`;
  switch (kind) {
    case "github-token":
      return `ghp_${filler(s, 36)}`;
    case "github-pat":
      return `github_pat_${filler(`${s}:a`, 22)}_${filler(`${s}:b`, 59)}`;
    case "anthropic-key":
      return `sk-ant-api03-${filler(s, 93, BASE64URL)}AA`;
    case "openai-key":
      return `sk-proj-${filler(s, 48, BASE64URL)}`;
    case "aws-access-key-id":
      return `AKIA${filler(s, 16, UPPER_DIGITS)}`;
    case "aws-secret-access-key":
      return filler(s, 40, BASE64);
    case "stripe-live-key":
      return `sk_live_${filler(s, 24)}`;
    case "slack-bot-token":
      return `xoxb-${filler(`${s}:a`, 11, DIGITS)}-${filler(`${s}:b`, 12, DIGITS)}-${filler(`${s}:c`, 24)}`;
    case "google-api-key":
      return `AIza${filler(s, 35, BASE64URL)}`;
    case "supabase-service-role-jwt":
      return fakeJwt("service_role", s);
    case "supabase-anon-jwt":
      return fakeJwt("anon", s);
    case "private-key-pem": {
      const body =
        filler(s, 1216, BASE64)
          .match(/.{1,64}/g)
          ?.join("\n") ?? "";
      return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    }
    case "hcloud-token":
      return filler(s, 64);
    case "cloudflare-token":
      return filler(s, 40, BASE64URL);
    // Lower-case hex cannot spell FAKE; the `dop_v1_` prefix still marks it as a DigitalOcean token.
    case "digitalocean-token":
      return `dop_v1_${filler(s, 64, HEX)}`;
    case "generic-password":
      return `FakeP4ss-${filler(s, 16)}`;
  }
}

const MARKER = /\{\{FAKE:([a-z0-9-]+)(?::([A-Za-z0-9_-]+))?\}\}/g;

/** Replaces `{{FAKE:<kind>}}` and `{{FAKE:<kind>:<seed>}}` markers with generated fake secrets. */
export function expandFakeSecrets(text: string): string {
  return text.replace(MARKER, (match, kind: string, seed: string | undefined) => {
    if (!(FAKE_SECRET_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Unknown fake secret kind in fixture marker: ${match}`);
    }
    return fakeSecret(kind as FakeSecretKind, seed ?? "opscrew");
  });
}

/**
 * Copies a fixture directory to `destDir`, expanding fake-secret markers in every text file.
 * A file named `*.fixture` is written without that suffix, so fixtures can contain files such as
 * `.env.fixture` → `.env` or `.gitignore.fixture` → `.gitignore` that tooling would otherwise
 * treat specially inside this repository.
 */
export async function materializeFixture(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const entry of await readdir(srcDir)) {
    const from = join(srcDir, entry);
    const target = join(
      destDir,
      entry.endsWith(".fixture") ? entry.slice(0, -".fixture".length) : entry,
    );
    if ((await stat(from)).isDirectory()) {
      await materializeFixture(from, target);
      continue;
    }
    const buffer = await readFile(from);
    const isText = !buffer.subarray(0, 8000).includes(0);
    await writeFile(target, isText ? expandFakeSecrets(buffer.toString("utf8")) : buffer);
  }
}
