/**
 * `status`, `drift`, `verify`, `secure` and `advise` of a preview environment on dev's server
 * (spec.md US9, FR-2229): what reaches the server goes through dev's login (`previewServer`); what
 * is dev's server's own is said to be dev's.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { sha256Hex } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAdvise } from "../advise/run";
import { previewRecipeDrift } from "../drift/previews";
import { dockerLogs } from "../logs/targets";
import { runSecure } from "../secure/run";
import { readServerAddresses, recordOwnServer } from "../shared";
import { appMemoryMb } from "../shared/memory";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import { componentStatusReport } from "../status/run";
import {
  ED25519,
  ED25519_FINGERPRINT,
  figuresOutput,
  freshFacts,
  HOST_ADMIN,
  HOST_IPV4,
  ownRunner,
  PREVIEW_ZONE,
} from "../testing";
import { runVerify } from "../verify/run";
import { fakeShell, HOST_SSH_PORT, LIST_OUTPUT, sharedPreviewProject } from "./__fixtures__/plan";

const SCRIPT = "#!/bin/sh\necho preview\n";

/** A deploy shell answering the figures and the preview command; it keeps the hosts it reached. */
function devShell(app: string) {
  const hosts: string[] = [];
  const shell = fakeShell((command) =>
    command.includes("==opscrew-figures:")
      ? { exitCode: 0, stdout: figuresOutput(app, { containers: [] }) }
      : command.endsWith("opscrew-preview list")
        ? { exitCode: 0, stdout: LIST_OUTPUT }
        : { exitCode: 0, stdout: "" },
  );
  return {
    hosts,
    commands: shell.commands,
    remote: (host: string) => {
      hosts.push(host);
      return shell.remote(host);
    },
  };
}

