/**
 * Lexer for the proto2 subset. Produces tokens and attaches the comments
 * seen since the previous token, so the parser can surface them as doc
 * comments in the generated TypeScript.
 */

export class CompileError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, line = 0, col = 0) {
    super(line > 0 ? `${line}:${col}: ${message}` : message);
    this.name = "CompileError";
    this.line = line;
    this.col = col;
  }
}

export type TokenKind = "ident" | "number" | "string" | "punct" | "eof";

export interface CommentInfo {
  text: string;
  line: number;
}

export interface Token {
  kind: TokenKind;
  /** Identifier text / decimal digits / string contents / punctuation char. */
  value: string;
  line: number;
  col: number;
  /** Comments (line or block) encountered since the previous token. */
  comments: CommentInfo[];
}

const PUNCT = new Set([
  "{",
  "}",
  ";",
  "=",
  "[",
  "]",
  ",",
  ".",
  "(",
  ")",
  "<",
  ">",
]);

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let pendingComments: CommentInfo[] = [];

  const fail = (msg: string): never => {
    throw new CompileError(msg, line, col);
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      col++;
      continue;
    }
    if (c === "\n") {
      i++;
      line++;
      col = 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < src.length && src[j] !== "\n") j++;
      pendingComments.push({ text: src.slice(i + 2, j).trim(), line });
      col += j - i;
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) fail("unterminated block comment");
      const startLine = line;
      const body = src.slice(i + 2, end);
      for (let k = i; k < end + 2; k++) {
        if (src[k] === "\n") {
          line++;
          col = 1;
        } else {
          col++;
        }
      }
      pendingComments.push({ text: body.trim(), line: startLine });
      i = end + 2;
      continue;
    }

    const tLine = line;
    const tCol = col;
    const comments = pendingComments;
    pendingComments = [];

    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({
        kind: "ident",
        value: src.slice(i, j),
        line: tLine,
        col: tCol,
        comments,
      });
      col += j - i;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      tokens.push({
        kind: "number",
        value: src.slice(i, j),
        line: tLine,
        col: tCol,
        comments,
      });
      col += j - i;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= src.length) fail("unterminated string literal");
        const ch = src[j]!;
        if (ch === '"') {
          j++;
          break;
        }
        if (ch === "\n") fail("unterminated string literal");
        if (ch === "\\") {
          const e = src[j + 1];
          if (e === '"' || e === "\\") {
            out += e;
            j += 2;
            continue;
          }
          if (e === "n") {
            out += "\n";
            j += 2;
            continue;
          }
          if (e === "t") {
            out += "\t";
            j += 2;
            continue;
          }
          fail(`unsupported escape '\\${e ?? ""}' in string literal`);
        }
        out += ch;
        j++;
      }
      tokens.push({
        kind: "string",
        value: out,
        line: tLine,
        col: tCol,
        comments,
      });
      col += j - i;
      i = j;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({
        kind: "punct",
        value: c,
        line: tLine,
        col: tCol,
        comments,
      });
      i++;
      col++;
      continue;
    }
    fail(`unexpected character '${c}'`);
  }
  tokens.push({ kind: "eof", value: "", line, col, comments: pendingComments });
  return tokens;
}
