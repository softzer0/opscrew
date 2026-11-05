import { Readable } from "node:stream";

/** One entry of a test archive: a file, a folder or a symbolic link. */
export interface TarEntry {
  /** The path in the archive; folders end with `/`. */
  name: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  data?: Buffer;
  /** A link's target. */
  target?: string;
}

const TYPE_FLAG = { file: "0", symlink: "2", dir: "5" } as const;

/** `value` in octal, zero-padded to fill `width` bytes with a closing NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** The 512-byte ustar header of `entry` (names up to 100 bytes, which tests keep to). */
function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, "utf8");
  block.write(octal(entry.mode, 8), 100);
  block.write(octal(entry.uid, 8), 108);
  block.write(octal(entry.gid, 8), 116);
  block.write(octal(entry.data?.length ?? 0, 12), 124);
  block.write(octal(0, 12), 136);
  block.write(" ".repeat(8), 148);
  block.write(TYPE_FLAG[entry.type], 156);
  if (entry.target !== undefined) block.write(entry.target, 157, 100, "utf8");
  block.write("ustar\u000000", 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** `entries` as a tar archive, streamed entry by entry. */
export function tarStream(entries: readonly TarEntry[]): Readable {
  function* blocks(): Generator<Buffer> {
    for (const entry of entries) {
      yield header(entry);
      const size = entry.data?.length ?? 0;
      if (entry.data !== undefined && size > 0) yield entry.data;
      if (size % 512 !== 0) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  return Readable.from(blocks(), { objectMode: false });
}

/** The entries of a ustar archive such as {@link tarStream} writes. */
export function parseTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => {
      const raw = block.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const number = (start: number, length: number) =>
      Number.parseInt(text(start, length).trim() || "0", 8);
    const size = number(124, 12);
    const flag = text(156, 1);
    const type = flag === "5" ? "dir" : flag === "2" ? "symlink" : "file";
    const prefix = text(345, 155);
    const entry: TarEntry = {
      name: prefix === "" ? text(0, 100) : `${prefix}/${text(0, 100)}`,
      type,
      mode: number(100, 8),
      uid: number(108, 8),
      gid: number(116, 8),
    };
    if (type === "file")
      entry.data = Buffer.from(archive.subarray(offset + 512, offset + 512 + size));
    if (type === "symlink") entry.target = text(157, 100);
    entries.push(entry);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
