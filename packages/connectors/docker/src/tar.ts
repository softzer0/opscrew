import { Readable } from "node:stream";
import { OpsCrewError } from "@opscrew/core";

/** One entry of an archive: a file, a folder or a symbolic link. */
export interface TarEntry {
  /** The path in the archive; folders end with `/`. */
  name: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  data?: Buffer;
  /**
   * A file's content as a stream of exactly `size` bytes, instead of `data`: written as it
   * arrives, never held whole.
   */
  stream?: Readable;
  /** The length of `stream`. */
  size?: number;
  /** A link's target. */
  target?: string;
}

const TYPE_FLAG = { file: "0", symlink: "2", dir: "5" } as const;

/** `value` in octal, zero-padded to fill `width` bytes with a closing NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** The 512-byte ustar header of `entry` (names and link targets up to 100 bytes). */
function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, "utf8");
  block.write(octal(entry.mode, 8), 100);
  block.write(octal(entry.uid, 8), 108);
  block.write(octal(entry.gid, 8), 116);
  block.write(octal(sizeOf(entry), 12), 124);
  block.write(octal(0, 12), 136);
  block.write(" ".repeat(8), 148);
  block.write(TYPE_FLAG[entry.type], 156);
  if (entry.target !== undefined) block.write(entry.target, 157, 100, "utf8");
  block.write("ustar\u000000", 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** An entry's content length: its stream's `size`, or its data's. */
function sizeOf(entry: TarEntry): number {
  return entry.stream !== undefined ? (entry.size ?? 0) : (entry.data?.length ?? 0);
}

/**
 * `entries` as a ustar archive, streamed entry by entry (names up to 100 bytes). A streamed
 * entry's content passes through as it arrives; the archive fails, and its stream is destroyed,
 * when that content is not exactly its `size`, or when the stream fails.
 */
export function tarStream(entries: readonly TarEntry[]): Readable {
  async function* blocks(): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      yield header(entry);
      const size = sizeOf(entry);
      if (entry.stream !== undefined) {
        let written = 0;
        for await (const chunk of entry.stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          written += bytes.length;
          if (written > size) break;
          yield bytes;
        }
        if (written !== size) {
          entry.stream.destroy();
          throw new OpsCrewError(
            "ARTIFACT_INVALID",
            `The file ${entry.name} holds ${written > size ? "more" : "fewer"} bytes than the ${size} its archive entry names, so it was not written whole.`,
            { hint: "The file changed or is damaged: check it, then try again." },
          );
        }
      } else if (entry.data !== undefined && size > 0) {
        yield entry.data;
      }
      if (size % 512 !== 0) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  return Readable.from(blocks(), { objectMode: false });
}
