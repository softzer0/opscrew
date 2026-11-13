import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeCpanel } from "./fake";

const TOKEN = fakeSecret("generic-password", "cpanel-token");

describe("fakeCpanel's domains_data", () => {
  const setup = () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    fake.state.domains.push(
      { name: "shop.example.org", kind: "addon", documentRoot: "shop" },
      { name: "blog.example.com", kind: "subdomain", documentRoot: "blog" },
      { name: "parked.example.org", kind: "parked" },
    );
    const read = async (query: string) => {
      const answer = await fake.fetch(
        `https://panel.example.com:2083/execute/DomainInfo/domains_data${query}`,
        { headers: { authorization: `cpanel acct:${TOKEN}` } },
      );
      return ((await answer.json()) as { result: { data: unknown } }).result.data;
    };
    return { read };
  };

  it("leaves the parked domains out with format=list, as cPanel does", async () => {
    const list = (await setup().read("?format=list")) as { domain: string; type: string }[];
    expect(list.map((entry) => `${entry.type}|${entry.domain}`)).toEqual([
      "main_domain|example.com",
      "addon_domain|shop.example.org",
      "sub_domain|blog.example.com",
    ]);
  });

  it("gives the main domain as an object, addon and sub domains as objects and parked ones as names without format", async () => {
    const data = (await setup().read("")) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      "addon_domains",
      "main_domain",
      "parked_domains",
      "sub_domains",
    ]);
    expect(data.main_domain).toMatchObject({
      domain: "example.com",
      type: "main_domain",
      documentroot: "/home/acct/public_html",
      homedir: "/home/acct",
    });
    expect(data.addon_domains).toEqual([
      expect.objectContaining({
        domain: "shop.example.org",
        type: "addon_domain",
        documentroot: "/home/acct/shop",
      }),
    ]);
    expect(data.sub_domains).toEqual([
      expect.objectContaining({
        domain: "blog.example.com",
        type: "sub_domain",
        documentroot: "/home/acct/blog",
      }),
    ]);
    expect(data.parked_domains).toEqual(["parked.example.org"]);
  });
});
