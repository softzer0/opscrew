import { readFile } from "node:fs/promises";
import type { RegistrarDnsRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/**
 * Reading a BIND zone file (`opscrew domain connect --records-file`): the records a DNS provider
 * exports, for domains whose DNS the registrar does not host. Errors name the line and what is
 * wrong with it, never its content (the file may hold anything).
 */

/** Reads a text file (default `node:fs/promises` `readFile` as UTF-8). */
export type ReadTextFile = (path: string) => Promise<string>;

const readUtf8: ReadTextFile = (path) => readFile(path, "utf8");

/** A word of a zone file: its presentation text (escapes kept, without surrounding quotes). */
interface Token {
  text: string;
  quoted: boolean;
}

/** One logical entry (parentheses may spread it over several lines). */
interface Entry {
  /** Line where it starts. */
  line: number;
  /** The line starts with a space or tab: the owner is the previous record's. */
  blankOwner: boolean;
  tokens: Token[];
}

/** A problem on one line, turned into an `OpsCrewError` with the file name. */
class LineError extends Error {
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const CLASSES = /^(IN|CH|CS|HS|ANY|CLASS\d+)$/i;
const TTL = /^(\d+|(\d+[smhdw])+)$/i;
const TYPE = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Types whose data is one host name (relative names get the origin). */
const HOST_TYPES = new Set(["CNAME", "NS", "ALIAS", "ANAME", "PTR", "DNAME"]);
const MAX_TTL = 2_147_483_647;
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Splits the text into entries: comments dropped, quotes and parentheses respected. */
function entries(text: string): Entry[] {
  const out: Entry[] = [];
  let current: Entry | undefined;
  let line = 1;
  let depth = 0;
  let leadingSpace = false;
  let atLineStart = true;
  const add = (token: Token | undefined, at: number) => {
    if (current === undefined) {
      current = { line: at, blankOwner: leadingSpace, tokens: [] };
      out.push(current);
    }
    if (token !== undefined) current.tokens.push(token);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\n") {
      line++;
      i++;
      atLineStart = true;
      leadingSpace = false;
      if (depth === 0) current = undefined;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      if (atLineStart && depth === 0 && current === undefined) leadingSpace = true;
      atLineStart = false;
      i++;
      continue;
    }
    atLineStart = false;
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      add(undefined, line);
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth === 0)
        throw new LineError(line, "it has a closing parenthesis without an opening one");
      depth--;
      i++;
      continue;
    }
    if (c === '"') {
      const start = line;
      let value = "";
      i++;
      for (;;) {
        const d = text[i];
        if (d === undefined || d === "\n") {
          throw new LineError(start, "a quoted text is not closed on the line where it starts");
        }
        if (d === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
          value += d + (text[i + 1] as string);
          i += 2;
          continue;
        }
        i++;
        if (d === '"') break;
        value += d;
      }
      add({ text: value, quoted: true }, start);
      continue;
    }
    let value = "";
    while (i < text.length) {
      const d = text[i] as string;
      if (' \t\r\n;()"'.includes(d)) break;
      if (d === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
        value += d + (text[i + 1] as string);
        i += 2;
        continue;
      }
      value += d;
      i++;
    }
    add({ text: value, quoted: false }, line);
  }
  if (depth > 0 && current !== undefined) {
    throw new LineError(current.line, "a parenthesis opened here is never closed");
  }
  return out;
}

/** Seconds of `3600`, `1h`, `2h30m`; undefined when it is not a time. */
function seconds(token: Token | undefined): number | undefined {
  if (token === undefined || token.quoted || !TTL.test(token.text)) return undefined;
  let total = 0;
  if (/^\d+$/.test(token.text)) total = Number(token.text);
  else {
    for (const [, amount, unit] of token.text.matchAll(/(\d+)([smhdw])/gi)) {
      total += Number(amount) * (UNIT_SECONDS[(unit as string).toLowerCase()] ?? 0);
    }
  }
  return total <= MAX_TTL ? total : undefined;
}

