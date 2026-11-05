// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
// Feature 023: the move's layouts between every pair of server targets. A cloud side is a server
// module; a server the user owns and a Portainer environment are an address the DNS records point
// at (T2305, ADR 0027).
import { checkDialect } from "@opscrew/iac-engine";
import { describe, expect, it } from "vitest";
import { testCloudflare, testContext } from "../__fixtures__/plans";
import type { RenderContext, RenderedFile, ServerModule } from "../types";
import {
  ADDRESS_PAIRS,
  type MovePlanOptions,
  movePlan,
  PAIRS,
  type SideName,
  sideTarget,
} from "./__fixtures__/sides";
import { MOVE_LAYOUTS, type MoveLayoutName, moveLayout, renderInfra, tfvars } from "./index";

const isCloud = (side: SideName) => side === "hetzner" || side === "digitalocean";
const ZONE_ID = testCloudflare().zoneId;
// Cloudflare record ids are 32 hex digits; these are made up.
const RECORD_IDS = { a: "a".repeat(32), aaaa: "b".repeat(32), www: "c".repeat(32) };

interface RenderOptions extends MovePlanOptions {
  /** The old Portainer side's `web.records` (default true). */
  fromRecords?: boolean;
  ctx?: Partial<RenderContext>;
}

function render(
  name: MoveLayoutName,
  from: SideName,
  to: SideName,
  o: RenderOptions = {},
): RenderedFile[] {
  const plan = movePlan(to, o);
  const previous = sideTarget(from, { ...o, records: o.fromRecords ?? true });
  return renderInfra(
    plan,
    testContext({
      ...(o.domain === false ? {} : { cloudflare: testCloudflare() }),
      layout: moveLayout(name, previous, plan.target),
      ...o.ctx,
    }),
  );
}

const content = (files: readonly RenderedFile[], suffix: string) =>
  files.find((f) => f.path.endsWith(suffix))?.content ?? "";

/** The `module "<name>" { … }` block of a root `main.tf`, or undefined. */
function moduleBlock(main: string, name: string): string | undefined {
  return main.match(new RegExp(`^module "${name}" \\{$[\\s\\S]*?^\\}$`, "m"))?.[0];
}

/** Output name → value expression of a root `outputs.tf` (single-line values). */
function outputs(outputsTf: string): Record<string, string> {
  return Object.fromEntries(
    [...outputsTf.matchAll(/^output "([^"]+)" \{\n {2}value = (.+)\n\}$/gm)].map((m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  );
}

const variableNames = (variablesTf: string) =>
  [...variablesTf.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1] ?? "");

/** What each layout holds: the side in each slot, and the slot DNS follows. */
const SLOTS: Record<
  MoveLayoutName,
  { server?: "from" | "to"; previous?: "from"; live: ServerModule }
> = {
  rename: { previous: "from", live: "server_previous" },
  both: { server: "to", previous: "from", live: "server_previous" },
  switched: { server: "to", previous: "from", live: "server" },
  finish: { server: "to", live: "server" },
  "abort-remove": { previous: "from", live: "server_previous" },
  "abort-rename": { server: "from", live: "server" },
};

/** The side in `slot` of layout `name` of the move from `from` to `to`, if any. */
function sideIn(
  name: MoveLayoutName,
  slot: ServerModule,
  from: SideName,
  to: SideName,
): SideName | undefined {
  const which = SLOTS[name][slot === "server" ? "server" : "previous"];
  return which === undefined ? undefined : { from, to }[which];
}

/** The HCL expression of the IPv4 address of the side in `slot`. */
function ipv4Of(side: SideName, slot: ServerModule): string {
  if (isCloud(side)) return `module.${slot}.ipv4_address`;
  return `var.${slot === "server" ? "" : "previous_"}server_ipv4`;
}

