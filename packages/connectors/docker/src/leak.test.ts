import { duplexPair } from "node:stream";
import { inspect } from "node:util";
import { NodeStreamRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { dockerClient } from "./client";
import { dialStdioTransport } from "./dial-stdio";
import { FakeDocker } from "./testing/fake-docker";

/** The whole of `error`, with its causes, as a log or a crash report would show it. */
async function shown(failing: Promise<unknown>): Promise<string> {
  const error = await failing.then(
    () => {
      throw new Error("expected a failure");
    },
    (reason: unknown) => reason,
  );
  return inspect(error, { depth: 10 });
}

describe("no environment value or secret in an error", () => {
  it("masks the container's environment in Docker's refusal", async () => {
    const password = fakeSecret("generic-password");
    const fake = new FakeDocker();
    fake.images.add("postgres:test");
    fake.fail(
      "POST",
      /\/containers\/create/,
      400,
      `invalid environment variable: PGPASSWORD=${password}`,
    );
    const text = await shown(
      dockerClient(fake).createContainer({ image: "postgres:test", env: { PGPASSWORD: password } }),
    );
    expect(text).toContain("invalid environment variable");
    expect(text).not.toContain(password);
  });

  it("keeps the request's body and headers out of a broken connection's error", async () => {
    const password = fakeSecret("generic-password");
    const token = fakeSecret("github-token");
    const transport = dialStdioTransport(() => {
      const [local, remote] = duplexPair();
      remote.resume();
      remote.end();
      return {
        stream: local,
        exit: Promise.resolve({ exitCode: 255, stderr: "Connection closed by remote host\n" }),
        kill: () => local.destroy(),
      };
    });
    const text = await shown(
      dockerClient(transport).createContainer({
        image: "postgres:test",
        env: { PGPASSWORD: password },
        labels: { token },
      }),
    );
    expect(text).toContain("Connection closed by remote host");
    expect(text).not.toContain(password);
    expect(text).not.toContain(token);
  });

  it("keeps the process's arguments and environment out of a failed start", async () => {
    const key = fakeSecret("hcloud-token");
    const runner = new NodeStreamRunner();
    const transport = dialStdioTransport(() =>
      runner.open("opscrew-no-such-ssh", ["-o", `IdentityAgent=${key}`, "docker"], {
        env: { OPSCREW_KEY: key },
      }),
    );
    const text = await shown(dockerClient(transport).listVolumes());
    expect(text).toContain("not installed");
    expect(text).not.toContain(key);
    await transport.close?.();
  });
});