/** A name made absolute (lower case, without the trailing dot): `@`, relative or absolute. */
function absolute(name: string, origin: string): string {
  if (name === "@") return origin;
  if (name.endsWith(".") && !name.endsWith("\\.")) return name.slice(0, -1).toLowerCase();
  return (origin === "" ? name : `${name}.${origin}`).toLowerCase();
}

function integer(token: Token | undefined, max: number): number | undefined {
  if (token === undefined || token.quoted || !/^\d+$/.test(token.text)) return undefined;
  const value = Number(token.text);
  return value <= max ? value : undefined;
}

/** Presentation text of data words: quoted words keep their quotes. */
function words(tokens: readonly Token[]): string {
  return tokens.map((t) => (t.quoted ? `"${t.text}"` : t.text)).join(" ");
}

/** The record's content (and priority) from its data words, per type. */
function recordData(
  type: string,
  data: readonly Token[],
  origin: string,
): { content: string; priority?: number } {
  const host = (token: Token | undefined) =>
    token === undefined || token.quoted ? undefined : absolute(token.text, origin);
  if (data.length === 0) throw new Error("the record has no data");
  switch (type) {
    case "A":
    case "AAAA":
      if (data.length !== 1 || data[0]?.quoted) {
        throw new Error(`an ${type} record needs exactly one address`);
      }
      return { content: (data[0] as Token).text.toLowerCase() };
    case "MX": {
      const priority = integer(data[0], 65535);
      const exchange = host(data[1]);
      if (data.length !== 2 || priority === undefined || exchange === undefined) {
        throw new Error("an MX record needs a preference and a mail server");
      }
      return { content: exchange, priority };
    }
    case "SRV": {
      const [priority, weight, port] = data.slice(0, 3).map((t) => integer(t, 65535));
      const target = data[3]?.text === "." ? "." : host(data[3]);
      if (
        data.length !== 4 ||
        priority === undefined ||
        weight === undefined ||
        port === undefined ||
        target === undefined
      ) {
        throw new Error("an SRV record needs a priority, a weight, a port and a target");
      }
      return { content: `${weight} ${port} ${target}`, priority };
    }
    case "CAA": {
      const flags = integer(data[0], 255);
      const tag = data[1];
      const value = data.slice(2);
      if (
        flags === undefined ||
        tag === undefined ||
        tag.quoted ||
        !/^[A-Za-z0-9]+$/.test(tag.text) ||
        value.length === 0
      ) {
        throw new Error("a CAA record needs flags, a tag and a value");
      }
      return {
        content: `${flags} ${tag.text.toLowerCase()} "${value.map((t) => t.text).join(" ")}"`,
      };
    }
    case "TXT":
    case "SPF":
      // Every character-string quoted, escapes as written: Cloudflare takes this form as is.
      return { content: data.map((t) => `"${t.text}"`).join(" ") };
    case "SOA": {
      if (data.length !== 7) throw new Error("an SOA record needs seven fields");
      const [mname, rname, ...rest] = data;
      return { content: [host(mname), host(rname), words(rest)].join(" ") };
    }
    default:
      if (HOST_TYPES.has(type)) {
        const target = host(data[0]);
        if (data.length !== 1 || target === undefined) {
          throw new Error(`a ${type} record needs exactly one target`);
        }
        return { content: target };
      }
      return { content: words(data) };
  }
}

/**
 * The records of a BIND zone file as registrar records (names fully qualified, lower case, without
 * the trailing dot; MX and SRV priorities in `priority`). Understands comments, `$ORIGIN`, `$TTL`,
 * `@`, relative names, a blank owner (the previous record's), optional TTL and class in either
 * order, parentheses over several lines and quoted text with spaces and escapes. Without
 * `$ORIGIN`, names are relative to `domain`. Types other than A, AAAA, CNAME, MX, TXT, SRV, CAA,
 * NS and SOA keep their data as written, for the copy plan to list. `label` names the file in
 * errors, which give the line number and never the line.
 */
