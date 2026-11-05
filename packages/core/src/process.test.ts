import { once } from "node:events";
import type { Readable } from "node:stream";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { OpsCrewError } from "./errors";
import { NodeStreamRunner } from "./process";
import { fakeSecret } from "./testing";

const node = process.execPath;
const runner = new NodeStreamRunner();

/** Everything `stream` yields until it ends. */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("NodeStreamRunner", () => {
  it("carries stdin to the process and its stdout back as one stream", async () => {
    const child = runner.open(node, ["-e", "process.stdin.pipe(process.stdout)"]);
    child.stream.write("hello ");
    child.stream.end("world");
    expect(await readAll(child.stream)).toBe("hello world");
    expect(await child.exit).toEqual({ exitCode: 0, stderr: "" });
  });

  it("settles with the exit code and the end of stderr", async () => {
    const child = runner.open(node, [
      "-e",
      "process.stderr.write('x'.repeat(100000) + 'the end'); process.exitCode = 3",
    ]);
    child.stream.resume();
    const { exitCode, stderr } = await child.exit;
    expect(exitCode).toBe(3);
    expect(stderr.length).toBeLessThanOrEqual(16 * 1024);
    expect(stderr.endsWith("the end")).toBe(true);
  });

  it("settles soon after the process exits, though a descendant still holds stderr", async () => {
    // Like an SSH ControlPersist master: a detached child that outlives its parent with stderr.
    const child = runner.open(node, [
      "-e",
      `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: ["ignore", "ignore", "inherit"], detached: true });
      c.unref();
      process.stdout.write(String(c.pid));`,
    ]);
    const descendant = Number(await readAll(child.stream));
    try {
      const started = Date.now();
      expect((await child.exit).exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.kill(descendant);
    }
  });

  it("passes the given environment", async () => {
    const child = runner.open(node, ["-e", "process.stdout.write(process.env.OPSCREW_PROBE)"], {
      env: { ...process.env, OPSCREW_PROBE: "probe value" },
    });
    expect(await readAll(child.stream)).toBe("probe value");
    await child.exit;
  });

  it("ends the process on kill, and exit settles", async () => {
    const child = runner.open(node, ["-e", "setInterval(() => {}, 1000)"]);
    child.stream.resume();
    child.kill();
    const { exitCode } = await child.exit;
    expect(exitCode).not.toBe(0);
  });

  it("ends the process when the signal aborts", async () => {
    const controller = new AbortController();
    const child = runner.open(node, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
    });
    child.stream.on("error", () => {});
    child.stream.resume();
    controller.abort();
    const { exitCode } = await child.exit;
    expect(exitCode).not.toBe(0);
  });

  it("says plainly that a missing program is not installed, and the stream fails too", async () => {
    const child = runner.open("opscrew-no-such-program", ["--flag"]);
    const streamError = once(child.stream, "error");
    const error = await child.exit.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("COMMAND_FAILED");
    expect((error as OpsCrewError).message).toContain("not installed");
    expect((await streamError)[0]).toBe(error);
  });

  it("never puts an argument or an environment value in its errors", async () => {
    const secret = fakeSecret("generic-password");
    const missing = runner.open("opscrew-no-such-program", [`--password=${secret}`], {
      env: { OPSCREW_PASSWORD: secret },
    });
    missing.stream.on("error", () => {});
    const notFound = await missing.exit.catch((reason: unknown) => reason as OpsCrewError);
    // Node refuses a value with a NUL byte, and its own message quotes the value.
    const invalid = (() => {
      try {
        runner.open(node, ["-e", ""], { env: { OPSCREW_PASSWORD: `${secret}\0` } });
        return undefined;
      } catch (error) {
        return error as OpsCrewError;
      }
    })();
    expect(invalid).toBeInstanceOf(OpsCrewError);
    for (const error of [notFound, invalid]) {
      // The whole error, with any cause Node attached (its `spawnargs` hold the arguments).
      expect(inspect(error, { depth: 5 })).not.toContain(secret);
    }
  });
});
