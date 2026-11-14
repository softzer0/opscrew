// Feature 028 (T2807): the new Cloudflare account's tunnel connector beside the app's on a server.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { renderTunnelConnectorCompose } from "./index";
import { renderNextTunnelConnectorCompose } from "./tunnel-next";

const plan = () => testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });

describe("renderNextTunnelConnectorCompose", () => {
  it("renders the connector as its own Compose project in cloudflared-next", () => {
    const file = renderNextTunnelConnectorCompose(plan());
    expect(file.path).toBe("opscrew/runtime/cloudflared-next/compose.yaml");
    expect(file.kind).toBe("runtime");
    expect(file.content).toMatchSnapshot();
  });

  it("matches the app's own connector but for its project name", () => {
    const next = parse(renderNextTunnelConnectorCompose(plan()).content);
    const own = parse(renderTunnelConnectorCompose(plan()).content);
    expect(next.name).toBe("shop-tunnel-next");
    expect(next.services).toEqual(own.services);
    expect(next.services.cloudflared.network_mode).toBe("host");
    expect(next.services.cloudflared.env_file).toEqual(["tunnel.env"]);
    expect(next.services.cloudflared.environment).toBeUndefined();
  });

  it("follows the environment's runtime folder", () => {
    const base = plan();
    const staging = { ...base, environment: { name: "staging" } } as typeof base;
    expect(renderNextTunnelConnectorCompose(staging).path).toBe(
      "opscrew/environments/staging/runtime/cloudflared-next/compose.yaml",
    );
  });
});
