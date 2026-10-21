import { checkDialect } from "@opscrew/iac-engine";
import type { CloudProvider } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { DIRECTIONS, testTarget } from "../__fixtures__/layouts";
import { CF_RANGES, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { renderDeployment } from "../render";
import type { InfraLayout, RenderedFile, ServerModule } from "../types";
import {
  MOVE_LAYOUTS as LAYOUT_NAMES,
  type MoveLayoutName as LayoutName,
  moveLayout,
  renderInfra,
  tfvars,
} from "./index";

const MODULE_DIRS: Record<CloudProvider, string> = {
  hetzner: "hetzner-vps",
  digitalocean: "digitalocean-droplet",
};
const TOKEN_VARS: Record<CloudProvider, string> = {
  hetzner: "HCLOUD_TOKEN",
  digitalocean: "DIGITALOCEAN_TOKEN",
};
const MOVES_ONLY: readonly LayoutName[] = ["rename", "abort-rename"];

/** The plan during a move: `plan.target` is already the new target. */
function movePlan(to: CloudProvider, domain = true) {
  return testPlan({
    provider: to,
    ...(domain ? { domain: "example.com", www: true } : {}),
  });
}

function layoutFor(name: LayoutName, from: CloudProvider, to: CloudProvider): InfraLayout {
  return moveLayout(name, testTarget(from), testTarget(to));
}

function render(name: LayoutName, from: CloudProvider, to: CloudProvider, domain = true) {
  return renderInfra(
    movePlan(to, domain),
    testContext({
      ...(domain ? { cloudflare: testCloudflare(), cloudflareRanges: CF_RANGES } : {}),
      layout: layoutFor(name, from, to),
    }),
  );
}

const content = (files: readonly RenderedFile[], suffix: string) =>
  files.find((f) => f.path.endsWith(suffix))?.content ?? "";

/** The `module "<name>" { … }` block of a root `main.tf`, or undefined. */
function moduleBlock(main: string, name: string): string | undefined {
  return main.match(new RegExp(`^module "${name}" \\{$[\\s\\S]*?^\\}$`, "m"))?.[0];
}

/** Output name → value expression of a root `outputs.tf`. */
function outputs(outputsTf: string): Record<string, string> {
  return Object.fromEntries(
    [...outputsTf.matchAll(/^output "([^"]+)" \{\n {2}value = (.+)\n\}$/gm)].map((m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  );
}

/**
 * The `servers` output of a root `outputs.tf`: provider → the module its entry reads (each entry
 * must read `ipv4`, `ipv6` and `id` from that one module).
 */
function serversOutput(outputsTf: string): Record<string, string> {
  const body =
    /^output "servers" \{\n {2}value = \{\n([\s\S]*?)^ {2}\}\n\}$/m.exec(outputsTf)?.[1] ?? "";
  const entries: Record<string, string> = {};
  const entry =
    /^ {4}(\w+) = \{\n {6}ipv4 = module\.(\w+)\.ipv4_address\n {6}ipv6 = module\.\2\.ipv6_address\n {6}id {3}= module\.\2\.server_id\n {4}\}$/gm;
  let rest = body;
  for (const m of body.matchAll(entry)) {
    entries[m[1] ?? ""] = m[2] ?? "";
    rest = rest.replace(m[0], "");
  }
  // Nothing else in the object.
  expect(rest.trim()).toBe("");
  return entries;
}

const variableNames = (variablesTf: string) =>
  [...variablesTf.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1]);

describe("renderInfra move layouts (snapshots)", () => {
  for (const [from, to] of DIRECTIONS) {
    describe(`${from} to ${to}`, () => {
      for (const name of LAYOUT_NAMES) {
        it(`renders the ${name} layout`, () => {
          const files = render(name, from, to);
          expect(content(files, "prod/main.tf")).toMatchSnapshot("main.tf");
          expect(content(files, "prod/variables.tf")).toMatchSnapshot("variables.tf");
          expect(content(files, "prod/outputs.tf")).toMatchSnapshot("outputs.tf");
          expect(content(files, "prod/terraform.tfvars.json")).toMatchSnapshot(
            "terraform.tfvars.json",
          );
        });
      }

      it("requires both providers and Cloudflare in versions.tf for every layout", () => {
        const versions = LAYOUT_NAMES.map((name) =>
          content(render(name, from, to), "prod/versions.tf"),
        );
        expect(new Set(versions).size).toBe(1);
        expect(versions[0]).toMatchSnapshot("versions.tf");
      });
    });
  }
});

describe("renderInfra move layouts", () => {
  it("renders a moved block only in the moves-only layouts", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const main = content(render(name, from, to), "prod/main.tf");
        const moved = main.match(/^moved \{$[\s\S]*?^\}$/gm) ?? [];
        if (!MOVES_ONLY.includes(name)) {
          expect(moved, `${from} to ${to}, ${name}`).toEqual([]);
          continue;
        }
        const [source, destination] =
          name === "rename" ? ["server", "server_previous"] : ["server_previous", "server"];
        expect(moved, `${from} to ${to}, ${name}`).toEqual([
          ["moved {", `  from = module.${source}`, `  to   = module.${destination}`, "}"].join(
            "\n",
          ),
        ]);
        // A move cannot free an address the same configuration declares again.
        expect(moduleBlock(main, source)).toBeUndefined();
        expect(moduleBlock(main, destination)).toBeDefined();
      }
    }
  });

  it("renders the server modules of each layout with their own provider's module", () => {
    const expected: Record<LayoutName, { server?: "from" | "to"; previous?: "from" }> = {
      rename: { previous: "from" },
      both: { server: "to", previous: "from" },
      switched: { server: "to", previous: "from" },
      finish: { server: "to" },
      "abort-remove": { previous: "from" },
      "abort-rename": { server: "from" },
    };
    for (const [from, to] of DIRECTIONS) {
      const providers = { from, to };
      for (const name of LAYOUT_NAMES) {
        const main = content(render(name, from, to), "prod/main.tf");
        const { server, previous } = expected[name];
        const label = `${from} to ${to}, ${name}`;
        const serverBlock = moduleBlock(main, "server");
        const previousBlock = moduleBlock(main, "server_previous");
        if (server) {
          expect(serverBlock, label).toContain(
            `source = "../modules/${MODULE_DIRS[providers[server]]}"`,
          );
        } else {
          expect(serverBlock, label).toBeUndefined();
        }
        if (previous) {
          expect(previousBlock, label).toContain(
            `source = "../modules/${MODULE_DIRS[providers[previous]]}"`,
          );
        } else {
          expect(previousBlock, label).toBeUndefined();
        }
      }
    }
  });

  it("points DNS and the server outputs at the live module", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const live = layoutFor(name, from, to).live;
        const files = render(name, from, to);
        const dns = moduleBlock(content(files, "prod/main.tf"), "dns") ?? "";
        expect(dns).toMatch(new RegExp(`^ {2}ipv4 += module\\.${live}\\.ipv4_address$`, "m"));
        expect(dns).toMatch(new RegExp(`^ {2}ipv6 += module\\.${live}\\.ipv6_address$`, "m"));
        expect(outputs(content(files, "prod/outputs.tf"))).toMatchObject({
          server_ipv4: `module.${live}.ipv4_address`,
          server_ipv6: `module.${live}.ipv6_address`,
          server_id: `module.${live}.server_id`,
          server_name: `module.${live}.server_name`,
          url: "module.dns.url",
        });
      }
    }
  });

  it("lists every server by its provider, whichever module holds it", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const layout = layoutFor(name, from, to);
        const outputsTf = content(render(name, from, to), "prod/outputs.tf");
        const label = `${from} to ${to}, ${name}`;
        const expected: Record<string, ServerModule> = {};
        if (layout.server) expected[layout.server.provider] = "server";
        if (layout.previous) expected[layout.previous.provider] = "server_previous";
        expect(serversOutput(outputsTf), label).toEqual(expected);
        // The old server is always `from`'s provider and the new one `to`'s, in every layout.
        if (layout.previous) expect(layout.previous.provider, label).toBe(from);
        expect(Object.keys(outputs(outputsTf)), label).toEqual([
          "server_ipv4",
          "server_ipv6",
          "server_id",
          "server_name",
          "url",
        ]);
        expect(outputsTf, label).not.toContain("other_");
      }
    }
  });

  it("lists the one server by its provider without a move", () => {
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const files = renderInfra(testPlan({ provider }), testContext());
      expect(serversOutput(content(files, "prod/outputs.tf"))).toEqual({ [provider]: "server" });
    }
  });

  it("serves the live module's address as the URL without a domain", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const live = layoutFor(name, from, to).live;
        const files = render(name, from, to, false);
        const main = content(files, "prod/main.tf");
        expect(moduleBlock(main, "dns")).toBeUndefined();
        expect(main).not.toContain("cloudflare");
        expect(content(files, "prod/versions.tf")).not.toContain("cloudflare");
        expect(outputs(content(files, "prod/outputs.tf")).url).toBe(
          `"http://\${module.${live}.ipv4_address}"`,
        );
      }
    }
  });

  it("renders both providers' blocks and requirements and vendors both modules", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const files = render(name, from, to);
        const label = `${from} to ${to}, ${name}`;
        const main = content(files, "prod/main.tf");
        const versions = content(files, "prod/versions.tf");
        for (const provider of [from, to]) {
          expect(main, label).toContain(
            `# Token from the ${TOKEN_VARS[provider]} environment variable (never stored in files or state).`,
          );
        }
        expect([...main.matchAll(/^provider "([^"]+)" \{\}$/gm)].map((m) => m[1])).toEqual([
          ...[from, to].map((p) => (p === "hetzner" ? "hcloud" : "digitalocean")),
          "cloudflare",
        ]);
        expect(versions).toContain('source  = "hetznercloud/hcloud"');
        expect(versions).toContain('source  = "digitalocean/digitalocean"');
        expect(versions).toContain('source  = "cloudflare/cloudflare"');
        const vendored = new Set(
          files
            .filter((f) => f.path.startsWith("opscrew/infra/modules/"))
            .map((f) => f.path.split("/")[3]),
        );
        expect(vendored, label).toEqual(
          new Set(["cloudflare-dns", "digitalocean-droplet", "hetzner-vps"]),
        );
      }
    }
  });

  it("passes the previous server its own variables and the same labels and tags", () => {
    const hetznerPrevious = moduleBlock(
      content(render("both", "hetzner", "digitalocean"), "prod/main.tf"),
      "server_previous",
    );
    expect(hetznerPrevious).toBe(
      [
        'module "server_previous" {',
        '  source = "../modules/hetzner-vps"',
        "",
        "  name               = var.app_name",
        "  location           = var.previous_location",
        "  server_type        = var.previous_server_type",
        "  image              = var.previous_image",
        "  backups            = var.previous_backups",
        "  delete_protection  = var.previous_delete_protection",
        "  ssh_public_key     = var.deploy_ssh_public_key",
        "  ssh_allowed_cidrs  = var.ssh_allowed_cidrs",
        "  http_allowed_cidrs = var.http_allowed_cidrs",
        '  labels             = { "managed-by" = "opscrew", app = var.app_name }',
        "}",
      ].join("\n"),
    );
    const doPrevious = moduleBlock(
      content(render("both", "digitalocean", "hetzner"), "prod/main.tf"),
      "server_previous",
    );
    expect(doPrevious).toBe(
      [
        'module "server_previous" {',
        '  source = "../modules/digitalocean-droplet"',
        "",
        "  name               = var.app_name",
        "  region             = var.previous_location",
        "  size               = var.previous_server_type",
        "  image              = var.previous_image",
        "  backups            = var.previous_backups",
        "  ssh_public_key     = var.deploy_ssh_public_key",
        "  ssh_allowed_cidrs  = var.ssh_allowed_cidrs",
        "  http_allowed_cidrs = var.http_allowed_cidrs",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  app_tag            = "opscrew-app:${var.app_name}"',
        '  shared_tags        = ["managed-by:opscrew"]',
        "}",
      ].join("\n"),
    );
    // The new Hetzner server keeps the usual `delete_protection` variable.
    expect(
      moduleBlock(content(render("both", "digitalocean", "hetzner"), "prod/main.tf"), "server"),
    ).toMatch(/^ {2}delete_protection +=\s*var\.delete_protection$/m);
  });

  it("keeps delete protection in variables with a default, never in tfvars", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const layout = layoutFor(name, from, to);
        const files = render(name, from, to);
        const label = `${from} to ${to}, ${name}`;
        const names = variableNames(content(files, "prod/variables.tf"));
        expect(names.includes("delete_protection"), label).toBe(
          layout.server?.provider === "hetzner",
        );
        expect(names.includes("previous_delete_protection"), label).toBe(
          layout.previous?.provider === "hetzner",
        );
        expect(content(files, "tfvars.json"), label).not.toContain("protection");
        for (const variable of ["delete_protection", "previous_delete_protection"]) {
          if (!names.includes(variable)) continue;
          expect(content(files, "prod/variables.tf")).toMatch(
            new RegExp(`variable "${variable}" \\{\\n[^}]*\\n {2}default {5}= true\\n\\}`),
          );
        }
        // DigitalOcean modules get no protection argument.
        for (const module of ["server", "server_previous"] as const) {
          const target = module === "server" ? layout.server : layout.previous;
          if (target?.provider !== "digitalocean") continue;
          expect(moduleBlock(content(files, "prod/main.tf"), module), label).not.toContain(
            "protection",
          );
        }
      }
    }
  });

  it("writes each server's target to tfvars under its own variables", () => {
    const hetzner = testTarget("hetzner");
    const digitalocean = testTarget("digitalocean");
    const values = (name: LayoutName) =>
      JSON.parse(content(render(name, "hetzner", "digitalocean"), "tfvars.json"));
    const current = {
      location: digitalocean.location,
      server_type: digitalocean.serverType,
      image: digitalocean.image,
      backups: digitalocean.backups,
    };
    const previous = {
      previous_location: hetzner.location,
      previous_server_type: hetzner.serverType,
      previous_image: hetzner.image,
      previous_backups: hetzner.backups,
    };
    expect(values("both")).toMatchObject({ app_name: "shop", ...current, ...previous });
    expect(values("switched")).toMatchObject({ ...current, ...previous });
    expect(values("rename")).toMatchObject(previous);
    expect(values("rename")).not.toHaveProperty("location");
    expect(values("abort-remove")).toMatchObject(previous);
    expect(values("finish")).toMatchObject(current);
    expect(values("finish")).not.toHaveProperty("previous_location");
    expect(values("abort-rename")).toMatchObject({
      location: hetzner.location,
      server_type: hetzner.serverType,
      image: hetzner.image,
      backups: hetzner.backups,
    });
    expect(values("abort-rename")).not.toHaveProperty("previous_location");
    // Every value in tfvars belongs to a declared variable without a default.
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const files = render(name, from, to);
        const declared = variableNames(content(files, "prod/variables.tf")).filter(
          (v) => !v?.endsWith("delete_protection"),
        );
        expect(Object.keys(JSON.parse(content(files, "tfvars.json")))).toEqual(declared);
      }
    }
  });

  it("notes the move at the top of main.tf", () => {
    for (const name of LAYOUT_NAMES) {
      const main = content(render(name, "hetzner", "digitalocean"), "prod/main.tf");
      const note = main.split("\n\n")[1] ?? "";
      expect(note).toMatch(/^# A move to another provider is in progress/);
      expect(note).toContain("`opscrew retarget --finish`");
      expect(note).toContain("`opscrew retarget --abort`");
    }
  });

  it("differs from the plain root module only by the note for a one-server layout", () => {
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const plan = movePlan(provider);
      const plain = renderInfra(plan, testContext({ cloudflare: testCloudflare() }));
      const withLayout = renderInfra(
        plan,
        testContext({
          cloudflare: testCloudflare(),
          layout: { server: testTarget(provider), live: "server", providers: [provider] },
        }),
      );
      expect(withLayout.map((f) => f.path)).toEqual(plain.map((f) => f.path));
      for (const [i, file] of withLayout.entries()) {
        if (file.path.endsWith("prod/main.tf")) {
          expect(file.content).not.toBe(plain[i]?.content);
          expect(file.content.replace(/\n# A move[^\n]*\n[^\n]*\n/, "")).toBe(plain[i]?.content);
        } else {
          expect(file).toEqual(plain[i]);
        }
      }
    }
  });

  it("is honoured by renderDeployment", () => {
    const plan = movePlan("digitalocean");
    const layout = layoutFor("both", "hetzner", "digitalocean");
    const files = renderDeployment(plan, testContext({ cloudflare: testCloudflare(), layout }));
    expect(content(files, "prod/main.tf")).toContain('module "server_previous" {');
    const plain = renderDeployment(plan, testContext({ cloudflare: testCloudflare() }));
    // Only infrastructure files depend on the layout.
    expect(files.filter((f) => f.kind !== "infra")).toEqual(
      plain.filter((f) => f.kind !== "infra"),
    );
  });

  it("rejects layouts the engines would reject", () => {
    const from = testTarget("hetzner");
    const to = testTarget("digitalocean");
    const plan = movePlan("digitalocean");
    const attempt = (layout: InfraLayout) => () =>
      renderInfra(plan, testContext({ cloudflare: testCloudflare(), layout }));
    const providers = ["hetzner", "digitalocean"] as const;
    expect(attempt({ previous: from, live: "server", providers })).toThrow(/module "server"/);
    expect(attempt({ live: "server", providers })).toThrow(/no server module/);
    expect(
      attempt({
        server: to,
        previous: from,
        moved: { from: "server", to: "server_previous" },
        live: "server",
        providers,
      }),
    ).toThrow(/moved/);
    expect(
      attempt({ server: to, moved: { from: "server", to: "server" }, live: "server", providers }),
    ).toThrow(/moved/);
    expect(
      attempt({
        moved: { from: "server", to: "server_previous" },
        server: to,
        live: "server",
        providers,
      }),
    ).toThrow(/moved/);
    expect(
      attempt({ server: to, previous: from, live: "server", providers: ["digitalocean"] }),
    ).toThrow(/hetzner/);
    // Two servers on one provider would get the same resource names.
    expect(
      attempt({ server: to, previous: to, live: "server", providers: ["digitalocean"] }),
    ).toThrow(/two different providers/);
  });

  it("is deterministic, dialect-neutral and free of secrets and absolute paths", () => {
    for (const [from, to] of DIRECTIONS) {
      for (const name of LAYOUT_NAMES) {
        const rendered = render(name, from, to);
        expect(render(name, from, to)).toEqual(rendered);
        const tf = rendered.filter((f) => f.path.endsWith(".tf"));
        expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
        for (const file of rendered) {
          expect(file.content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
          expect(file.content).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
          expect(file.content.endsWith("\n")).toBe(true);
        }
      }
    }
  });

  it("exposes tfvars for a layout", () => {
    const plan = movePlan("digitalocean");
    const layout = layoutFor("switched", "hetzner", "digitalocean");
    expect(tfvars(plan, testContext({ cloudflare: testCloudflare(), layout }))).toMatchObject({
      previous_location: "nbg1",
      location: "fra1",
    });
  });
});
