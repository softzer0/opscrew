// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { type EdgeProxy, OPENLITESPEED_COMMAND, openlitespeedCachePurge } from "../edge";
import { localhostPlan } from "../edge/__fixtures__/localhost";
import type { RuntimeContext } from "../runtime";
import { shellQuote } from "../runtime/services";
import { renderWorkflow } from "./index";
import { rollbackCommands, switchApp, switchCommands } from "./switch";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

const ctx: RuntimeContext = testContext({ acmeEmail: "ops@example.com" });

/** `shop.example.com` on `edge`, proxied by Cloudflare unless `dnsOnly`. */
function on(edge: EdgeProxy, dnsOnly: boolean): DeployPlan {
  const plan = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...plan,
    target: { ...plan.target, edge },
    dns: { ...plan.dns, proxied: !dnsOnly },
  });
}
const dnsOnly = on("openlitespeed", true);
const proxied = on("openlitespeed", false);
const origin: RuntimeContext = { ...ctx, originTls: { hostnames: ["shop.example.com"] } };

const steps = (plan: DeployPlan, c: RuntimeContext): Step[] =>
  parse(renderWorkflow(plan, c).content).jobs.deploy.steps;
const step = (plan: DeployPlan, c: RuntimeContext, name: string) =>
  steps(plan, c).find((s) => s.id === name || s.name === name) as Step;
const start = (plan: DeployPlan, c: RuntimeContext) => step(plan, c, "start").run ?? "";
/** The start step's edge part, under the edge's lock. */
const edgePart = (plan: DeployPlan, c: RuntimeContext) => {
  const script = start(plan, c);
  return script.slice(
    script.indexOf('mkdir -p "$EDGE_DIR"/sites'),
    script.indexOf(') 9> "$EDGE_DIR"/.lock'),
  );
};

/** The edge's own check and graceful restart, in its running container. */
const RELOAD = `edge exec -T openlitespeed ${OPENLITESPEED_COMMAND.reload} < /dev/null`;
/** The purge of the shop's page cache, in the same container. */
const PURGE = `edge exec -T openlitespeed sh -c ${shellQuote(openlitespeedCachePurge("shop"))} < /dev/null`;