export function parseBindZone(text: string, domain: string, label: string): RegistrarDnsRecord[] {
  try {
    return parse(text, domain.trim().toLowerCase().replace(/\.$/, ""));
  } catch (error) {
    if (!(error instanceof LineError)) throw error;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Line ${error.line} of ${label} is not something OpsCrew can read: ${error.reason}.`,
      {
        hint: "Fix that line (the file must be a BIND zone file, the format DNS providers export), then run the command again.",
      },
    );
  }
}

function parse(text: string, domain: string): RegistrarDnsRecord[] {
  const records: RegistrarDnsRecord[] = [];
  let origin = domain;
  let defaultTtl: number | undefined;
  let previousOwner: string | undefined;
  for (const entry of entries(text)) {
    const { tokens, line } = entry;
    const first = tokens[0];
    if (first === undefined) continue;
    const fail = (reason: string): never => {
      throw new LineError(line, reason);
    };
    if (!entry.blankOwner && !first.quoted && first.text.startsWith("$")) {
      const directive = first.text.toUpperCase();
      const value = tokens[1];
      if (directive === "$ORIGIN") {
        if (value === undefined || value.quoted) fail("$ORIGIN needs a name");
        origin = absolute((value as Token).text, origin);
      } else if (directive === "$TTL") {
        defaultTtl = seconds(value) ?? fail("$TTL needs a time, for example $TTL 3600");
      } else if (directive === "$INCLUDE") {
        fail("OpsCrew does not follow $INCLUDE; put the included records into this file");
      } else {
        fail("it is a directive OpsCrew does not know (only $ORIGIN and $TTL)");
      }
      continue;
    }
    let index = 0;
    let owner: string;
    if (entry.blankOwner) {
      owner = previousOwner ?? fail("the record has no name and no record before it");
    } else {
      if (first.quoted) fail("a record name cannot be quoted text");
      owner = absolute(first.text, origin);
      index = 1;
    }
    let ttl: number | undefined;
    let recordClass: string | undefined;
    for (let k = 0; k < 2; k++) {
      const token = tokens[index];
      if (token === undefined || token.quoted) break;
      if (ttl === undefined && TTL.test(token.text)) {
        ttl = seconds(token) ?? fail("its TTL is too large");
      } else if (recordClass === undefined && CLASSES.test(token.text)) {
        recordClass = token.text.toUpperCase();
      } else break;
      index++;
    }
    if (recordClass !== undefined && recordClass !== "IN") {
      fail("only IN-class records can be copied");
    }
    const typeToken = tokens[index];
    if (typeToken === undefined || typeToken.quoted || !TYPE.test(typeToken.text)) {
      fail("the line has no record type (A, CNAME, MX, TXT …) where one is expected");
    }
    const type = (typeToken as Token).text.toUpperCase();
    previousOwner = owner;
    let data: { content: string; priority?: number };
    try {
      data = recordData(type, tokens.slice(index + 1), origin);
    } catch (error) {
      throw new LineError(line, (error as Error).message);
    }
    const recordTtl = ttl ?? defaultTtl;
    records.push({
      type,
      name: owner,
      content: data.content,
      ...(data.priority === undefined ? {} : { priority: data.priority }),
      ...(recordTtl === undefined ? {} : { ttl: recordTtl }),
    });
  }
  return records;
}

/**
 * Reads and parses a BIND zone file (see `parseBindZone`) through `read`. A missing or unreadable
 * file stops with what to pass instead.
 */
export async function readBindFile(
  file: string,
  domain: string,
  read: ReadTextFile = readUtf8,
  label = file,
): Promise<RegistrarDnsRecord[]> {
  let text: string;
  try {
    text = await read(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT"
        ? ": it does not exist"
        : code === "EISDIR"
          ? ": it is a folder"
          : code === undefined
            ? ""
            : ` (${code})`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew cannot read the records file ${label}${why}.`,
      {
        hint: "Export the zone from your current DNS provider as a BIND zone file and pass its path with --records-file.",
        cause: error,
      },
    );
  }
  return parseBindZone(text, domain, label);
}
