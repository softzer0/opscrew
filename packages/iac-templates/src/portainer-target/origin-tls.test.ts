// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation and shell syntax in expected contents, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import type { PortainerWeb } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { type RuntimeContext, renderCaddyfile } from "../runtime";
import { portainerTestPlan } from "./__fixtures__/plans";
import { PORTAINER_STACK_VARIABLES, portainerStackEnvKeys, renderPortainerStack } from "./index";

type Caddy = {
  environment?: Record<string, string>;
  entrypoint?: string[];
  tmpfs?: string[];
};

const ctx: RuntimeContext = testContext({ acmeEmail: "ops@example.com" });
const origin: RuntimeContext = { ...ctx, originTls: { hostnames: ["shop.example.com"] } };
const caddyMode = portainerTestPlan({ web: { mode: "caddy" } });

const stack = (plan = caddyMode, c = origin) => parse(renderPortainerStack(plan, c).content);
const caddyOf = (plan = caddyMode, c = origin) => stack(plan, c).services.caddy as Caddy;
/** The entrypoint's script as the container's shell gets it (Compose turns `$$` into `$`). */
const entrypoint = () => (caddyOf().entrypoint?.[2] ?? "").replaceAll("$$", "$");

/** A placeholder certificate and its key (a self-signed P-256 certificate, made now). */
function placeholder(commonName: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName, days: 1 }), key };
}

describe("the stack Caddy with origin TLS (web mode caddy)", () => {
  it("gets the certificates as one stack variable", () => {
    expect(PORTAINER_STACK_VARIABLES.originTls).toBe("OPSCREW_ORIGIN_TLS");
    expect(caddyOf().environment?.OPSCREW_ORIGIN_TLS).toBe("${OPSCREW_ORIGIN_TLS}");
    expect(portainerStackEnvKeys(caddyMode, origin).opscrew).toContain("OPSCREW_ORIGIN_TLS");
    expect(portainerStackEnvKeys(caddyMode).opscrew).not.toContain("OPSCREW_ORIGIN_TLS");
    // Only Caddy reads it.
    const others = Object.entries(stack().services).filter(([name]) => name !== "caddy");
    expect(JSON.stringify(others)).not.toContain("OPSCREW_ORIGIN_TLS");
  });

  it("writes them to a tmpfs with a two-line entrypoint before caddy run", () => {
    expect(caddyOf().tmpfs).toEqual(["/etc/caddy/tls/shop:mode=0700"]);
    expect(caddyOf().entrypoint?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(entrypoint().split("\n")).toEqual([
      // Caddy then runs without the variable.
      `umask 077 && printf '%s' "$OPSCREW_ORIGIN_TLS" | base64 -d | awk 'BEGIN { f = "origin.pem" } /-BEGIN [A-Z ]*PRIVATE KEY-/ { f = "origin.key" } /-BEGIN CERTIFICATE-/ && f == "origin.key" { f = "pull.pem" } { print > ("/etc/caddy/tls/shop/" f) }' && unset OPSCREW_ORIGIN_TLS`,
      // As the image's own command.
      "exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    ]);
  });

  it("serves the same site as a server's edge", () => {
    const caddyfile = stack().configs.caddyfile.content as string;
    const server = renderCaddyfile(testPlan({ domain: "shop.example.com" }), origin).content;
    const tlsBlock = (text: string) =>
      /\n(shop\.example\.com \{\n\ttls [\s\S]*?\n\t\}\n)/.exec(text)?.[1];
    expect(tlsBlock(caddyfile)).toBeDefined();
    expect(tlsBlock(caddyfile)).toBe(tlsBlock(server));
    expect(caddyfile).toContain("\t\t\ttrust_pool file /etc/caddy/tls/shop/pull.pem\n");
  });

  it("splits the bundle into the certificate, its key and pull.pem", (test) => {
    if (spawnSync("sh", ["-c", "command -v base64 && command -v awk"]).status !== 0) {
      test.skip("needs sh, base64 and awk");
    }
    const dir = mkdtempSync(join(tmpdir(), "opscrew-origin-tls-")).replaceAll("\\", "/");
    try {
      const cert = placeholder("shop.example.com");
      const pull = placeholder("opscrew-shop").certificate;
      const bundle = Buffer.from(`${cert.certificate}${cert.key}${pull}`).toString("base64");
      const [split = ""] = entrypoint().split("\n");
      // What the second line's `exec` would see of the variable.
      const after = 'echo "${OPSCREW_ORIGIN_TLS-unset}"';
      const result = spawnSync(
        "sh",
        ["-c", `${split.replace("/etc/caddy/tls/shop/", `${dir}/`)}\n${after}`],
        { env: { ...process.env, OPSCREW_ORIGIN_TLS: bundle }, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toBe("unset\n");
      expect(readFileSync(join(dir, "origin.pem"), "utf8")).toBe(cert.certificate);
      expect(readFileSync(join(dir, "origin.key"), "utf8")).toBe(cert.key);
      expect(readFileSync(join(dir, "pull.pem"), "utf8")).toBe(pull);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never holds a certificate or a key in the stack file", () => {
    const content = renderPortainerStack(caddyMode, origin).content;
    expect(content).not.toMatch(/-----BEGIN|PRIVATE KEY-----/);
    // The value goes only to printf, a builtin, and down a pipe.
    expect(entrypoint().match(/\$OPSCREW_ORIGIN_TLS/g)).toHaveLength(1);
    expect(entrypoint()).toContain(`printf '%s' "$OPSCREW_ORIGIN_TLS" | base64 -d | `);
  });

  it("matches the snapshot", () => {
    expect(renderPortainerStack(caddyMode, origin).content).toMatchSnapshot();
  });
});

describe("the stack without OpsCrew's public Caddy", () => {
  const webs: PortainerWeb[] = [{ mode: "tunnel" }, { mode: "proxy", port: 8080 }];
  for (const web of webs) {
    it(`gets none of it in web mode ${web.mode}`, () => {
      const plan = portainerTestPlan({ web });
      expect(renderPortainerStack(plan, origin)).toEqual(renderPortainerStack(plan, ctx));
      expect(portainerStackEnvKeys(plan, origin)).toEqual(portainerStackEnvKeys(plan));
    });
  }

  it("refuses every other hostname in web mode caddy, as the server's edge does (FR-1404)", () => {
    const CATCH_ALL =
      "\n}\n\n# Requests for any other hostname are refused.\nhttp:// {\n\tabort\n}\nhttps:// {\n\tabort\n}\n";
    for (const c of [ctx, origin]) {
      const caddyfile = stack(caddyMode, c).configs.caddyfile.content as string;
      // After the app's site, which ends just before it.
      expect(caddyfile.endsWith(CATCH_ALL)).toBe(true);
      expect(caddyfile.indexOf("shop.example.com {")).toBeLessThan(caddyfile.indexOf("http:// {"));
    }
    // Behind a tunnel or the user's proxy, Caddy is no origin anyone reaches directly.
    for (const web of webs) {
      const caddyfile = stack(portainerTestPlan({ web }), ctx).configs.caddyfile.content as string;
      expect(caddyfile).not.toContain("abort");
    }
  });

  it("keeps Caddy's ACME in web mode caddy without origin TLS", () => {
    const caddy = caddyOf(caddyMode, ctx);
    expect(caddy.entrypoint).toBeUndefined();
    expect(caddy.tmpfs).toBeUndefined();
    expect(caddy.environment).toBeUndefined();
    expect(stack(caddyMode, ctx).configs.caddyfile.content).not.toContain("/etc/caddy/tls/");
  });
});
