import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";

export interface RecordedCall {
  command: string;
  args: string[];
  options: CommandOptions;
}

/** A scripted reply: a result, or a function computing one (may write files, e.g. plan output). */
export type Reply =
  | Partial<CommandResult>
  | ((call: RecordedCall) => Partial<CommandResult> | Promise<Partial<CommandResult>>);

/** Fake `CommandRunner`: replies are looked up by subcommand (`args[0]`) and consumed in order. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  private readonly script = new Map<string, Reply[]>();

  on(subcommand: string, ...replies: Reply[]): this {
    this.script.set(subcommand, [...(this.script.get(subcommand) ?? []), ...replies]);
    return this;
  }

  subcommands(): string[] {
    return this.calls.map((c) => c.args[0] ?? "");
  }

  async run(command: string, args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const key = args[0] ?? "";
    const queue = this.script.get(key) ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error(`ScriptedRunner: no reply for "${key}"`);
    const result = typeof reply === "function" ? await reply(call) : reply;
    if (result.stdout !== undefined || result.stderr !== undefined) {
      for (const line of `${result.stdout ?? ""}`.split("\n")) if (line) options.onLine?.(line, "stdout");
    }
    return { exitCode: 0, stdout: "", stderr: "", ...result };
  }
}

/** Reads a fixture from this folder. */
export function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, name), "utf8");
}

/** A `plan` reply that writes `content` to the `-out=` file and exits with `exitCode`. */
export function writesPlan(content: string, exitCode = 2): Reply {
  return async (call) => {
    const out = call.args.find((a) => a.startsWith("-out="))?.slice("-out=".length);
    if (!out) throw new Error("plan called without -out=");
    await writeFile(out, content);
    return { exitCode, stdout: "Plan: done" };
  };
}