describe("moveLayout between every pair of server targets", () => {
  it("puts each side in its slot, moves only a cloud server and lists only cloud providers", () => {
    for (const [from, to] of PAIRS) {
      const previous = sideTarget(from);
      const next = sideTarget(to);
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const layout = moveLayout(name, previous, next);
        const slots = SLOTS[name];
        expect(layout.server, label).toEqual(
          slots.server === undefined ? undefined : { from: previous, to: next }[slots.server],
        );
        expect(layout.previous, label).toEqual(slots.previous ? previous : undefined);
        expect(layout.live, label).toBe(slots.live);
        expect(layout.providers, label).toEqual([from, to].filter(isCloud));
        const moved =
          name === "rename"
            ? { from: "server", to: "server_previous" }
            : name === "abort-rename"
              ? { from: "server_previous", to: "server" }
              : undefined;
        expect(layout.moved, label).toEqual(isCloud(from) ? moved : undefined);
      }
    }
  });

  it("refuses a side without a public address: a tunnel, or a target that is no server", () => {
    const refusal = expect.objectContaining({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("bug in OpsCrew"),
    });
    const hetzner = sideTarget("hetzner");
    const ownTunnel = { provider: "own", mode: "vps-compose", arch: "amd64", access: "tunnel" };
    const portainer = sideTarget("portainer");
    if (portainer.provider !== "portainer") throw new Error("not a Portainer target");
    const localhost = {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: { https: 443, http: 80 },
      image: "registry",
      edge: "caddy",
    };
    for (const side of [
      { ...ownTunnel, edge: "caddy" },
      { ...portainer, web: { mode: "tunnel" } },
      { ...portainer, redeploy: "cloudflare" },
      localhost,
    ] as Parameters<typeof moveLayout>[1][]) {
      for (const name of MOVE_LAYOUTS) {
        expect(() => moveLayout(name, side, hetzner)).toThrow(refusal);
        expect(() => moveLayout(name, hetzner, side)).toThrow(refusal);
      }
    }
  });
});

