// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import type { RuntimeContext } from "../runtime";
import { renderWorkflow } from "./index";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

const ctx: RuntimeContext = testContext({ acmeEmail: "ops@example.com" });

/** `shop.example.com` on `edge`, proxied by Cloudflare unless `dnsOnly`. */
function on(edge: "caddy" | "nginx", dnsOnly: boolean): DeployPlan {
  const plan = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...plan,
    target: { ...plan.target, edge },
    dns: { ...plan.dns, proxied: !dnsOnly },
  });
}
const dnsOnly = on("nginx", true);
const proxied = on("nginx", false);
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
    script.indexOf("mkdir -p /srv/edge/sites"),
    script.indexOf(") 9> /srv/edge/.lock"),
  );
};

describe("the deploy on the nginx edge", () => {
  it("writes the deploy user's uid and gid to the edge's .env, which runs nginx and certbot as them", () => {
    expect(edgePart(dnsOnly, ctx)).toContain(
      `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > /srv/edge/.env\n`,
    );
    expect(edgePart(on("caddy", true), ctx)).not.toContain(".env");
  });

  it("gives the deploy user certbot's volumes before the edge starts", () => {
    const part = edgePart(dnsOnly, ctx);
    const chown =
      '  edge run --rm --no-deps -T --user 0:0 --cap-add CHOWN --entrypoint chown certbot "$(id -u):$(id -g)" /etc/letsencrypt /var/www/acme /var/www/reload < /dev/null\n';
    expect(part).toContain(chown);
    expect(part.indexOf(chown)).toBeLessThan(part.indexOf(" up -d --wait --remove-orphans"));
  });

  it("serves the site before the first certificate until certbot has it, then the HTTPS site", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      [
        "  if edge run --rm --no-deps -T --entrypoint test certbot -f /etc/letsencrypt/live/shop/fullchain.pem < /dev/null; then",
        "    cp edge/sites/shop.conf /srv/edge/sites/shop.conf",
        "    first=0",
        "  else",
        "    cp edge/sites/shop.http.conf /srv/edge/sites/shop.conf",
        "    first=1",
        "  fi",
      ].join("\n"),
    );
    const at = (text: string) => part.indexOf(text);
    expect(at("first=1")).toBeLessThan(at(" up -d --wait --remove-orphans"));
    expect(at(" up -d --wait --remove-orphans")).toBeLessThan(at("certbot certonly"));
    const certonly =
      "out=\"$(edge run --rm --no-deps -T --entrypoint certbot certbot certonly --config-dir /etc/letsencrypt --work-dir /tmp/certbot/work --logs-dir /tmp/certbot/logs --non-interactive --agree-tos --email 'ops@example.com' --keep-until-expiring --webroot --webroot-path /var/www/acme --cert-name shop --domains shop.example.com --deploy-hook 'touch /var/www/reload/flag' < /dev/null 2>&1)\" || status=$?";
    // Once more, after a pause, only when another certbot held the lock; its output is printed.
    expect(part).toContain(
      [
        "  status=0",
        `  ${certonly}`,
        '  case "$status:$out" in',
        "    0:*) ;;",
        "    *'Another instance of Certbot is already running'*)",
        "      printf '%s\\n' \"$out\"",
        "      sleep 10",
        "      status=0",
        `      ${certonly}`,
        "      ;;",
        "  esac",
        "  printf '%s\\n' \"$out\"",
        '  if [ "$status" -ne 0 ]; then',
      ].join("\n"),
    );
    // After certbot: renew_before_expiry, the HTTPS site, nginx -t and a reload.
    const after = part.slice(at("certbot certonly"));
    const order = [
      "--entrypoint sh certbot -c",
      "  cp edge/sites/shop.conf /srv/edge/sites/shop.conf\n",
      "  if ! edge exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null; then\n",
    ].map((text) => after.indexOf(text));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reloads nginx with nginx -t first, and puts the previous site back when it refuses the new one", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      "  if ! edge up -d --wait --remove-orphans || ! edge exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null; then\n    if [ -f .site.previous ]; then cp .site.previous /srv/edge/sites/shop.conf; else rm -f /srv/edge/sites/shop.conf; fi\n",
    );
    expect(part).toContain(
      "nginx and kamal-proxy, in /srv/edge) did not start or did not accept this app'\\''s site (opscrew/runtime/edge/sites/shop.conf)",
    );
  });

  it("runs no certbot for hostnames on the origin certificate", () => {
    const part = edgePart(proxied, origin);
    expect(part).not.toContain("certonly");
    expect(part).not.toContain("--entrypoint test");
    expect(part).toContain("  cp edge/sites/shop.conf /srv/edge/sites/shop.conf\n");
    // A proxied app without the origin certificate (no permission yet) gets certbot's.
    expect(edgePart(proxied, ctx)).toContain("certonly");
  });

  it("uploads the nginx additions and puts them next to the site", () => {
    const c = { ...ctx, additions: true };
    expect(step(dnsOnly, c, "Upload runtime files and environment").run).toContain(
      ' opscrew/runtime/compose.yaml opscrew/runtime/edge opscrew/proxy/additions.nginx "deploy@${HOST}:/srv/apps/shop/"\n',
    );
    expect(edgePart(dnsOnly, c)).toContain("  cp additions.nginx /srv/edge/sites/shop.additions\n");
  });

  it("switches the proxy when the server's edge runs the other one, and states the interruption", () => {
    const part = edgePart(dnsOnly, ctx);
    expect(part).toContain(
      [
        `  proxy="$(sed -n 's/^x-opscrew-edge-proxy: //p' /srv/edge/compose.yaml 2> /dev/null || true)"`,
        "  rm -f .edge.previous",
        '  if [ -n "$proxy" ] && [ "$proxy" != nginx ]; then',
        "    echo '::notice::OpsCrew switches this server'\\''s proxy from Caddy to nginx (target.edge in opscrew/plan.yaml). kamal-proxy and the apps keep running; the sites stop for a few seconds while nginx starts, and hostnames not proxied by Cloudflare have no HTTPS for under a minute while certbot gets their certificates.'",
        "    cp /srv/edge/compose.yaml .edge.previous",
        "    cp edge/compose.yaml /srv/edge/compose.yaml",
        '  elif [ "$uploaded" -gt "${current:-0}" ]; then',
      ].join("\n"),
    );
    // Compose removes the old proxy's containers; certbot's and Caddy's volumes stay.
    expect(part).not.toMatch(/volume rm|down/);
    // Caddy's site and the earlier origin files go only once certbot and nginx took the new site,
    // so a failed switch can put Caddy back with them.
    expect(part.indexOf("  rm -f /srv/edge/sites/shop.caddy\n")).toBeGreaterThan(
      part.lastIndexOf("nginx -s reload"),
    );
    expect(part.indexOf("  rm -rf /srv/edge/tls/shop\n")).toBeGreaterThan(
      part.lastIndexOf("nginx -s reload"),
    );
    expect(edgePart(on("caddy", true), ctx)).toContain(
      "  if [ -n \"$proxy\" ] && [ \"$proxy\" != caddy ]; then\n    echo '::notice::OpsCrew switches this server'\\''s proxy from nginx to Caddy",
    );
  });

  it("gives only the upload step the origin certificate's secret, on nginx too", () => {
    const all = steps(proxied, origin);
    const upload = all.find((s) => s.name === "Upload runtime files and environment");
    expect(upload?.env?.OPSCREW_ORIGIN_TLS).toBe("${{ secrets.OPSCREW_ORIGIN_TLS }}");
    for (const s of all.filter((s) => s !== upload)) {
      expect(JSON.stringify(s)).not.toContain("OPSCREW_ORIGIN_TLS");
    }
  });

  it("matches the snapshots of the first certificate and the switch", () => {
    expect({
      "first certificate (DNS-only)": edgePart(dnsOnly, { ...ctx, additions: true }),
      "origin TLS (proxied)": edgePart(proxied, origin),
      "switch to Caddy": edgePart(on("caddy", true), ctx),
    }).toMatchSnapshot();
  });
});
