import { describe, expect, it } from "vitest";
import { portainerAddressNames } from "../portainer-access";
import { withoutPortainer } from "./shared";

describe("withoutPortainer", () => {
  it("replaces a whole host name, case-insensitively, and leaves words that contain it intact", () => {
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
        "Host: your Portainer.",
        "Nothing in your Portainer changed.",
      ].join("\n"),
    );
  });

  it("replaces a dotted host name only as a whole name", () => {
    const names = portainerAddressNames("https://nas.lan:9443");
    expect(withoutPortainer("at nas.lan, not shop.nas.lan or nas.lan.example", names)).toBe(
      "at your Portainer, not shop.nas.lan or nas.lan.example",
    );
  });
});
