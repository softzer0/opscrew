import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  COMMIT,
  DIGEST,
  fakeShell,
  HOST_42,
  LIST_OUTPUT,
  previewProject,
} from "../previews/__fixtures__/plan";
import {
  appZonePreviewTestPlan,
  BELOW_ZONE,
  certificateFetch,
  PREVIEW_ZONE,
  TOKEN,
} from "../testing";
import type { TlsConnect } from "./net";
import { runVerify } from "./run";

/** Cloudflare's edge certificate for the preview zone, valid for two more months. */
const tlsConnect: TlsConnect = async () => ({
  subjectAltNames: [PREVIEW_ZONE, `*.${PREVIEW_ZONE}`],
  validFrom: "2026-10-01T00:00:00.000Z",
  validTo: "2026-12-30T00:00:00.000Z",
  issuer: "Google Trust Services",
});

describe("verify --env <preview>", () => {
  it("checks the server and each running preview's address, never an app hostname", async () => {
    const { deps, plan } = await previewProject();
    const asked: string[] = [];
    const shell = fakeShell(() => ({ exitCode: 0, stdout: LIST_OUTPUT }));
    const result = await runVerify(deps, {
      remote: shell.remote,
      tlsConnect,
      fetch: async (input) => {
        asked.push(String(input));
        return new Response("ok", { status: 200 });
      },
      resolver: {
        resolve4: async () => {
          throw new Error("no DNS lookup expected");
        },
        resolve6: async () => {
          throw new Error("no DNS lookup expected");
        },
      } as never,
    });

    expect(shell.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview list"]);
    expect(asked).toEqual([`https://${HOST_42}/api/health`]);
    expect(result.checks.map((c) => `${c.status} ${c.title}`)).toEqual([
      "pass The preview server answers and lists its previews",
      `pass pr-42: HTTPS certificate for ${HOST_42} is valid`,
      "pass pr-42: Health endpoint answers 200",
      "warn pr-7 runs",
    ]);
    expect(result.passed).toBe(true);
    expect(result.runbookPath).toBeUndefined();
    expect(result.checks[3]?.remediation).toContain("opscrew preview logs 7 --env preview");
    // Nothing recorded in plan.yaml: previews come and go.
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
  });

  it("below the app's zone, checks the previews' certificate and Total TLS, read-only, each with its fix", async () => {
    const { deps } = await previewProject({ env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    await writeArtifact("plan", deps.paths.files.plan, appZonePreviewTestPlan());
    const asked: string[] = [];
    const cloudflare = certificateFetch(async () => new Response("ok", { status: 200 }), {
      totalTls: true,
    });
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: listed 0/3\n" }));
    const result = await runVerify(deps, {
      remote: shell.remote,
      tlsConnect,
      fetch: async (input, init) => {
        asked.push(`${init?.method ?? "GET"} ${String(input)}`);
        return cloudflare.fetch(input, init);
      },
    });
    expect(result.checks.map((c) => `${c.status} ${c.title}`)).toEqual([
      "pass The preview server answers and lists its previews",
      `pass The previews' certificate for *.${BELOW_ZONE} is active`,
      `fail Total TLS is off for ${PREVIEW_ZONE}`,
    ]);
    expect(result.checks[2]?.remediation).toBe(
      `Turn Total TLS off in the Cloudflare dashboard (${PREVIEW_ZONE} → SSL/TLS → Edge Certificates).`,
    );
    expect(result.passed).toBe(false);
    expect(result.url).toBe(`https://pr-<number>-<random>.${BELOW_ZONE}`);
    expect(asked.every((call) => call.startsWith("GET "))).toBe(true);
    expect(deps.reporter.text()).not.toContain(TOKEN);
    expect(JSON.stringify(result.checks)).not.toContain(TOKEN);
  });

  it("below the app's zone without a Cloudflare token, fails the certificate's check saying so", async () => {
    const { deps } = await previewProject({ env: { CLOUDFLARE_API_TOKEN: undefined } });
    await writeArtifact("plan", deps.paths.files.plan, appZonePreviewTestPlan());
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: listed 0/3\n" }));
    const result = await runVerify(deps, { remote: shell.remote, tlsConnect });
    const check = result.checks.find((c) => c.id === "previews-certificate");
    expect(check).toMatchObject({ status: "fail", remediation: expect.stringContaining("token") });
    expect(check?.message).toContain("CLOUDFLARE_API_TOKEN");
    expect(result.passed).toBe(false);
  });

  it("fails when the preview server does not answer, saying what to do", async () => {
    const { deps } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 255, stdout: "" }));
    const result = await runVerify(deps, { remote: shell.remote, tlsConnect });
    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: "preview-server",
        status: "fail",
        message: expect.stringContaining("did not answer over SSH"),
      }),
    ]);
  });

  it("warns about a running preview the server lists without an address, and asks it nothing", async () => {
    const { deps } = await previewProject();
    const stdout = `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} -\nopscrew-preview: listed 1/3\n`;
    const shell = fakeShell(() => ({ exitCode: 0, stdout }));
    const asked: string[] = [];
    const result = await runVerify(deps, {
      remote: shell.remote,
      tlsConnect: async () => {
        throw new Error("no TLS check expected");
      },
      fetch: async (input) => {
        asked.push(String(input));
        return new Response("ok", { status: 200 });
      },
    });
    expect(asked).toEqual([]);
    expect(result.checks.map((c) => `${c.status} ${c.title}`)).toEqual([
      "pass The preview server answers and lists its previews",
      "warn pr-42 runs",
    ]);
    expect(result.checks[1]).toMatchObject({
      message: "pr-42 has no address on the preview server, so it is not served.",
      remediation: expect.stringContaining("opscrew preview logs 42 --env preview"),
    });
    expect(result.checks[1]?.target).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});
