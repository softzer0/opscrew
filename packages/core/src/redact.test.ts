import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_RULES,
  maskSecret,
  Redactor,
  registerEnvSecrets,
  SECRET_ENV_NAMES,
  shannonEntropy,
} from "./redact";
import { expandFakeSecrets, fakeSecret } from "./testing";

// No secret-shaped literal may live on disk (GitHub push protection). Every secret-like value in
// this file is assembled at runtime from harmless pieces or generated with `fakeSecret()`.
const F = "FAKE";
const fake = (prefix: string, body: string) => `${prefix}${body}`;
const GITHUB = fake("ghp_", `${F.repeat(8)}0000`);
const ANTHROPIC = fake("sk-ant-api03-", F.repeat(10));
const PRIVATE_KEY = ["PRIVATE", "KEY"].join(" ");

function pem(type: string, body: readonly string[], eol = "\n"): string {
  const label = type === "" ? PRIVATE_KEY : `${type} ${PRIVATE_KEY}`;
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join(eol);
}

/** Values for `{{LOCAL:<name>}}` fixture markers: formats `fakeSecret()` does not cover. */
const LOCAL: Record<string, string> = {
  "github-oauth": fake(["gh", "o_"].join(""), F.repeat(9)),
  "github-server": fake(
    ["gh", "s_"].join(""),
    [F, "abcdefghij", F, "abcdefghij", F, "abcd"].join(""),
  ),
  "openai-legacy": fake(["s", "k-"].join(""), F.repeat(12)),
  "aws-temp-key-id": fake(["AS", "IA"].join(""), [F, "0000", F, "0000"].join("")),
  "stripe-test": fake(["sk", "_test_"].join(""), [F, "0000"].join("").repeat(3)),
  "stripe-restricted": fake(["rk", "_live_"].join(""), [F, "1111"].join("").repeat(3)),
  "slack-user": fake(["xo", "xp-"].join(""), [F, "-0000-1111-", F, F].join("")),
  "url-password": [F, "p4ss", "w0rd", "Xq9"].join(""),
  "labelled-client-secret": [F, "cl1ent", "S3cret", "9xQ2mL7"].join(""),
  "labelled-apikey": [F, "8f3k2j", "9d0s7a6q"].join(""),
  "labelled-api-key": [F, "-k3y-", "9xQ2mL7pR4"].join(""),
  "openssh-pem": pem("OPENSSH", [`${F}b3Blbn${F}`, F.repeat(18), `${F.repeat(8)}==`])
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
  "rsa-pem-escaped": pem("RSA", [`${F}MIIEow${F}`, F.repeat(3)], "\\n"),
};

const MARKER = /\{\{(FAKE|LOCAL):([^}]+)\}\}/g;

/** Expands fixture markers and returns the text plus every secret value that was inserted. */
function expandSample(text: string): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  const expanded = text.replace(MARKER, (marker, scheme: string, name: string) => {
    const value = scheme === "FAKE" ? expandFakeSecrets(marker) : LOCAL[name];
    if (value === undefined) throw new Error(`Unknown fixture marker ${marker}`);
    secrets.push(value);
    return value;
  });
  return { text: expanded, secrets };
}

const fixtures = new URL("../test/fixtures/redaction/", import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixtures), "utf8");
}

