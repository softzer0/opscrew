import type { RemoteExec } from "@opscrew/contracts";
import { TOOLS } from "@opscrew/iac-templates";
import type { LocalDocker } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { LIST_OUTPUT, previewProject } from "../previews/__fixtures__/plan";
import { SERVER_IPV4 } from "../testing";
import { runSecure } from "./run";

/** The deploy user's shell on the preview server: the previews' list, and quiet answers else. */
function previewServer(commands: string[]): RemoteExec {
  return {
    host: SERVER_IPV4,
    run: async (command) => {
      commands.push(command);
      if (command.endsWith("opscrew-preview list")) {
        return { exitCode: 0, stdout: LIST_OUTPUT, stderr: "" };
      }
      if (command.includes("{{.Ports}}")) return { exitCode: 0, stdout: "5432/tcp\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("secure --env <preview>", () => {
  it("checks the server as any, each preview's services, and no app hostname", async () => {
    const { deps } = await previewProject();
    deps.fetch = async (url) => {
      if (String(url) !== TOOLS.lynis.url) throw new Error(`unexpected fetch ${String(url)}`);
      return new Response(new Uint8Array([31, 139, 8, 0]));
    };
    const docker: LocalDocker = {
      run: async (args) =>
        args[0] === "version"
          ? { exitCode: 0, stdout: "29.8.2\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "no" },
    };
    const commands: string[] = [];
    const result = await runSecure(deps, {
      remote: previewServer(commands),
      scanners: [],
      offline: true,
      tcpConnect: async (_host, port) => [22, 80, 443].includes(port),
      deep: true,
      docker,
    });

    const ids = result.hostChecks.map((check) => check.id);
    // The services of each preview the server lists, in its own Compose project.
    expect(ids).toEqual(expect.arrayContaining(["pr-42-service-db-port", "pr-7-service-db-port"]));
    expect(result.hostChecks.find((c) => c.id === "pr-42-service-db-port")).toMatchObject({
      title: "pr-42: PostgreSQL (db) is reachable only inside the server",
      status: "pass",
    });
    expect(commands.some((c) => c.includes("project=shop-preview-pr-42"))).toBe(true);
    // Never the environment's own app, which a preview server does not run.
    expect(commands.some((c) => /project=shop-preview(?!-pr-)/.test(c))).toBe(false);
    // No hostname of its own: testssl.sh says so instead of auditing one.
    const testssl = result.deep?.find((tool) => tool.tool === "testssl");
    expect(testssl?.results[0]).toMatchObject({
      status: "skip",
      message: expect.stringContaining("A preview environment has no hostname of its own"),
    });
    expect(result.report).not.toContain("shop.example.com");
  });
});
