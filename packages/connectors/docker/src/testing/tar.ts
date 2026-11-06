import type { TarEntry } from "../tar";

/** The entries of a ustar archive such as `tarStream` writes. */
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