describe("a preview environment on dev's server, a server OpsCrew created", () => {
  it("status reads dev's server's figures and the previews through dev's deploy login", async () => {
    const { deps, plan } = await sharedPreviewProject();
    const shell = devShell(plan.app.name);
    const report = await componentStatusReport(deps, plan, {
      services: { remote: shell.remote },
    });
    const text = report.lines.join("\n");
    expect(text).toContain("Resources (read now):");
    expect(text).toContain("Previews: 2 of at most 3.");
    expect(new Set(shell.hosts)).toEqual(new Set([HOST_IPV4]));
    // The figures of the previews' own containers, never dev's app's.
    expect(shell.commands[0]).toContain("com.docker.compose.project=shop-preview");
    const said = [text, deps.reporter.text(), JSON.stringify(deps.audit.entries)].join("\n");
    expect(said).not.toContain(HOST_IPV4);
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
  });

  it("drift compares the recipe on dev's server through dev's login", async () => {
    const { deps, plan } = await sharedPreviewProject();
    const folder = join(deps.paths.artefactsDir, "previews");
    await mkdir(join(folder, "bin"), { recursive: true });
    await writeFile(join(folder, "bin/opscrew-preview"), SCRIPT);
    const shell = devShell(plan.app.name);
    const facts = HostFactsSchema.parse({
      ...freshFacts({ user: "deploy" }),
      deployUser: {
        groups: ["deploy", "docker"],
        keys: [],
        previewKeys: [
          'restrict,command="/srv/apps/shop-preview/bin/opscrew-preview" ssh-ed25519 AAAAC3Nz opscrew-preview:acme/shop:shop-preview',
        ],
      },
      previews: [
        {
          app: "shop-preview",
          files: { "bin/opscrew-preview": sha256Hex(SCRIPT) },
          values: true,
          tls: true,
          cron: ["17 * * * * /srv/apps/shop-preview/bin/opscrew-preview gc"],
          numbers: [],
        },
      ],
    });
    const inspected: string[] = [];
    const notes: string[] = [];
    const found = await previewRecipeDrift(deps, plan, notes, {
      services: { remote: shell.remote },
      inspect: async (remote) => {
        inspected.push(remote.host);
        return facts;
      },
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
    expect(inspected).toEqual([HOST_IPV4]);
  });

  it("verify checks the previews through dev's deploy login", async () => {
    const { deps } = await sharedPreviewProject();
    const shell = devShell("shop-preview");
    const result = await runVerify(deps, {
      remote: shell.remote,
      tlsConnect: async () => ({
        subjectAltNames: [PREVIEW_ZONE, `*.${PREVIEW_ZONE}`],
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-12-30T00:00:00.000Z",
        issuer: "Google Trust Services",
      }),
      fetch: async () => new Response("ok", { status: 200 }),
    });
    expect(result.checks[0]).toMatchObject({ id: "preview-server", status: "pass" });
    expect(new Set(shell.hosts)).toEqual(new Set([HOST_IPV4]));
  });

  it("logs reads the previews' containers through dev's deploy login", async () => {
    const { deps, plan } = await sharedPreviewProject();
    const shell = devShell(plan.app.name);
    const place = await dockerLogs(deps, plan, { services: { remote: shell.remote } });
    await place
      .containers({ project: "shop-preview-pr-42", composeService: "app" })
      .catch(() => []);
    expect(shell.hosts).toEqual([HOST_IPV4]);
    expect(shell.commands[0]).toContain("com.docker.compose.project=shop-preview-pr-42");
  });

  it("a later design reads dev's server's size through dev's deploy login", async () => {
    const { deps, host } = await sharedPreviewProject();
    const inspected: string[] = [];
    const facts = HostFactsSchema.parse({
      ...freshFacts({ user: "deploy" }),
      memoryBytes: 8 * 1024 ** 3,
    });
    const input = await inspectOwnServerForDesign(deps, {
      services: {
        host: {
          inspect: async (remote) => {
            inspected.push(remote.host);
            return facts;
          },
          apply: async () => {
            throw new Error("design applies nothing");
          },
        },
      },
    });
    expect(inspected).toEqual([HOST_IPV4]);
    expect(input).toMatchObject({
      facts: { memoryGb: 8 },
      access: "public",
      serving: "proxy",
      apps: [{ name: "shop-dev", tunnel: false }],
    });
    expect(input.apps?.[0]?.memoryMb).toBe(
      appMemoryMb(await readArtifact("plan", host.files.plan)),
    );
  });

  it("secure and advise say that dev's server is dev's to check", async () => {
    const { deps, plan } = await sharedPreviewProject();
    await expect(runSecure(deps, { offline: true })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of preview run on dev's server, whose hardening `opscrew secure` checks for dev. Nothing was changed.",
      hint: "Run `opscrew secure --env dev`; `opscrew verify --env preview` checks the previews themselves.",
    });
    await expect(runAdvise(deps, plan)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: "Run `opscrew advise --env dev`.",
    });
  });
});

describe("a preview environment on dev's server, the user's own server", () => {
  it("status reads the figures through dev's recorded admin login", async () => {
    const { deps, plan, host } = await sharedPreviewProject({ own: true });
    deps.runner = ownRunner();
    // dev's host key, as dev's provision pinned and recorded it.
    await mkdir(dirname(host.files.knownHosts), { recursive: true });
    await writeFile(
      host.files.knownHosts,
      `[${HOST_IPV4}]:${HOST_SSH_PORT} ssh-ed25519 ${ED25519}\n`,
    );
    await recordOwnServer(host, {
      host: HOST_IPV4,
      port: HOST_SSH_PORT,
      user: HOST_ADMIN,
      agent: true,
      reachable: true,
      hostKey: ED25519_FINGERPRINT,
    });
    const admin = devShell(plan.app.name);
    const logins: string[] = [];
    const deploy = devShell(plan.app.name);
    const report = await componentStatusReport(deps, plan, {
      services: {
        remote: deploy.remote,
        own: {
          remote: (connection) => {
            logins.push(`${connection.user}@${connection.host}:${connection.port}`);
            return admin.remote(connection.host);
          },
        },
      },
    });
    expect(logins).toEqual([`${HOST_ADMIN}@${HOST_IPV4}:${HOST_SSH_PORT}`]);
    expect(report.lines.join("\n")).toContain("Previews: 2 of at most 3.");
    expect(new Set(deploy.hosts)).toEqual(new Set([HOST_IPV4]));
    expect(JSON.stringify(deps.audit.entries)).not.toContain(HOST_IPV4);
  });
});
