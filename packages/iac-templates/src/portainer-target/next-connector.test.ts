// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose variables in expected values, not JavaScript templates.
// Feature 028 (T2807): the new Cloudflare account's connectors in Portainer, beside the app's.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { portainerTestPlan } from "./__fixtures__/plans";
import { renderPortainerConnectorStack, renderPortainerStack } from "./index";
import { renderNextConnectorStacks } from "./next-connector";

describe("renderNextConnectorStacks", () => {
  it("renders the app's tunnel connector on the app stack's network, and the webhook's", () => {
    const plan = portainerTestPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare" });
    const stacks = renderNextConnectorStacks(plan);
    expect(stacks.map((s) => s.name)).toEqual([
      "opscrew-shop-tunnel-next",
      "opscrew-shop-portainer-tunnel-next",
    ]);
    for (const stack of stacks) expect(stack.content).toMatchSnapshot(stack.name);
  });

  it("joins the network the app stack's Caddy is on and takes its token from the stack", () => {
    const plan = portainerTestPlan({ web: { mode: "tunnel" } });
    const [stack] = renderNextConnectorStacks(plan);
    const next = parse(stack?.content ?? "");
    const app = parse(renderPortainerStack(plan, testContext()).content);
    expect(next.name).toBe(stack?.name);
    // Compose names the app stack's network `<project>_internal`.
    expect(next.networks).toEqual({
      internal: { name: `${app.name}_internal`, external: true },
    });
    expect(Object.keys(app.networks)).toEqual(["internal"]);
    expect(app.services.caddy.networks).toEqual(["internal"]);
    const { cloudflared } = next.services;
    expect(cloudflared.networks).toEqual(["internal"]);
    expect(cloudflared.environment).toEqual({ TUNNEL_TOKEN: "${TUNNEL_TOKEN}" });
    // As the app stack's own connector, but for its token's variable and Caddy in another stack.
    const { environment: _own, depends_on: _caddy, ...own } = app.services.cloudflared;
    const { environment: _next, ...rest } = cloudflared;
    expect(rest).toEqual(own);
  });

  it("renders the webhook's connector as the current one", () => {
    const plan = portainerTestPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" });
    const stacks = renderNextConnectorStacks(plan);
    expect(stacks.map((s) => s.name)).toEqual(["opscrew-shop-portainer-tunnel-next"]);
    const next = parse(stacks[0]?.content ?? "");
    const own = parse(renderPortainerConnectorStack(plan).content);
    expect(next.services).toEqual(own.services);
  });

  it("renders none without a tunnel", () => {
    expect(renderNextConnectorStacks(portainerTestPlan({ web: { mode: "caddy" } }))).toEqual([]);
    expect(
      renderNextConnectorStacks(portainerTestPlan({ web: { mode: "proxy", port: 8080 } })),
    ).toEqual([]);
  });
});
