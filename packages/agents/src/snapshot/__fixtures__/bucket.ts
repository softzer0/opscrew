/**
 * A fake off-server bucket for the restore's and the bucket's tests, played by a fake rclone: the
 * runner answers `docker version` (local Docker, so rclone runs as the pinned image) and rclone's
 * `lsf` and `purge`; the stream runner answers `cat` with an object's bytes. Objects are encrypted
 * in age's format (`ageEncrypt`) to a key the test generates.
 */
import { Duplex, Readable, Writable } from "node:stream";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  StreamProcess,
  StreamRunner,
} from "@opscrew/contracts";
import { ageEncrypt, fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { ScriptedRunner } from "../../testing";

/** The bucket's made-up key, in the variables a run reads it from. */
export const OFFSITE_KEY = {
  accessKeyId: fakeSecret("aws-access-key-id", "offsite"),
  secretAccessKey: fakeSecret("aws-secret-access-key", "offsite"),
};

/** The environment that holds {@link OFFSITE_KEY}, as a script sets it. */
export const OFFSITE_ENV = {
  OPSCREW_OFFSITE_ACCESS_KEY_ID: OFFSITE_KEY.accessKeyId,
  OPSCREW_OFFSITE_SECRET_ACCESS_KEY: OFFSITE_KEY.secretAccessKey,
};

/** One rclone call: its arguments after the image, and its environment. */
export interface RcloneCall {
  args: string[];
  env: Record<string, string | undefined>;
  /** Every argument of the docker command line, the image's and rclone's. */
  line: string[];
}

export class FakeBucket {
  /** The objects by their path under `backups/`. */
  readonly objects = new Map<string, Buffer>();
  readonly calls: RcloneCall[] = [];
  /** Downloads keep their stream open after the object's bytes, until killed. */
  endless = false;
  /** How many downloads were killed. */
  killed = 0;

  constructor(readonly bucket: string) {}

  /** Puts `plain` as `path` (under `backups/`), encrypted to `recipient`. */
  put(path: string, plain: string | Buffer, recipient: string): void {
    this.objects.set(path, ageEncrypt(Buffer.from(plain), [recipient]));
  }

  /** The path under `backups/` an rclone argument names, or `undefined` for another bucket. */
  private path(remote: string | undefined): string | undefined {
    const root = `offsite:${this.bucket}/backups`;
    if (remote === undefined || !remote.startsWith(root)) return undefined;
    return remote.slice(root.length).replace(/^\//, "");
  }

  /** rclone's arguments in a `docker run … <rclone image> …` line, recorded. */
  private record(command: string, args: readonly string[], env: CommandOptions["env"]) {
    if (command !== "docker" || args[0] !== "run") return undefined;
    const at = args.indexOf(IMAGES.rclone.ref);
    if (at === -1) return undefined;
    const call = { args: args.slice(at + 1), env: { ...env }, line: [...args] };
    this.calls.push(call);
    return call.args;
  }

  /** The runner: `docker version`, rclone's `lsf` and `purge`; `base` answers anything else. */
  runner(base: CommandRunner): ScriptedRunner {
    return new ScriptedRunner((command, args, options): CommandResult | Promise<CommandResult> => {
      if (command === "docker" && args[0] === "version") {
        return { exitCode: 0, stdout: "29.0.0\n", stderr: "" };
      }
      const rclone = this.record(command, args, options?.env);
      if (rclone === undefined) return base.run(command, args, options);
      const [verb] = rclone;
      const path = this.path(rclone.at(-1));
      if (path === undefined) return { exitCode: 1, stdout: "", stderr: "no such bucket" };
      const under = path === "" ? "" : `${path}/`;
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(under));
      if (verb === "lsf") {
        return { exitCode: 0, stdout: keys.map((key) => `${key.slice(under.length)}\n`).join(""), stderr: "" };
      }
      if (verb === "purge") {
        if (keys.length === 0) return { exitCode: 3, stdout: "", stderr: "directory not found" };
        for (const key of keys) this.objects.delete(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `fake rclone knows no ${verb}` };
    });
  }

  /** The stream runner: rclone's `cat` of an object; a missing one fails as rclone does. */
  streams(): StreamRunner {
    return {
      open: (command, args, options): StreamProcess => {
        const rclone = this.record(command, args, options?.env);
        const path = rclone?.[0] === "cat" ? this.path(rclone[1]) : undefined;
        const data = path === undefined ? undefined : this.objects.get(path);
        // A download that never ends on its own, as a stalled one: only a kill ends it.
        let sent = false;
        const readable = this.endless
          ? new Readable({
              read() {
                if (sent || data === undefined) return;
                sent = true;
                this.push(data);
              },
            })
          : Readable.from(data === undefined ? [] : [data], { objectMode: false });
        const stream = Duplex.from({
          readable,
          writable: new Writable({ write: (_chunk, _encoding, done) => done() }),
        });
        let exited: (exit: { exitCode: number; stderr: string }) => void = () => {};
        const exit = this.endless
          ? new Promise<{ exitCode: number; stderr: string }>((resolve) => {
              exited = resolve;
            })
          : Promise.resolve(
              data === undefined
                ? { exitCode: 3, stderr: "object not found" }
                : { exitCode: 0, stderr: "" },
            );
        return {
          stream,
          exit,
          kill: () => {
            this.killed++;
            readable.destroy();
            stream.destroy();
            exited({ exitCode: 143, stderr: "killed" });
          },
        };
      },
    };
  }
}