describe("the deploy on the OpenLiteSpeed edge", () => {
  it("writes the deploy user's uid and gid to the edge's .env, which runs certbot as them", () => {
    expect(edgePart(dnsOnly, ctx)).toContain(
      `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > "$EDGE_DIR"/.env\n`,
    );
  });

  it("gives the deploy user certbot's volumes before the edge starts", () => {
    const part = edgePart(dnsOnly, ctx);
    const chown =
      '  edge run --rm --no-deps -T --user 0:0 --cap-add CHOWN --entrypoint chown certbot "$(id -u):$(id -g)" /etc/letsencrypt /var/www/acme /var/www/reload < /dev/null\n';
    expect(part).toContain(chown);
    expect(part.indexOf(chown)).toBeLessThan(part.indexOf(" up -d --wait --remove-orphans"));
  });

  it("puts the virtual host and its hostnames in with the site, keeping the server's to put back", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      [
        "  for f in vhost map; do",
        "    rm -f .site.previous.$f",
        '    if [ -f "$EDGE_DIR"/sites/shop.$f ]; then cp "$EDGE_DIR"/sites/shop.$f .site.previous.$f; fi',
        "  done",
        '  cp edge/sites/shop.vhost edge/sites/shop.map "$EDGE_DIR"/sites/',
      ].join("\n"),
    );
    // A site the check refuses goes, all three files, or the server's come back.
    expect(part).toContain(
      [
        `  if ! edge up -d --wait --remove-orphans || ! ${RELOAD}; then`,
        '    if [ -f .site.previous ]; then cp .site.previous "$EDGE_DIR"/sites/shop.vhconf; else rm -f "$EDGE_DIR"/sites/shop.vhconf; fi',
        "    for f in vhost map; do",
        '      if [ -f .site.previous.$f ]; then cp .site.previous.$f "$EDGE_DIR"/sites/shop.$f; else rm -f "$EDGE_DIR"/sites/shop.$f; fi',
        "    done",
      ].join("\n"),
    );
    expect(part).toContain(
      `OpenLiteSpeed and kamal-proxy, in '"$EDGE_DIR"') did not start or did not accept this app'\\''s site (opscrew/runtime/edge/sites/shop.vhconf)`,
    );
  });

  it("serves the site before the first certificate until certbot has it, then the HTTPS site", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      [
        "  if edge run --rm --no-deps -T --entrypoint test certbot -f /etc/letsencrypt/live/shop/fullchain.pem < /dev/null; then",
        '    cp edge/sites/shop.vhconf "$EDGE_DIR"/sites/shop.vhconf',
        "    first=0",
        "  else",
        '    cp edge/sites/shop.http.vhconf "$EDGE_DIR"/sites/shop.vhconf',
        "    first=1",
        "  fi",
      ].join("\n"),
    );
    const at = (text: string) => part.indexOf(text);
    expect(at("first=1")).toBeLessThan(at(" up -d --wait --remove-orphans"));
    expect(at(" up -d --wait --remove-orphans")).toBeLessThan(at("certbot certonly"));
    // After certbot: renew_before_expiry, the HTTPS site, then the checked graceful restart.
    const after = part.slice(at("certbot certonly"));
    const order = [
      "--entrypoint sh certbot -c",
      '  cp edge/sites/shop.vhconf "$EDGE_DIR"/sites/shop.vhconf\n',
      `  if ! ${RELOAD}; then\n`,
    ].map((text) => after.indexOf(text));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(after).toContain(
      "::error::OpenLiteSpeed did not accept this app'\\''s site (opscrew/runtime/edge/sites/shop.vhconf) with certbot'\\''s certificate",
    );
    expect(part).not.toContain("nginx -t");
  });

  it("runs no certbot for hostnames on the origin certificate", () => {
    const part = edgePart(proxied, origin);
    expect(part).not.toContain("certonly");
    expect(part).not.toContain("--entrypoint test");
    expect(part).toContain('  cp edge/sites/shop.vhconf "$EDGE_DIR"/sites/shop.vhconf\n');
    expect(edgePart(proxied, ctx)).toContain("certonly");
  });

  it("uploads the OpenLiteSpeed additions and puts them next to the site", () => {
    const c = { ...ctx, additions: true };
    expect(step(dnsOnly, c, "Upload runtime files and environment").run).toContain(
      ' opscrew/runtime/compose.yaml opscrew/runtime/edge opscrew/proxy/additions.openlitespeed "deploy@${HOST}:/srv/apps/shop/"\n',
    );
    expect(edgePart(dnsOnly, c)).toContain(
      '  cp additions.openlitespeed "$EDGE_DIR"/sites/shop.additions\n',
    );
  });

  it("switches from the proxy the server runs, naming it, and only then takes Caddy's and nginx's sites out", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      [
        `  proxy="$(sed -n 's/^x-opscrew-edge-proxy: //p' "$EDGE_DIR"/compose.yaml 2> /dev/null || true)"`,
        `  case "$proxy" in caddy) from='Caddy' ;; nginx) from='nginx' ;; *) from="$proxy" ;; esac`,
        "  rm -f .edge.previous",
        '  if [ -n "$proxy" ] && [ "$proxy" != openlitespeed ]; then',
        "    printf '::notice::OpsCrew switches this server'\\''s proxy from %s to OpenLiteSpeed (target.edge in opscrew/plan.yaml). kamal-proxy and the apps keep running; the sites stop for a few seconds while OpenLiteSpeed starts, and hostnames not proxied by Cloudflare have no HTTPS for under a minute while certbot gets their certificates.\\n' \"$from\"",
        '    cp "$EDGE_DIR"/compose.yaml .edge.previous',
      ].join("\n"),
    );
    expect(part).toContain(
      "printf '::error::The switch to OpenLiteSpeed did not work, so the server keeps %s as its proxy.\\n' \"$from\"",
    );
    expect(part).toContain(
      "printf '::error::certbot could not get the certificate for shop.example.com, so the server keeps %s as its proxy, and the new version was not started.",
    );
    const remove = '  rm -f "$EDGE_DIR"/sites/shop.caddy "$EDGE_DIR"/sites/shop.conf\n';
    expect(part).toContain(remove);
    expect(part.indexOf(remove)).toBeGreaterThan(part.lastIndexOf(RELOAD));
  });

  it("empties the app's page cache and restarts gracefully after every switch, under the edge's lock: deploy, rollback and the workflow's rollback", () => {
    const failed =
      "echo '::error::The new version of shop serves, but OpenLiteSpeed did not empty the app'\\''s page cache or did not restart after the switch, so it keeps its running configuration. The reason is above: fix its cause and deploy again.'";
    const after = [
      "(",
      "flock 9",
      `if ! ${PURGE} || ! ${RELOAD}; then`,
      failed,
      "fi",
      ') 9> "$EDGE_DIR"/.lock',
    ].join("\n");
    /** Each part of `script` after a switch of kamal-proxy's, its lines unindented. */
    const afterEach = (script: string) =>
      script.replace(/\n +/g, "\n").split("kamal-proxy deploy shop").slice(1);
    // After each switch (the plan's database gives the start script two), never before: the
    // version before must not fill the cache again.
    for (const script of [start(dnsOnly, ctx), rollbackCommands(dnsOnly).join("\n")]) {
      const parts = afterEach(script);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) expect(part).toContain(`\n${after}\n`);
    }
    expect(switchCommands(dnsOnly, []).join("\n").replace(/\n +/g, "\n")).toContain(after);
    // A refusal only says so: the new version serves, and the script goes on.
    expect(switchApp(dnsOnly, "", []).slice(-6)).toEqual([
      "(",
      "  flock 9",
      `  if ! ${PURGE} || ! ${RELOAD}; then`,
      `    ${failed}`,
      "  fi",
      ') 9> "$EDGE_DIR"/.lock',
    ]);
    // On this computer, the lock only where flock exists, as the deploy's edge part takes it.
    const local = localhostPlan({ edge: "openlitespeed" });
    expect(switchApp(local, "", []).slice(-5, -4)).toEqual([
      "  if command -v flock > /dev/null 2>&1; then flock 9; fi",
    ]);
    // Caddy and nginx have no cache to empty.
    for (const edge of ["caddy", "nginx"] as const) {
      expect(switchApp(on(edge, true), "", []).join("\n")).not.toContain("openlitespeed");
    }
  });

  it("matches the snapshots of the first certificate and origin TLS", () => {
    expect({
      "first certificate (DNS-only)": edgePart(dnsOnly, { ...ctx, additions: true }),
      "origin TLS (proxied)": edgePart(proxied, origin),
    }).toMatchSnapshot();
  });
});
