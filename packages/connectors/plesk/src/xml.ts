import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Tags that may repeat in Plesk's XML API packets; always parsed as arrays so one element and many
 * look the same: an operation's results, a hosting setting's properties, a subscription's limits
 * and addresses.
 */
const ARRAY_TAGS = new Set(["result", "property", "limit", "dns_ip_address", "ip_address"]);

/** Attributes are ignored (no packet field OpsCrew reads is one); values stay strings. */
const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  parseTagValue: false,
  isArray: (name, _path, _leaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

/** Text is escaped; an array becomes repeated elements, in order. */
const builder = new XMLBuilder({ ignoreAttributes: true });

/**
 * A packet as plain objects: an element holding only text is its text (`""` when empty), any other
 * is an object of its children, and the tags in `ARRAY_TAGS` are arrays. Undefined when the text is
 * not well-formed XML, or declares a DOCTYPE: Plesk never sends one, and refusing it keeps entity
 * expansion to XML's own five.
 */
export function parseXml(text: string): unknown {
  if (text.trim() === "" || text.includes("<!DOCTYPE") || XMLValidator.validate(text) !== true) {
    return undefined;
  }
  try {
    return parser.parse(text);
  } catch {
    return undefined;
  }
}

/** The XML of a packet given as plain objects (see {@link parseXml}). */
export function buildXml(value: Record<string, unknown>): string {
  return builder.build(value);
}
