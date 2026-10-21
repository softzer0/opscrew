// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { ORIGIN_PULL_PEM } from "../edge";
import type { RuntimeContext } from "../runtime";
import { DEPLOY_SECRETS, renderWorkflow } from "./index";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

const plan = testPlan({ domain: "shop.example.com" });
const tunnelled = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
const ctx: RuntimeContext = testContext({ acmeEmail: "ops@example.com" });
const origin: RuntimeContext = { ...ctx, originTls: { hostnames: ["shop.example.com"] } };

function steps(p: typeof plan, c: RuntimeContext): Step[] {
  return parse(renderWorkflow(p, c).content).jobs.deploy.steps;
}
const upload = (p: typeof plan, c: RuntimeContext) =>
  steps(p, c).find((s) => s.name === "Upload runtime files and environment") as Step;
const start = (p: typeof plan, c: RuntimeContext) =>
  steps(p, c).find((s) => s.id === "start")?.run ?? "";

describe("the deploy with origin TLS", () => {
  it("gives only the upload step the origin certificate's secret", () => {
    expect(DEPLOY_SECRETS.originTls).toBe("OPSCREW_ORIGIN_TLS");
    expect(upload(plan, origin).env?.OPSCREW_ORIGIN_TLS).toBe("${{ secrets.OPSCREW_ORIGIN_TLS }}");
    const others = steps(plan, origin).filter((s) => s.name !== upload(plan, origin).name);
    expect(others.some((s) => JSON.stringify(s).includes("OPSCREW_ORIGIN_TLS"))).toBe(false);
    expect(renderWorkflow(plan, ctx).content).not.toContain("OPSCREW_ORIGIN_TLS");
  });

  it("writes the certificate and the key through ssh's stdin, under umask 077 in a 0700 folder", () => {
    const run = upload(plan, origin).run ?? "";
    expect(run).toContain(
      `printf '%s\\n' "$OPSCREW_ORIGIN_TLS" | sed '/-BEGIN [A-Z ]*PRIVATE KEY-/,$d' | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && mkdir -p /srv/edge/tls/shop && chmod 700 /srv/edge/tls/shop && cat > /srv/edge/tls/shop/origin.pem.new'\n`,
    );
    expect(run).toContain(
      `printf '%s\\n' "$OPSCREW_ORIGIN_TLS" | sed -n '/-BEGIN [A-Z ]*PRIVATE KEY-/,$p' | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/edge/tls/shop/origin.key.new'\n`,
    );
    // The value only ever goes to a builtin (`case`, `printf`) and down a pipe: never into a
    // command's arguments, and never through a `${{ }}` expression in the script.
    for (const line of run.split("\n").filter((l) => /\$\{?OPSCREW_ORIGIN_TLS/.test(l))) {
      expect(line).toMatch(
        /^(case "\$\{OPSCREW_ORIGIN_TLS:-\}" in|printf '%s\\n' "\$OPSCREW_ORIGIN_TLS" \| )/,
      );
    }
    expect(run).not.toContain("${{");
  });

  it("stops with a plain message when the secret holds no certificate and key", () => {
    const run = upload(plan, origin).run ?? "";
    expect(run).toContain('  *"-----BEGIN CERTIFICATE-----"*"PRIVATE KEY-----"*) ;;\n');
    expect(run).toContain(
      '  *) echo "::error::The deploy secret OPSCREW_ORIGIN_TLS must hold the app\'s Cloudflare origin certificate, then its private key. Run \\`opscrew provision\\` again to set it, then deploy again."; exit 1 ;;',
    );
    // The check comes before anything is written.
    expect(run.indexOf("case ")).toBeLessThan(run.indexOf("origin.pem.new"));
  });

  it("uploads pull.pem with the edge's files and puts all three in place under the lock, before the site", () => {
    // opscrew/runtime/edge lands in the app's folder as edge/, with tls/pull.pem in it.
    expect(ORIGIN_PULL_PEM).toBe("opscrew/runtime/edge/tls/pull.pem");
    expect(upload(plan, origin).run).toMatch(
      / opscrew\/runtime\/edge "deploy@\$\{HOST\}:\/srv\/apps\/shop\/"\n/,
    );
    const script = start(plan, origin);
    const at = (text: string) => script.indexOf(text);
    const tls = "/srv/edge/tls/shop";
    const swap = [
      `  cp edge/tls/pull.pem ${tls}/pull.pem.new`,
      "  for f in origin.pem origin.key pull.pem; do",
      `    if [ -f ${tls}/$f ]; then mv -f ${tls}/$f ${tls}/$f.previous; else rm -f ${tls}/$f.previous; fi`,
      `    mv -f ${tls}/$f.new ${tls}/$f`,
      "  done",
    ].join("\n");
    expect(script).toContain(swap);
    expect(at("flock 9")).toBeLessThan(at(swap));
    expect(at(swap)).toBeLessThan(at("cp edge/sites/shop.caddy"));
    // The upload, which writes the files, runs before the start step, which switches the site.
    const ids = steps(plan, origin).map((s) => s.name ?? s.id);
    expect(ids.indexOf("Upload runtime files and environment")).toBeLessThan(
      ids.indexOf("Start the new version"),
    );
    expect(start(plan, ctx)).not.toContain("/srv/edge/tls/shop");
  });

  it("puts the previous certificate files back when Caddy refuses the deploy, and drops them once it took it", () => {
    const script = start(plan, origin);
    const tls = "/srv/edge/tls/shop";
    const back = [
      "    for f in origin.pem origin.key pull.pem; do",
      `      if [ -f ${tls}/$f.previous ]; then mv -f ${tls}/$f.previous ${tls}/$f; else rm -f ${tls}/$f; fi`,
      "    done",
    ].join("\n");
    const failed = script.indexOf("caddy reload");
    expect(script.indexOf(back)).toBeGreaterThan(failed);
    expect(script.indexOf(back)).toBeLessThan(script.indexOf("    exit 1", failed));
    const done = `  rm -f ${tls}/origin.pem.previous ${tls}/origin.key.previous ${tls}/pull.pem.previous\n) 9> /srv/edge/.lock`;
    expect(script).toContain(done);
  });

  it("does nothing of it behind a Cloudflare Tunnel (FR-1409)", () => {
    expect(renderWorkflow(tunnelled, origin)).toEqual(renderWorkflow(tunnelled, ctx));
  });

  it("does not blame Let's Encrypt for a failed handshake with the origin certificate", () => {
    const health = (c: RuntimeContext) => steps(plan, c).find((s) => s.id === "health")?.run ?? "";
    expect(health(ctx)).toContain("Let's Encrypt");
    expect(health(origin)).not.toContain("Let's Encrypt");
    expect(health(origin)).toContain('echo "::error::The new version did not answer at $URL."');
  });

  it("matches the snapshot", () => {
    const job = steps(plan, { ...origin, additions: true });
    const of = (name: string) => job.find((s) => s.name === name || s.id === name);
    expect({
      upload: of("Upload runtime files and environment"),
      start: of("start")?.run,
    }).toMatchSnapshot();
  });
});

describe("the deploy with the user's additions", () => {
  const additions: RuntimeContext = { ...ctx, additions: true };

  it("uploads opscrew/proxy/additions.caddy with the runtime files", () => {
    expect(upload(plan, additions).run).toContain(
      ' opscrew/runtime/compose.yaml opscrew/runtime/edge opscrew/proxy/additions.caddy "deploy@${HOST}:/srv/apps/shop/"\n',
    );
    expect(upload(plan, ctx).run).not.toContain("additions");
  });

  it("puts them in /srv/edge/sites with the site, and back with it when Caddy refuses them", () => {
    const script = start(plan, additions);
    const at = (text: string) => script.indexOf(text);
    expect(
      at(
        "if [ -f /srv/edge/sites/shop.additions ]; then cp /srv/edge/sites/shop.additions .additions.previous; fi",
      ),
    ).toBeGreaterThan(-1);
    expect(at("cp edge/sites/shop.caddy /srv/edge/sites/shop.caddy")).toBeLessThan(
      at("cp additions.caddy /srv/edge/sites/shop.additions"),
    );
    expect(at("cp additions.caddy")).toBeLessThan(at("caddy reload"));
    expect(script).toContain(
      "if [ -f .additions.previous ]; then cp .additions.previous /srv/edge/sites/shop.additions; else rm -f /srv/edge/sites/shop.additions; fi",
    );
    expect(script).toContain(
      "s site (opscrew/runtime/edge/sites/shop.caddy) or your additions (opscrew/proxy/additions.caddy), so",
    );
    expect(start(plan, ctx)).not.toContain("additions");
  });
});
