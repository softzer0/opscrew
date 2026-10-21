import { readdirSync, readFileSync } from "node:fs";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { MAX_ADDITIONS_BYTES, type ProxyAdditionsContext, scanProxyAdditions } from "./rules";

const COMMON_RULES = [
  "tls",
  "admin-endpoint",
  "upstream",
  "logs",
  "hostname",
  "filesystem",
  "includes",
  "scripting",
  "not-allowed",
  "characters",
];
/** The rules each syntax has; `placeholder` reads Caddy's file and environment placeholders. */
const RULES = { nginx: COMMON_RULES, caddy: [...COMMON_RULES, "placeholder"] } as const;
const EXTENSION = { nginx: "conf", caddy: "caddy" } as const;
const PROXIES = ["nginx", "caddy"] as const;

function ctx(proxy: ProxyAdditionsContext["proxy"]): ProxyAdditionsContext {
  return { proxy, hostnames: ["app.example.com", "www.app.example.com"], upstream: "app-web:3000" };
}

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

/** The fixture files of `kind` for `proxy`: `<rule>.<ext>` and `<rule>.<case>.<ext>`. */
function fixtures(kind: "good" | "bad", proxy: ProxyAdditionsContext["proxy"]): string[] {
  return readdirSync(new URL(`${kind}/`, FIXTURES)).filter((f) =>
    f.endsWith(`.${EXTENSION[proxy]}`),
  );
}

function fixture(kind: "good" | "bad", name: string): string {
  return readFileSync(new URL(`${kind}/${name}`, FIXTURES), "utf8");
}

/** The lines a bad fixture marks with `# refused: <rule>` (or `# refused above: <rule>`). */
function expected(text: string): { line: number; rule: string }[] {
  return text.split("\n").flatMap((line, index) => {
    const match = /# refused( above)?: ([\w-]+)/.exec(line);
    return match?.[2] ? [{ line: index + 1 - (match[1] ? 1 : 0), rule: match[2] }] : [];
  });
}

/** Each fixture as committed (LF) and with Windows line endings. */
const ENDINGS = [
  ["LF", (text: string) => text],
  ["CRLF", (text: string) => text.replaceAll("\n", "\r\n")],
] as const;

describe("scanProxyAdditions", () => {
  for (const proxy of PROXIES) {
    describe(proxy, () => {
      it("has a good and a bad fixture for every rule", () => {
        for (const kind of ["good", "bad"] as const) {
          expect(fixtures(kind, proxy)).toEqual(
            expect.arrayContaining(RULES[proxy].map((rule) => `${rule}.${EXTENSION[proxy]}`)),
          );
        }
      });

      for (const [ending, convert] of ENDINGS) {
        for (const file of fixtures("bad", proxy)) {
          const rule = file.split(".")[0];
          it(`refuses each marked line of bad/${file} under ${rule} (${ending})`, () => {
            const text = fixture("bad", file);
            const refusals = scanProxyAdditions(convert(text), ctx(proxy));
            const want = expected(text);
            expect(want.length).toBeGreaterThan(0);
            expect(want.some((w) => w.rule === rule)).toBe(true);
            expect(refusals.map(({ line, rule }) => ({ line, rule }))).toEqual(want);
            for (const refusal of refusals) expect(refusal.message).toMatch(/\.$/);
          });
        }

        // The good fixtures include what the vercel.json translation writes (`translation.*`).
        for (const file of fixtures("good", proxy)) {
          it(`accepts good/${file} (${ending})`, () => {
            expect(scanProxyAdditions(convert(fixture("good", file)), ctx(proxy))).toEqual([]);
          });
        }
      }

      it("refuses a file over 64 KiB with one size refusal, and accepts one at the limit", () => {
        const line = "# a comment line that fills the file up\n";
        const atLimit = line
          .repeat(Math.ceil(MAX_ADDITIONS_BYTES / line.length))
          .slice(0, MAX_ADDITIONS_BYTES);
        expect(scanProxyAdditions(atLimit, ctx(proxy))).toEqual([]);
        const refusals = scanProxyAdditions(`${atLimit}#`, ctx(proxy));
        expect(refusals).toEqual([
          {
            line: 1,
            rule: "size",
            message:
              "The additions file is 65 KiB, over the 64 KiB limit. Keep only what the edge must do and move the rest into the app.",
          },
        ]);
      });
    });
  }

  it("says what to do instead, naming the app's upstream and hostnames", () => {
    const [upstream] = scanProxyAdditions("proxy_pass http://other:80;", ctx("nginx"));
    expect(upstream?.message).toBe(
      "`proxy_pass` sends traffic somewhere other than this app. Send it only to `app-web:3000`, the app's upstream, or remove the line.",
    );
    const [host] = scanProxyAdditions("@x host other.example\n", ctx("caddy"));
    expect(host?.message).toBe(
      "The `host` matcher names other.example, which is not this app's (app.example.com and www.app.example.com). Use only the app's hostnames, which come from plan.yaml.",
    );
  });

  it("keeps values from the file, such as credentials in a target, out of its messages", () => {
    const token = fakeSecret("github-token");
    const nginx = scanProxyAdditions(
      `add_header Authorization "Bearer ${token}";\nproxy_pass http://user:${token}@other:80;\n`,
      ctx("nginx"),
    );
    const caddy = scanProxyAdditions(
      `header Authorization "Bearer ${token}"\nreverse_proxy http://user:${token}@other:80\n`,
      ctx("caddy"),
    );
    expect(nginx.map((r) => [r.line, r.rule])).toEqual([[2, "upstream"]]);
    expect(caddy.map((r) => [r.line, r.rule])).toEqual([[2, "upstream"]]);
    expect(JSON.stringify([nginx, caddy])).not.toContain(token);
  });

  it("refuses a directive that is not on the list with the contract's message", () => {
    expect(scanProxyAdditions("sub_filter a b;", ctx("nginx"))).toEqual([
      {
        line: 1,
        rule: "not-allowed",
        message: "`sub_filter` is not supported in additions yet; tell OpsCrew if you need it.",
      },
    ]);
  });
});