describe("renderInfra with an address side", () => {
  it("renders a server module only for a cloud side, and an address for the others", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const files = render(name, from, to);
        const main = content(files, "prod/main.tf");
        const names = variableNames(content(files, "prod/variables.tf"));
        for (const [slot, prefix] of [
          ["server", ""],
          ["server_previous", "previous_"],
        ] as const) {
          const side = sideIn(name, slot, from, to);
          const cloud = side !== undefined && isCloud(side);
          const address = side !== undefined && !isCloud(side);
          expect(moduleBlock(main, slot) !== undefined, `${label}: module ${slot}`).toBe(cloud);
          expect(names.includes(`${prefix}server_ipv4`), `${label}: ${slot} address`).toBe(address);
          expect(names.includes(`${prefix}server_ipv6`), `${label}: ${slot} address`).toBe(address);
        }
        for (const prefix of ["", "previous_"]) {
          if (!names.includes(`${prefix}server_ipv4`)) continue;
          const variablesTf = content(files, "prod/variables.tf");
          expect(variablesTf, label).toMatch(
            new RegExp(`variable "${prefix}server_ipv6" \\{\\n[^}]*\\n {2}default {5}= null\\n\\}`),
          );
          expect(variablesTf, label).toContain(
            `OpsCrew passes it as TF_VAR_${prefix}server_ipv4 from .opscrew/server.json; it is never written to a committed file.`,
          );
        }
      }
    }
  });

  it("points DNS and the server outputs at the live side", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const live = SLOTS[name].live;
        const side = sideIn(name, live, from, to) as SideName;
        const files = render(name, from, to);
        const dns = moduleBlock(content(files, "prod/main.tf"), "dns") ?? "";
        const ipv4 = ipv4Of(side, live);
        const ipv6 = ipv4.replace("ipv4", "ipv6");
        expect(dns, label).toMatch(new RegExp(`^ {2}ipv4 += ${ipv4.replace(/\./g, "\\.")}$`, "m"));
        expect(dns, label).toMatch(new RegExp(`^ {2}ipv6 += ${ipv6.replace(/\./g, "\\.")}$`, "m"));
        const values = outputs(content(files, "prod/outputs.tf"));
        expect(values, label).toMatchObject({
          server_ipv4: ipv4,
          server_ipv6: ipv6,
          url: "module.dns.url",
        });
        // Only a server OpsCrew creates has an id and a name.
        expect("server_id" in values, label).toBe(isCloud(side));
        expect("server_name" in values, label).toBe(isCloud(side));
        // Without a domain, the URL is the live side's address.
        const bare = outputs(content(render(name, from, to, { domain: false }), "prod/outputs.tf"));
        expect(bare.url, label).toBe(`"http://\${${ipv4}}"`);
      }
    }
  });

  it("lists only the servers OpsCrew creates in the servers output, by provider", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const outputsTf = content(render(name, from, to), "prod/outputs.tf");
        const expected = (["server", "server_previous"] as const).flatMap((slot) => {
          const side = sideIn(name, slot, from, to);
          return side !== undefined && isCloud(side) ? [`    ${side} = {`] : [];
        });
        const listed = /^output "servers" \{\n {2}value = \{\n([\s\S]*?)^ {2}\}\n\}$/m.exec(
          outputsTf,
        )?.[1];
        if (expected.length === 0) {
          expect(outputsTf, label).not.toContain('output "servers"');
        } else {
          expect(listed?.match(/^ {4}\w+ = \{$/gm), label).toEqual(expected);
        }
      }
    }
  });

  it("never writes an address to tfvars, and declares every value it writes", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const files = render(name, from, to);
        const variablesTf = content(files, "prod/variables.tf");
        const values = JSON.parse(content(files, "tfvars.json")) as Record<string, unknown>;
        const withoutDefault = variableNames(variablesTf).filter(
          (v) => !new RegExp(`variable "${v}" \\{[^}]*default`).test(variablesTf),
        );
        expect(Object.keys(values), label).toEqual(
          withoutDefault.filter((v) => !/ipv[46]/.test(v)),
        );
        expect(JSON.stringify(values), label).not.toMatch(/ipv[46]|server_ip/);
        // A deploy key and SSH networks only for a server OpsCrew creates, the web's networks only
        // for a server that serves the app.
        const modules = (["server", "server_previous"] as const).some((slot) => {
          const side = sideIn(name, slot, from, to);
          return side !== undefined && isCloud(side);
        });
        expect("deploy_ssh_public_key" in values, label).toBe(modules);
        expect("ssh_allowed_cidrs" in values, label).toBe(modules);
        expect("http_allowed_cidrs" in values, label).toBe(modules);
      }
    }
  });

  it("switches DNS by updating the records only: both and switched differ only in their addresses", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const options of [{}, { proxied: false }] as const) {
        const label = `${from} to ${to}, ${JSON.stringify(options)}`;
        const both = render("both", from, to, options);
        const switched = render("switched", from, to, options);
        const addressLines = /^ {2}ipv[46] += .+$/gm;
        const main = (files: RenderedFile[]) => content(files, "prod/main.tf");
        expect(main(switched), label).not.toBe(main(both));
        expect(main(switched).replace(addressLines, ""), label).toBe(
          main(both).replace(addressLines, ""),
        );
        for (const file of ["variables.tf", "versions.tf", "terraform.tfvars.json"]) {
          expect(content(switched, `prod/${file}`), `${label}: ${file}`).toBe(
            content(both, `prod/${file}`),
          );
        }
      }
    }
  });

  it("keeps the AAAA record only while every address side has IPv6, and never behind the web filter", () => {
    const ipv6Record = (files: RenderedFile[]) =>
      /^ {2}ipv6_record += (.+)$/m.exec(
        moduleBlock(content(files, "prod/main.tf"), "dns") ?? "",
      )?.[1];
    const dnsOnly = { proxied: false };
    expect(ipv6Record(render("both", "hetzner", "own", dnsOnly))).toBe("var.server_ipv6 != null");
    expect(ipv6Record(render("both", "own", "digitalocean", dnsOnly))).toBe(
      "var.previous_server_ipv6 != null",
    );
    expect(ipv6Record(render("both", "own", "portainer", dnsOnly))).toBe(
      "var.server_ipv6 != null && var.previous_server_ipv6 != null",
    );
    expect(ipv6Record(render("finish", "own", "portainer", dnsOnly))).toBe(
      "var.server_ipv6 != null",
    );
    expect(ipv6Record(render("finish", "own", "hetzner", dnsOnly))).toBeUndefined();
    expect(ipv6Record(render("both", "hetzner", "digitalocean", dnsOnly))).toBeUndefined();
    // Behind the web filter a server the user owns serves IPv4 only: no AAAA while it is a side.
    expect(ipv6Record(render("both", "hetzner", "own"))).toBe("false");
    expect(ipv6Record(render("abort-rename", "own", "portainer"))).toBe("false");
    expect(ipv6Record(render("finish", "own", "portainer"))).toBe("var.server_ipv6 != null");
    expect(ipv6Record(render("both", "portainer", "portainer"))).toBe(
      "var.server_ipv6 != null && var.previous_server_ipv6 != null",
    );
  });

  it("finishes with the same DNS module as the new side's own root", () => {
    for (const to of ["own", "portainer"] as const) {
      for (const options of [{}, { proxied: false }] as const) {
        const plan = movePlan(to, options);
        const final = renderInfra(plan, testContext({ cloudflare: testCloudflare() }));
        for (const from of ["hetzner", "own", "portainer"] as const) {
          const finish = render("finish", from, to, options);
          expect(moduleBlock(content(finish, "prod/main.tf"), "dns"), `${from} to ${to}`).toBe(
            moduleBlock(content(final, "prod/main.tf"), "dns"),
          );
        }
      }
    }
  });

  it("notes a move to another server at the top of main.tf", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      const main = content(render("both", from, to), "prod/main.tf");
      expect(main.split("\n\n")[1], `${from} to ${to}`).toMatch(
        /^# A move to another server is in progress: `opscrew retarget` manages these files until the\n/,
      );
    }
  });

  it("is deterministic, dialect-neutral and free of secrets, addresses and absolute paths", () => {
    for (const [from, to] of ADDRESS_PAIRS) {
      for (const name of MOVE_LAYOUTS) {
        const rendered = render(name, from, to);
        expect(render(name, from, to)).toEqual(rendered);
        const tf = rendered.filter((f) => f.path.endsWith(".tf"));
        expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
        for (const file of rendered) {
          expect(file.content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
          expect(file.content).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
          expect(file.content).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b(?!\/)/);
          expect(file.content.endsWith("\n")).toBe(true);
        }
      }
    }
  });

  it("matches the snapshots", () => {
    for (const [name, from, to] of [
      ["switched", "hetzner", "own"],
      ["both", "own", "portainer"],
      ["finish", "own", "own"],
      ["abort-remove", "portainer", "digitalocean"],
    ] as const) {
      const files = render(name, from, to, { proxied: false });
      for (const file of ["main.tf", "variables.tf", "outputs.tf", "terraform.tfvars.json"]) {
        expect(content(files, `prod/${file}`)).toMatchSnapshot(
          `${from} to ${to}, ${name}, ${file}`,
        );
      }
    }
  });

  it("exposes tfvars without the addresses", () => {
    const plan = movePlan("own");
    const layout = moveLayout("switched", sideTarget("hetzner"), plan.target);
    const values = tfvars(plan, testContext({ cloudflare: testCloudflare(), layout }));
    expect(values).toMatchObject({ app_name: "shop", previous_location: "nbg1" });
    expect(values).not.toHaveProperty("server_ipv4");
  });
});

