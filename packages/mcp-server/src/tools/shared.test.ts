import { portainerAddressNames } from "@opscrew/agents";
import { describe, expect, it } from "vitest";
import { withoutPortainer } from "./shared";

describe("withoutPortainer", () => {
  it("with the host `portainer`, replaces its address but never the product's own name", () => {
    const names = portainerAddressNames("https://portainer:9443");
    const text = [
      "Connected to https://portainer:9443/api and PORTAINER:9443.",
      "Answer portainer.url and portainer.environment.",
      "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
      "Host: Portainer.",
      "Nothing in your Portainer changed.",
    ].join("\n");
    expect(withoutPortainer(text, names)).toBe(
      [
        "Connected to your Portainer/api and your Portainer.",
        "Answer portainer.url and portainer.environment.",
        "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
        "Host: Portainer.",
        "Nothing in your Portainer changed.",
      ].join("\n"),
    );
  });

  it("with the host `nas`, replaces a whole host name, case-insensitively", () => {
    const names = portainerAddressNames("https://nas:9443");
    expect(
      withoutPortainer(
        "Portainer on nas (https://NAS:9443/api, nas:8000); kept nas.url, opscrew-shop-nas-tunnel, nas.lan.",
        names,
      ),
    ).toBe(
      "Portainer on your Portainer (your Portainer/api, your Portainer:8000); kept nas.url, opscrew-shop-nas-tunnel, nas.lan.",
    );
  });

  it("with the host `nas`, replaces it after a colon and in URL-encoded form", () => {
    const names = portainerAddressNames("https://nas:9443");
    expect(
      withoutPortainer("DNS:nas; u=https%3A%2F%2Fnas%3A9443; e=user%40nas; [REDACTED:nas]", names),
    ).toBe("DNS:your Portainer; u=your Portainer; e=user%40your Portainer; [REDACTED:nas]");
  });

  it("replaces a dotted host name only as a whole name", () => {
    const names = portainerAddressNames("https://nas.lan:9443");
    expect(withoutPortainer("at nas.lan, not shop.nas.lan or nas.lan.example", names)).toBe(
      "at your Portainer, not shop.nas.lan or nas.lan.example",
    );
  });
});
