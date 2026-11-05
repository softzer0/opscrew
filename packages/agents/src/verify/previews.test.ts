import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { fakeShell, LIST_OUTPUT, previewProject } from "../previews/__fixtures__/plan";
import type { TlsConnect } from "./net";
import { runVerify } from "./run";

/** A certificate for `host` from Let's Encrypt, valid for two more months. */
const tlsConnect: TlsConnect = async (host) => ({
  subjectAltNames: [host],
  validFrom: "2026-10-01T00:00:00.000Z",
  validTo: "2026-12-30T00:00:00.000Z",
  issuer: "Let's Encrypt",
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
    expect(asked).toEqual(["https://pr-42.shop.example.com/api/health"]);
    expect(result.checks.map((c) => `${c.status} ${c.title}`)).toEqual([
      "pass The preview server answers and lists its previews",
      "pass pr-42: HTTPS certificate for pr-42.shop.example.com is valid",
      "pass pr-42: Health endpoint answers 200",
      "warn pr-7 runs",
    ]);
    expect(result.passed).toBe(true);
    expect(result.runbookPath).toBeUndefined();
    expect(result.checks[3]?.remediation).toContain("opscrew preview logs 7 --env preview");
    // Nothing recorded in plan.yaml: previews come and go.
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
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
});