describe("renderInfra adopting a Portainer side's records", () => {
  const adopt = (ids: RenderContext["adoptRecords"]) => ({
    fromRecords: false,
    ctx: { adoptRecords: ids },
  });

  /** The `import { … }` blocks of a root `main.tf`. */
  const imports = (files: readonly RenderedFile[]) =>
    content(files, "prod/main.tf").match(/^import \{$[\s\S]*?^\}$/gm) ?? [];
  const block = (to: string, id: string) =>
    [
      "import {",
      `  to = module.dns.cloudflare_dns_record.${to}`,
      `  id = "${ZONE_ID}/${id}"`,
      "}",
    ].join("\n");

  it("imports the user's records into the DNS module, in every layout that renders it", () => {
    for (const to of ["hetzner", "own", "portainer"] as const) {
      for (const name of MOVE_LAYOUTS) {
        expect(imports(render(name, "portainer", to, adopt(RECORD_IDS))), `${to}, ${name}`).toEqual(
          [
            block("a", RECORD_IDS.a),
            block("aaaa[0]", RECORD_IDS.aaaa),
            block("www[0]", RECORD_IDS.www),
          ],
        );
      }
    }
    expect(imports(render("switched", "portainer", "hetzner", adopt({ a: RECORD_IDS.a })))).toEqual(
      [block("a", RECORD_IDS.a)],
    );
  });

  it("keeps the switch an update of the records: both and switched import the same records", () => {
    const both = render("both", "portainer", "digitalocean", adopt(RECORD_IDS));
    const switched = render("switched", "portainer", "digitalocean", adopt(RECORD_IDS));
    const addressLines = /^ {2}ipv[46] += .+$/gm;
    expect(content(switched, "prod/main.tf").replace(addressLines, "")).toBe(
      content(both, "prod/main.tf").replace(addressLines, ""),
    );
  });

  it("refuses to render the records of a Portainer side that are still the user's without their ids", () => {
    const refusal = expect.objectContaining({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("still yours"),
    });
    for (const [from, to] of [
      ["portainer", "hetzner"],
      ["own", "portainer"],
    ] as const) {
      const options = from === "portainer" ? { fromRecords: false } : { records: false };
      for (const name of MOVE_LAYOUTS) {
        const label = `${from} to ${to}, ${name}`;
        const holdsPortainer = (["server", "server_previous"] as const).some(
          (slot) => sideIn(name, slot, from, to) === "portainer",
        );
        if (holdsPortainer) {
          expect(() => render(name, from, to, options), label).toThrow(refusal);
        } else {
          expect(imports(render(name, from, to, options)), label).toEqual([]);
        }
        // Without a domain on Cloudflare there are no records to adopt.
        expect(imports(render(name, from, to, { ...options, domain: false })), label).toEqual([]);
      }
    }
    // Records OpsCrew manages are in its state already.
    expect(imports(render("switched", "portainer", "hetzner"))).toEqual([]);
  });

  it("matches the snapshot", () => {
    const files = render("switched", "portainer", "digitalocean", {
      ...adopt(RECORD_IDS),
      proxied: false,
    });
    expect(content(files, "prod/main.tf")).toMatchSnapshot();
  });
});
