/**
 * Reading the ustar archives OpsCrew makes (`tarStream`): SFTP can't unpack them on the host, and
 * the panels' fakes unpack them as the panel would.
 */
import { OpsCrewError } from "./errors";

/** An archive's entry: a folder, a file with its content, or a symbolic link with its target. */
export type TarEntry =
  | { type: "dir"; name: string; mode: number }
  | { type: "file"; name: string; mode: number; content: Uint8Array }
  | { type: "link"; name: string; target: string };

const invalid = (reason: string) =>
  new OpsCrewError("INVALID_INPUT", `The archive to upload isn't one OpsCrew made: ${reason}.`, {
    hint: "This is a bug in OpsCrew; please report it.",
  });

/**
 * The entries of a ustar archive, in order: folders, files and symbolic links, each name relative
 * (`./` and a closing `/` dropped), without `..` or empty parts.
 * @throws OpsCrewError `INVALID_INPUT` for anything else: another entry type, a damaged header, a
 * name that leaves the folder.
 */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const text = (start: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, "");
  const octal = (start: number, length: number) => Number.parseInt(text(start, length).trim(), 8);
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) return entries;
    if (text(offset + 257, 5) !== "ustar") throw invalid("a header isn't ustar");
    const prefix = text(offset + 345, 155);
    const name = `${prefix === "" ? "" : `${prefix}/`}${text(offset, 100)}`
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (name.startsWith("/") || name.split("/").some((part) => part === "" || part === "..")) {
      throw invalid(`the name ${JSON.stringify(name)} leaves its folder`);
    }
    const size = octal(offset + 124, 12) || 0;
    const mode = octal(offset + 100, 8) & 0o777;
    const type = text(offset + 156, 1) || "0";
    const body = offset + 512;
    if (type === "0") {
      entries.push({ type: "file", name, mode, content: bytes.slice(body, body + size) });
    } else if (type === "5") {
      entries.push({ type: "dir", name, mode });
    } else if (type === "2") {
      entries.push({ type: "link", name, target: text(offset + 157, 100) });
    } else {
      throw invalid(`the entry ${JSON.stringify(name)} is of type ${type}`);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return entries;
}
