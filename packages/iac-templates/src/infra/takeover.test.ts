import { checkDialect } from "@opscrew/iac-engine";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import type { RenderedFile } from "../types";
import { splitPlan } from "./__fixtures__/servers";
import { renderInfra } from "./index";
import { MODULE_FILES } from "./modules";
import { rootMainFile, serverResourceAddress, withServerImports } from "./takeover";

const main = (files: readonly RenderedFile[]) =>
  files.find((file) => file.path === "opscrew/infra/prod/main.tf")?.content ?? "";

/** The `import { … }` blocks of a root `main.tf`. */
const imports = (text: string) => [...text.matchAll(/^import \{\n[\s\S]*?^\}$/gm)].map((m) => m[0]);

describe("taking over a server the state lost", () => {
  it("names the address of each server OpsCrew creates, and none for the user's own", () => {
    const plan = splitPlan({
      servers: [
        { name: "db", provider: "digitalocean" },
        { name: "cache", provider: "hetzner" },
      ],
    });
    expect(serverResourceAddress(plan, "app")).toBe("module.server.hcloud_server.this");
    expect(serverResourceAddress(plan, "db")).toBe("module.server_db.digitalocean_droplet.this");
    expect(serverResourceAddress(plan, "cache")).toBe("module.server_cache.hcloud_server.this");
    expect(serverResourceAddress(plan, "web")).toBeUndefined();
    expect(serverResourceAddress(testPlan({ provider: "own" }), "app")).toBeUndefined();
  });

  it.each(CLOUD_PROVIDERS.map((provider) => [provider.id, provider.terraform] as const))(
    "aims at the server every %s server module names `this`",
    (_id, terraform) => {
      expect(MODULE_FILES[`${terraform.module.name}/main.tf`]).toContain(
        `resource "${terraform.serverResourceType}" "this" {`,
      );
    },
  );

  it("adds one import block per server to the root's main.tf and changes nothing else", () => {
    const plan = splitPlan({ servers: [{ name: "db", provider: "digitalocean" }] });
    const files = renderInfra(plan, testContext());
    const taken = withServerImports(files, plan, [
      { server: "app", id: "4711" },
      { server: "db", id: "512" },
    ]);
    expect(taken.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(taken.filter((file) => !file.path.endsWith("prod/main.tf"))).toEqual(
      files.filter((file) => !file.path.endsWith("prod/main.tf")),
    );
    expect(rootMainFile(plan)).toBe("opscrew/infra/prod/main.tf");
    const text = main(taken);
    expect(text.startsWith(main(files))).toBe(true);
    expect(imports(text)).toEqual([
      'import {\n  to = module.server.hcloud_server.this\n  id = "4711"\n}',
      'import {\n  to = module.server_db.digitalocean_droplet.this\n  id = "512"\n}',
    ]);
    expect(text).toContain(
      "# Hetzner Cloud's server shop (id 4711) is taken over: an earlier apply",
    );
    expect(text).toContain("# DigitalOcean's Droplet shop-db (id 512) is taken over");
    // Plain HCL both engines read: no construct only one of them knows.
    expect(checkDialect(taken.map(({ path, content }) => ({ path, content })))).toEqual([]);
  });

  it("imports an extra server of an app on a server the user owns", () => {
    const plan = splitPlan({
      app: { provider: "own" },
      servers: [{ name: "db", provider: "hetzner" }],
    });
    const taken = withServerImports(renderInfra(plan, testContext()), plan, [
      { server: "db", id: "99" },
    ]);
    expect(imports(main(taken))).toEqual([
      'import {\n  to = module.server_db.hcloud_server.this\n  id = "99"\n}',
    ]);
  });

  it("leaves the files as they are without a server to take over", () => {
    const plan = testPlan({ provider: "digitalocean" });
    const files = renderInfra(plan, testContext());
    expect(withServerImports(files, plan, [])).toEqual(files);
  });

  it("refuses a server the plan does not create, and an id it cannot write as it is", () => {
    const plan = testPlan({ provider: "own" });
    const files = renderInfra(plan, testContext());
    expect(() => withServerImports(files, plan, [{ server: "app", id: "1" }])).toThrow(
      'The plan creates no server "app"',
    );
    const cloud = testPlan();
    expect(() =>
      withServerImports(renderInfra(cloud, testContext()), cloud, [
        { server: "app", id: '1"\n}\nresource "x" "y" {' },
      ]),
    ).toThrow("is not a server id");
  });
});
