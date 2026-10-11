import type { IacEngineName } from "@opscrew/contracts";

/** A construct that only one engine understands (spec FR-203). */
export interface DialectIssue {
  /** The file's path as given to `checkDialect`. */
  file: string;
  /** 1-based line number (1 for whole-file issues). */
  line: number;
  /** Stable id of the construct, for example `encryption-block`. */
  construct: DialectConstruct;
  /** The only engine that supports the construct. */
  onlyIn: IacEngineName;
  /** Plain-English explanation. */
  message: string;
}

export type DialectConstruct =
  | "tofu-file"
  | "encryption-block"
  | "provider-for-each"
  | "backend-variables"
  | "module-source-variables"
  | "cloud-block"
  | "terraform-stack-file";

export interface DialectFile {
  path: string;
  content: string;
}

const TOFU_FILE = /\.tofu(?:\.json)?$/i;
const TERRAFORM_STACK_FILE = /\.(?:tfstack|tfdeploy|tfcomponent)\.hcl$/i;
const HCL_FILE = /\.(?:tf|tofu)$/i;
const VARIABLE_REF = /(?<![\w.-])(?:var|local)\.[A-Za-z_]/;
const ATTRIBUTE = /^\s*([A-Za-z_][\w-]*)\s*=(?![=>])(.*)$/;

type Mode =
  | { kind: "code" }
  | { kind: "string" }
  | { kind: "interp"; depth: number }
  | { kind: "heredoc"; marker: string; atLineStart: boolean };

/**
 * Returns HCL source with comments and literal string text blanked out (line structure kept).
 * Template interpolations (`${ ... }`) stay visible so variable references can be found, with
 * their braces blanked so they do not affect block nesting.
 */
export function sanitizeHcl(source: string): string {
  const stack: Mode[] = [{ kind: "code" }];
  let out = "";
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const mode = stack[stack.length - 1] ?? { kind: "code" };
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (mode.kind === "code" || mode.kind === "interp") {
      if (ch === "#" || (ch === "/" && next === "/")) {
        const end = source.indexOf("\n", i);
        const stop = end === -1 ? source.length : end;
        out += blank(source.slice(i, stop));
        i = stop;
        continue;
      }
      if (ch === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end === -1 ? source.length : end + 2;
        out += blank(source.slice(i, stop));
        i = stop;
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "string" });
        out += " ";
        i++;
        continue;
      }
      if (mode.kind === "code" && ch === "<" && next === "<") {
        const heredoc = /^<<-?([A-Za-z_][\w-]*)[^\S\n]*\n/.exec(source.slice(i));
        if (heredoc) {
          stack.push({ kind: "heredoc", marker: heredoc[1] ?? "", atLineStart: true });
          out += blank(heredoc[0]);
          i += heredoc[0].length;
          continue;
        }
      }
      if (mode.kind === "interp") {
        if (ch === "{") mode.depth++;
        if (ch === "}") {
          if (mode.depth === 0) {
            stack.pop();
            out += " ";
            i++;
            continue;
          }
          mode.depth--;
        }
        out += ch === "{" || ch === "}" ? " " : ch;
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    // Inside a quoted string or a heredoc body.
    if (mode.kind === "heredoc" && mode.atLineStart) {
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end === -1 ? source.length : end);
      if (line.trim() === mode.marker) {
        stack.pop();
        out += blank(line);
        i += line.length;
        continue;
      }
      mode.atLineStart = false;
    }
    if (mode.kind === "string" && ch === "\\") {
      out += blank(source.slice(i, i + 2));
      i += 2;
      continue;
    }
    if ((ch === "$" || ch === "%") && next === ch && source[i + 2] === "{") {
      out += "   ";
      i += 3;
      continue;
    }
    if ((ch === "$" || ch === "%") && next === "{") {
      stack.push({ kind: "interp", depth: 0 });
      out += "  ";
      i += 2;
      continue;
    }
    if (mode.kind === "string" && (ch === '"' || ch === "\n")) {
      stack.pop();
      out += ch === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (mode.kind === "heredoc" && ch === "\n") mode.atLineStart = true;
    out += ch === "\n" ? "\n" : " ";
    i++;
  }
  return out;
}

