/** One word of a directive. Quotes are removed; a quoted word is never a block brace. */
export interface Word {
  text: string;
  quoted: boolean;
}

/**
 * One directive: its words (the name first), its 1-based line, and the blocks it sits in. A `}`
 * that closes no block of the file is a statement of its own, the single unquoted word `}`, and
 * so is a `{` that opens a block without a directive, the word `{`.
 */
export interface Statement {
  words: Word[];
  line: number;
  /** The names of the enclosing blocks' directives, outermost first. */
  parents: string[];
  /** The index of the enclosing block's statement, or -1 at the top of the file. */
  parent: number;
}

/** nginx's whitespace: only space, tab, CR and LF. */
const SPACE = /[ \t\r\n]/;
/** Go's `unicode.IsSpace`, which Caddy's lexer uses: JavaScript's `\s` without U+FEFF, plus U+0085. */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** Collects statements and the block stack while a tokenizer runs. */
class Collector {
  readonly statements: Statement[] = [];
  /** The open blocks: their directive's name and statement index. */
  readonly stack: { name: string; index: number }[] = [];
  words: Word[] = [];
  start = 1;

  add(word: Word, line: number): void {
    if (this.words.length === 0) this.start = line;
    this.words.push(word);
  }

  /**
   * Ends the current statement; `opens` makes it the directive of a new block, and a block opened
   * without words becomes the statement `{` at `line`.
   */
  end(opens = false, line = this.start): void {
    const words = this.words;
    this.words = [];
    if (words.length > 0) this.push(words, this.start);
    else if (opens) this.push([{ text: "{", quoted: false }], line);
    else return;
    if (opens) this.stack.push({ name: words[0]?.text ?? "{", index: this.statements.length - 1 });
  }

  /** Ends the current statement and closes the innermost block, at `line`. */
  close(line: number): void {
    this.end();
    if (this.stack.pop() === undefined) this.push([{ text: "}", quoted: false }], line, true);
  }

  private push(words: Word[], line: number, top = false): void {
    this.statements.push({
      words,
      line,
      parents: top ? [] : this.stack.map((b) => b.name),
      parent: top ? -1 : (this.stack.at(-1)?.index ?? -1),
    });
  }
}

/**
 * nginx's syntax, split as nginx splits it: directives end with `;`, blocks are `{ … }`, and at
 * the start of a word `#` begins a comment and `"…"` or `'…'` is one quoted word. A word ends only
 * at a space, `;` or `{`, except a `{` right after `$`.
 */
export function parseNginx(text: string): Statement[] {
  const out = new Collector();
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (SPACE.test(ch)) {
      if (ch === "\n") line++;
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === ";" || ch === "{") {
      out.end(ch === "{", line);
      i++;
    } else if (ch === "}") {
      out.close(line);
      i++;
    } else if (ch === '"' || ch === "'") {
      const startLine = line;
      let word = "";
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        if (text[i] === "\n") line++;
        word += text[i];
        i++;
      }
      i++;
      out.add({ text: word, quoted: true }, startLine);
    } else {
      const startLine = line;
      let word = "";
      let variable = false;
      while (i < text.length) {
        const c = text.charAt(i);
        if (c === "{" && variable) {
          word += c;
          i++;
          continue;
        }
        if (SPACE.test(c) || c === ";" || c === "{") break;
        variable = c === "$";
        if (c === "\\" && i + 1 < text.length) {
          word += c;
          i++;
        }
        if (text[i] === "\n") line++;
        word += text.charAt(i);
        i++;
      }
      out.add({ text: word, quoted: false }, startLine);
    }
  }
  out.end();
  return out.statements;
}

/**
 * The Caddyfile's syntax, split as Caddy's lexer splits it:
 * - a directive is one line; a backslash before the newline (also in a comment) continues it;
 * - a `{` word at the end of a line opens a block, and every unquoted `}` word closes one;
 * - at the start of a word, `#` begins a comment, and `"…"` (with `\"`) or `` `…` `` is one word,
 *   also across lines;
 * - a word `<<MARKER` right before the newline starts a heredoc, which ends at the first
 *   `MARKER` after it.
 */
export function parseCaddy(text: string): Statement[] {
  const out = new Collector();
  const endLine = () => {
    const last = out.words.at(-1);
    const opens = last?.text === "{" && !last.quoted;
    if (opens) out.words.pop();
    out.end(opens);
  };
  let line = 1;
  let i = 0;
  while (i < text.length) {
    // One word, read as Caddy's lexer reads its next token.
    let val = "";
    let quote = "";
    let marker: string | undefined;
    let heredocEscaped = false;
    let escaped = false;
    let comment = false;
    let lineEnds = false;
    let wordLine = line;
    let word: Word | undefined;
    while (i < text.length) {
      const ch = text.charAt(i++);
      if (marker !== undefined) {
        val += ch;
        if (ch === "\n") line++;
        if (val.endsWith(marker)) {
          word = { text: val.slice(0, val.length - marker.length), quoted: true };
          break;
        }
      } else if (!quote && !heredocEscaped && val.startsWith("<<")) {
        if (ch === " ") {
          word = { text: val, quoted: false };
          break;
        }
        if (ch === "\n") {
          marker = val.slice(2);
          val = "";
          line++;
        } else if (ch !== "\r") {
          val += ch;
        }
      } else if (!escaped && quote !== "`" && ch === "\\") {
        escaped = true;
      } else if (quote) {
        if (quote === '"' && escaped) {
          if (ch !== '"') val += "\\";
          escaped = false;
        } else if (ch === quote) {
          word = { text: val, quoted: true };
          break;
        }
        if (ch === "\n") line++;
        val += ch;
      } else if (ch === "\r") {
        // Caddy drops a CR without ending the word.
      } else if (GO_SPACE.test(ch)) {
        if (ch === "\n") {
          line++;
          if (escaped) escaped = false;
          else lineEnds = true;
          comment = false;
        }
        if (val) {
          word = { text: val, quoted: false };
          break;
        }
        if (lineEnds) {
          endLine();
          lineEnds = false;
        }
      } else {
        if (ch === "#" && !val) comment = true;
        if (comment) continue;
        if (!val) {
          wordLine = line;
          if (ch === '"' || ch === "`") {
            quote = ch;
            continue;
          }
        }
        if (escaped) {
          if (ch === "<") heredocEscaped = true;
          else val += "\\";
          escaped = false;
        }
        val += ch;
      }
    }
    if (word === undefined && val)
      word = { text: val, quoted: quote !== "" || marker !== undefined };
    if (word?.text === "}" && !word.quoted) out.close(wordLine);
    else if (word) out.add(word, wordLine);
    if (lineEnds) endLine();
  }
  endLine();
  return out.statements;
}
