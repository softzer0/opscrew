import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { SERVER_IPV4, testPlan } from "../testing";
import {
  COMMIT,
  DIGEST,
  fakeShell,
  HOST_7,
  HOST_42,
  LIST_OUTPUT,
  previewProject,
} from "./__fixtures__/plan";
import { listPreviews, previewListLines } from "./list";

describe("listPreviews", () => {
  it("lists the previews over the deploy key, read-only, from the command's lines", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 0, stdout: `${LIST_OUTPUT}\n` }));
    const list = await listPreviews(deps, plan, { services: { remote: shell.remote } });
    expect(shell.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview list"]);
    expect(list).toEqual({
      count: 2,
      cap: 3,
      previews: [
        {
          number: 42,
          state: "running",
          commit: COMMIT,
          createdAt: "2026-10-10T00:00:00.000Z",
          updatedAt: "2026-10-11T00:00:00.000Z",

          digest: DIGEST,
          address: `https://${HOST_42}`,
        },
        expect.objectContaining({ number: 7, state: "failed" }),
      ],
    });
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "list the previews (read-only)",
        target: "server",
        decision: "allow",
      }),
    );
    expect(previewListLines(list, deps.clock.now())).toEqual([
      "Previews: 2 of at most 3.",
      `  pr-42: https://${HOST_42}, running, commit 0123456, created 36 hours ago, updated 12 hours ago`,
      `  pr-7: https://${HOST_7}, failed, commit 0123456, created 36 hours ago, updated 36 hours ago`,
    ]);
    // The server's address stays out of what is said and audited.
    const said = [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(list),
    ].join("\n");
    expect(said).not.toContain(SERVER_IPV4);
  });

  it("says when the server has no previews", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 0, stdout: "opscrew-preview: listed 0/3\n" }));
    const list = await listPreviews(deps, plan, { services: { remote: shell.remote } });
    expect(previewListLines(list, deps.clock.now())).toEqual(["Previews: 0 of at most 3."]);
  });

  it("reads a half-made preview's missing fields (-) and shows what it has", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({
      exitCode: 0,
      stdout: "9 failed - - - - -\nopscrew-preview: listed 1/3\n",
    }));
    const list = await listPreviews(deps, plan, { services: { remote: shell.remote } });
    expect(list.previews).toEqual([{ number: 9, state: "failed" }]);
    expect(previewListLines(list, deps.clock.now())).toEqual([
      "Previews: 1 of at most 3.",
      "  pr-9: no address yet, failed",
    ]);
  });

  it.each([
    ["a time that is not one", `42 running ${COMMIT} soon 1791676800 ${DIGEST} ${HOST_42}`],
    ["no address field", `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST}`],
    ["another preview's address", `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} ${HOST_7}`],
    [
      "an address outside the preview zone",
      `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} pr-42-a1b2c3d4e5.example.com`,
    ],
    [
      "an address without its random part",
      `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} pr-42.example.net`,
    ],
  ])("refuses a line outside the contract instead of guessing: %s", async (_case, line) => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({
      exitCode: 0,
      stdout: `${line}\nopscrew-preview: listed 1/3\n`,
    }));
    await expect(
      listPreviews(deps, plan, { services: { remote: shell.remote } }),
    ).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("says to provision again when the command is not on the server", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 127, stdout: "", stderr: "not found" }));
    const error = await listPreviews(deps, plan, { services: { remote: shell.remote } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).hint).toContain("opscrew provision --env preview");
  });

  it("says when the server does not answer", async () => {
    const { deps, plan } = await previewProject();
    const shell = fakeShell(() => ({ exitCode: 255, stdout: "" }));
    await expect(listPreviews(deps, plan, { services: { remote: shell.remote } })).rejects.toThrow(
      "did not answer over SSH",
    );
  });

  it("refuses an environment without previews", async () => {
    const { deps } = await previewProject();
    await expect(listPreviews(deps, testPlan({ deployed: true }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("has no previews"),
    });
  });
});