interface Frame {
  /** Block type (`terraform`, `provider`, …) or `undefined` for an expression brace. */
  type: string | undefined;
}

function issue(
  file: string,
  line: number,
  construct: DialectConstruct,
  onlyIn: IacEngineName,
  message: string,
): DialectIssue {
  return { file, line, construct, onlyIn, message };
}

function checkHcl(file: string, content: string): DialectIssue[] {
  const issues: DialectIssue[] = [];
  const lines = sanitizeHcl(content).split("\n");
  const stack: Frame[] = [];
  const blockTypes = () => stack.map((f) => f.type);
  /** True when the open blocks start with `path` (outermost first). */
  const inside = (...path: string[]) => {
    const types = blockTypes();
    return types.length >= path.length && path.every((t, idx) => types[idx] === t);
  };

  lines.forEach((text, index) => {
    const line = index + 1;
    const top = stack[stack.length - 1];
    const attribute = ATTRIBUTE.exec(text);
    if (attribute && top?.type !== undefined) {
      const [, name, value = ""] = attribute;
      if (stack.length === 1 && top.type === "provider" && name === "for_each") {
        issues.push(
          issue(
            file,
            line,
            "provider-for-each",
            "tofu",
            "`for_each` on a provider block only works with OpenTofu.",
          ),
        );
      }
      if (
        stack.length === 1 &&
        top.type === "module" &&
        (name === "source" || name === "version") &&
        VARIABLE_REF.test(value)
      ) {
        issues.push(
          issue(
            file,
            line,
            "module-source-variables",
            "tofu",
            `Variables in a module \`${name}\` only work with OpenTofu; use a literal value.`,
          ),
        );
      }
    }

    let header = "";
    let inBackend = inside("terraform", "backend");
    for (const ch of text) {
      if (ch === "{") {
        const trimmed = header.trim();
        const isBlock = trimmed !== "" && !/[=(,[:?]/.test(trimmed) && /^[A-Za-z_]/.test(trimmed);
        const type = isBlock ? /^[A-Za-z_][\w-]*/.exec(trimmed)?.[0] : undefined;
        stack.push({ type });
        if (inside("terraform", "backend")) inBackend = true;
        if (type !== undefined && stack.length === 2 && stack[0]?.type === "terraform") {
          if (type === "encryption") {
            issues.push(
              issue(
                file,
                line,
                "encryption-block",
                "tofu",
                "The `encryption` block only works with OpenTofu; pass it through the TF_ENCRYPTION environment variable instead.",
              ),
            );
          } else if (type === "cloud") {
            issues.push(
              issue(
                file,
                line,
                "cloud-block",
                "terraform",
                "The `cloud` block only works with Terraform; use a `backend` block instead.",
              ),
            );
          }
        }
        header = "";
      } else if (ch === "}") {
        stack.pop();
        header = "";
      } else {
        header += ch;
      }
    }

    if (inBackend && VARIABLE_REF.test(text)) {
      issues.push(
        issue(
          file,
          line,
          "backend-variables",
          "tofu",
          "Variables in a `backend` block only work with OpenTofu; use literal values or `-backend-config`.",
        ),
      );
    }
  });
  return issues;
}

/**
 * Flags constructs that only one engine understands, so generated HCL stays in the dialect
 * subset shared by Terraform and OpenTofu (constitution III, spec FR-203). This is a light
 * scanner (comments and string literals are ignored), not a full HCL parser.
 */
export function checkDialect(files: readonly DialectFile[]): DialectIssue[] {
  const issues: DialectIssue[] = [];
  for (const { path, content } of files) {
    if (TOFU_FILE.test(path)) {
      issues.push(
        issue(
          path,
          1,
          "tofu-file",
          "tofu",
          "`.tofu` files are only read by OpenTofu; Terraform ignores them. Use `.tf`.",
        ),
      );
    }
    if (TERRAFORM_STACK_FILE.test(path)) {
      issues.push(
        issue(
          path,
          1,
          "terraform-stack-file",
          "terraform",
          "Terraform Stacks files are only read by Terraform.",
        ),
      );
    }
    if (HCL_FILE.test(path)) issues.push(...checkHcl(path, content));
  }
  return issues;
}