function readSamples(name: string): string[] {
  return readFixture(name)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

describe("redaction corpus (SC-002)", () => {
  const secrets = readSamples("secrets.txt");
  const benign = readSamples("benign.txt");

  it("has at least 25 secret and 25 benign samples", () => {
    expect(secrets.length).toBeGreaterThanOrEqual(25);
    expect(benign.length).toBeGreaterThanOrEqual(25);
  });

  it.each(secrets)("masks secret sample %s", (sample) => {
    const { text, secrets: values } = expandSample(sample);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toContain("FAKE");
    const out = new Redactor().redact(text);
    expect(out).toContain("[REDACTED:");
    expect(out).not.toContain("FAKE");
    for (const value of values) expect(out).not.toContain(value);
  });

  it.each(benign)("leaves benign sample unchanged: %s", (sample) => {
    expect(sample).not.toMatch(MARKER);
    expect(new Redactor().redact(sample)).toBe(sample);
  });

  it("masks multi-line PEM private key blocks and keeps the surrounding text", () => {
    const { text, secrets: values } = expandSample(readFixture("private-key-pem.txt"));
    expect(values).toHaveLength(3);
    const out = new Redactor().redact(text);
    expect(out).not.toContain("FAKE");
    expect(out).not.toContain(PRIVATE_KEY);
    expect(out.match(/\[REDACTED:pem-private-key\]/g)).toHaveLength(3);
    expect(out).toContain("host: deploy.example.com");
    expect(out).toContain("cert_path: /etc/ssl/certs/app.crt");
  });

  it("masks a PEM block whose END line was cut off", () => {
    const block = pem("", [F.repeat(4), F.repeat(4)]);
    const truncated = `log start\n${block.slice(0, block.indexOf("-----END"))}`;
    const out = new Redactor().redact(truncated);
    expect(out).toBe("log start\n[REDACTED:pem-private-key]");
  });

  it("masks PEM blocks with CRLF line endings", () => {
    const block = pem("", [F.repeat(4)], "\r\n");
    expect(new Redactor().redact(`a\r\n${block}\r\nb`)).toBe(
      "a\r\n[REDACTED:pem-private-key]\r\nb",
    );
  });
});

describe("Redactor", () => {
  it("masks a GitHub token, an Anthropic key and a registered literal (US3 scenario 1)", () => {
    const redactor = new Redactor();
    redactor.addLiteral("FAKE-literal-hunter2-value", "HCLOUD_TOKEN");
    const input = `gh=${GITHUB} key=${ANTHROPIC} hc=FAKE-literal-hunter2-value`;
    const out = redactor.redact(input);
    expect(out).toBe(
      "gh=[REDACTED:github-token] key=[REDACTED:anthropic-api-key] hc=[REDACTED:HCLOUD_TOKEN]",
    );
  });

  it.each([
    ["github-token", fake("ghr_", "FAKE".repeat(9))],
    ["github-pat", fake("github_pat_", "FAKE_".repeat(6))],
    ["anthropic-api-key", ANTHROPIC],
    ["openai-api-key", fake("sk-", "FAKE".repeat(12))],
    ["openai-api-key", fake("sk-proj-", "FAKE-".repeat(6))],
    ["aws-access-key-id", fake("AKIA", "FAKE".repeat(4))],
    ["aws-access-key-id", fake("ASIA", "FAKE".repeat(4))],
    ["stripe-secret-key", fake("sk_live_", "FAKE".repeat(6))],
    ["stripe-secret-key", fake("sk_test_", "FAKE".repeat(6))],
    ["stripe-secret-key", fake("rk_live_", "FAKE".repeat(6))],
    ["slack-token", fake("xoxa-", "FAKE-".repeat(4))],
    ["google-api-key", fake("AIza", `${"FAKE".repeat(8)}0_-`)],
    ["jwt", fakeSecret("supabase-anon-jwt")],
  ])("labels %s matches", (id, secret) => {
    expect(new Redactor().redact(`value ${secret} end`)).toBe(`value [REDACTED:${id}] end`);
  });

  it("masks only the secret part of AWS secret assignments and URL passwords", () => {
    const r = new Redactor();
    expect(r.redact(`aws_secret_access_key=${"FAKE".repeat(10)}`)).toBe(
      "aws_secret_access_key=[REDACTED:aws-secret-access-key]",
    );
    expect(r.redact(`https://bob:${F}pw-9x!@example.com/x`)).toBe(
      "https://bob:[REDACTED:url-password]@example.com/x",
    );
    const interpolated = `db: postgres://user:${"$"}{DB_PASSWORD}@db:5432/app`;
    expect(r.redact(interpolated)).toBe(interpolated);
  });

  it("masks labelled assignments only when the value looks random", () => {
    const r = new Redactor();
    expect(r.redact(`HCLOUD_TOKEN=${fakeSecret("hcloud-token")}`)).toBe(
      "HCLOUD_TOKEN=[REDACTED:labelled-secret]",
    );
    expect(r.redact(`"password": "${[F, "p4ss!", "w0rd#Zq"].join("")}"`)).toBe(
      '"password": "[REDACTED:labelled-secret]"',
    );
    // too short
    expect(r.redact("password=FAKEshort1")).toBe("password=FAKEshort1");
    // low entropy
    expect(r.redact("token=aaaaaaaaaaaaaaaaaaaa")).toBe("token=aaaaaaaaaaaaaaaaaaaa");
    // contains a code character
    expect(r.redact("token=config.github.tokenValue")).toBe("token=config.github.tokenValue");
  });

  it("never re-redacts its own placeholders", () => {
    const r = new Redactor();
    const once = r.redact(`token: ${GITHUB}`);
    expect(once).toBe("token: [REDACTED:github-token]");
    expect(r.redact(once)).toBe(once);
  });

  it("ignores literals shorter than 8 characters", () => {
    const r = new Redactor();
    r.addLiteral("short");
    r.addLiteral("");
    expect(r.redact("a short text")).toBe("a short text");
  });

  it("masks literals and their URL-encoded form, with a default label", () => {
    const r = new Redactor();
    r.addLiteral("FAKE p@ss/word&1");
    expect(r.redact("raw=FAKE p@ss/word&1")).toBe("raw=[REDACTED:secret]");
    expect(r.redact("q=FAKE%20p%40ss%2Fword%261")).toBe("q=[REDACTED:secret]");
  });

  it("prefers the longest literal when literals overlap", () => {
    const r = new Redactor();
    r.addLiteral("FAKEabcd", "SHORT");
    r.addLiteral("FAKEabcdefgh", "LONG");
    expect(r.redact("x FAKEabcdefgh y")).toBe("x [REDACTED:LONG] y");
  });

  it("supports custom rules with a capture group", () => {
    const r = new Redactor({
      rules: [
        { id: "custom", pattern: /session=([a-z]+)/g, group: 1, validate: (s) => s !== "ok" },
      ],
    });
    expect(r.redact("session=abcdef; session=ok")).toBe("session=[REDACTED:custom]; session=ok");
  });

  it("redactDeep returns a redacted copy without mutating the input", () => {
    const r = new Redactor();
    const input = {
      message: `token ${GITHUB}`,
      count: 3,
      nested: { list: ["plain", ANTHROPIC], flag: true, none: null },
    };
    const snapshot = structuredClone(input);
    const out = r.redactDeep(input);
    expect(out).toEqual({
      message: "token [REDACTED:github-token]",
      count: 3,
      nested: { list: ["plain", "[REDACTED:anthropic-api-key]"], flag: true, none: null },
    });
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(r.redactDeep(`x ${GITHUB}`)).toBe("x [REDACTED:github-token]");
  });

  it("handles large adversarial input in linear time", () => {
    const inputs = [
      "a.b-".repeat(250_000),
      "token_token-".repeat(100_000),
      `${"x".repeat(1_000_000)}://`,
      `eyJ${"a".repeat(1_000_000)}`,
    ];
    const r = new Redactor();
    const started = Date.now();
    for (const input of inputs) expect(r.redact(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("redact can be passed around as a plain function", () => {
    const { redact } = new Redactor();
    expect(redact(GITHUB)).toBe("[REDACTED:github-token]");
  });
});

describe("DEFAULT_REDACTION_RULES", () => {
  it("has unique ids and global patterns", () => {
    const ids = DEFAULT_REDACTION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of DEFAULT_REDACTION_RULES) expect(rule.pattern.global).toBe(true);
  });
});

describe("maskSecret", () => {
  it("shows the first 4 characters of values with at least 12 characters", () => {
    expect(maskSecret("FAKEabcdefgh")).toBe("FAKE…(12 chars)");
    expect(maskSecret(GITHUB)).toBe("ghp_…(40 chars)");
  });

  it("shows only the length for short values", () => {
    expect(maskSecret("FAKEabc")).toBe("…(7 chars)");
    expect(maskSecret("")).toBe("…(0 chars)");
  });
});

describe("shannonEntropy", () => {
  it("computes bits per character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBeCloseTo(2);
  });
});

describe("registerEnvSecrets", () => {
  it("registers known secret names and suffix matches, skipping short and undefined values", () => {
    const r = new Redactor();
    const count = registerEnvSecrets(r, {
      HCLOUD_TOKEN: "FAKEhcloud01",
      TF_ENCRYPTION: "FAKE-encryption-config",
      MY_SERVICE_SECRET: "FAKEsvcsecret",
      Db_Password: "FAKEdbpassword",
      DEPLOY_PRIVATE_KEY: "FAKEprivatekey",
      SENDGRID_API_KEY: "FAKEsendgrid",
      LEGACY_PASSWD: "FAKEpasswd",
      SHORT_TOKEN: "FAKE123",
      UNSET_TOKEN: undefined,
      HOME: "/home/someone-long",
      PATH: "/usr/bin:/bin",
    });
    expect(count).toBe(7);
    expect(r.redact("FAKEhcloud01")).toBe("[REDACTED:HCLOUD_TOKEN]");
    expect(r.redact("FAKEsvcsecret")).toBe("[REDACTED:MY_SERVICE_SECRET]");
    expect(r.redact("FAKEdbpassword")).toBe("[REDACTED:Db_Password]");
    expect(r.redact("FAKE123 /home/someone-long")).toBe("FAKE123 /home/someone-long");
  });

  it("covers the documented secret variable names", () => {
    expect(SECRET_ENV_NAMES).toEqual([
      "HCLOUD_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CF_API_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DIGITALOCEAN_TOKEN",
      "OPSCREW_STATE_PASSPHRASE",
      "TF_ENCRYPTION",
    ]);
  });
});
