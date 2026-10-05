/**
 * Parser + validator for the proto2 subset:
 *
 *   file    := syntaxDecl? packageDecl? messageDecl*
 *   message := 'message' ident '{' fieldDecl* '}'
 *   field   := label type ident '=' number ('[' opts ']')? ';'
 *   label   := 'required' | 'optional' | 'repeated'
 *   type    := 'int32' | 'uint32' | 'sint32' | 'bool' | 'string' | 'bytes' | ident
 *   opts    := 'packed' '=' ('true' | 'false') (',' ...)
 *
 * No import / enum / oneof / group / map / nested messages. Type references
 * are resolved after the whole file is parsed, so forward references (and
 * self references) are legal. Validation reports every problem it finds
 * (duplicate names, duplicate/illegal field numbers, unknown types, misuse
 * of packed) in one CompileError with one line per problem.
 */

import { CompileError, lex } from "./lexer.js";
import type { Token } from "./lexer.js";

export const MAX_MESSAGES = 6;
export const MAX_FIELD_NO = 536870911; // 2^29 - 1
export const RESERVED_FIELD_NO_MIN = 19000;
export const RESERVED_FIELD_NO_MAX = 19999;

export const SCALAR_TYPES = [
  "int32",
  "uint32",
  "sint32",
  "bool",
  "string",
  "bytes",
] as const;
export type ScalarTypeName = (typeof SCALAR_TYPES)[number];
const SCALAR_SET = new Set<string>(SCALAR_TYPES);
/** Scalars that may be packed (wire type 0). string/bytes may not. */
const PACKABLE_SET = new Set<string>(["int32", "uint32", "sint32", "bool"]);

export type Label = "required" | "optional" | "repeated";
const LABELS = new Set<string>(["required", "optional", "repeated"]);

export interface FieldDecl {
  label: Label;
  typeName: string; // scalar name or a message name
  name: string;
  no: number;
  packed: boolean;
  doc: string[];
  line: number;
  col: number;
}

export interface MessageDecl {
  name: string;
  doc: string[];
  fields: FieldDecl[];
  line: number;
  col: number;
}

export interface ProtoFile {
  syntax: "proto2";
  packageName?: string;
  messages: MessageDecl[];
}

const UNSUPPORTED_TOP_LEVEL = new Set([
  "import",
  "option",
  "enum",
  "service",
  "extend",
  "rpc",
  "oneof",
  "reserved",
]);
const UNSUPPORTED_IN_MESSAGE = new Set([
  "message",
  "enum",
  "oneof",
  "group",
  "map",
  "reserved",
  "extensions",
  "option",
  "extend",
  "to",
]);

export function parseProto(source: string): ProtoFile {
  const file = new Parser(lex(source)).parseFile();
  validateFile(file);
  return file;
}

function describe(t: Token): string {
  return t.kind === "eof" ? "end of file" : `'${t.value}'`;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private fail(msg: string, t?: Token): never {
    const tok = t ?? this.peek();
    throw new CompileError(msg, tok.line, tok.col);
  }

  private atPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === v;
  }

  private eatPunct(v: string): boolean {
    if (this.atPunct(v)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(v: string): Token {
    const t = this.peek();
    if (t.kind !== "punct" || t.value !== v)
      this.fail(`expected '${v}', got ${describe(t)}`);
    return this.next();
  }

  private expectIdent(what: string): Token {
    const t = this.peek();
    if (t.kind !== "ident") this.fail(`expected ${what}, got ${describe(t)}`);
    return this.next();
  }

  parseFile(): ProtoFile {
    let syntaxSeen = false;
    let packageName: string | undefined;
    const messages: MessageDecl[] = [];

    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") break;
      if (this.eatPunct(";")) continue; // stray semicolons are tolerated
      if (t.kind !== "ident")
        this.fail(`expected a top-level statement, got ${describe(t)}`);
      switch (t.value) {
        case "syntax": {
          if (syntaxSeen || packageName !== undefined || messages.length > 0) {
            this.fail("'syntax' must be the first statement of the file");
          }
          this.next();
          this.expectPunct("=");
          const s = this.peek();
          if (s.kind !== "string")
            this.fail(`expected a quoted syntax string, got ${describe(s)}`);
          this.next();
          if (s.value !== "proto2") {
            this.fail(
              `unsupported syntax "${s.value}"; only "proto2" is supported`,
              s,
            );
          }
          this.expectPunct(";");
          syntaxSeen = true;
          break;
        }
        case "package": {
          if (messages.length > 0)
            this.fail("'package' must precede message declarations");
          this.next();
          const parts = [this.expectIdent("a package name").value];
          while (this.eatPunct("."))
            parts.push(this.expectIdent("a package name").value);
          this.expectPunct(";");
          packageName = parts.join(".");
          break;
        }
        case "message":
          messages.push(this.parseMessage());
          break;
        default:
          if (UNSUPPORTED_TOP_LEVEL.has(t.value)) {
            this.fail(
              `'${t.value}' is not supported; this compiler handles plain proto2 messages only`,
            );
          }
          this.fail(`unexpected '${t.value}'; expected 'message'`);
      }
    }
    const file: ProtoFile = { syntax: "proto2", messages };
    if (packageName !== undefined) file.packageName = packageName;
    return file;
  }

  private parseMessage(): MessageDecl {
    const kw = this.next(); // 'message'
    const nameTok = this.expectIdent("a message name");
    this.expectPunct("{");
    const fields: FieldDecl[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof")
        this.fail(`unterminated message '${nameTok.value}'; expected '}'`);
      if (this.eatPunct("}")) break;
      if (this.eatPunct(";")) continue;
      if (t.kind !== "ident")
        this.fail(`expected a field declaration, got ${describe(t)}`);
      if (!LABELS.has(t.value)) {
        if (UNSUPPORTED_IN_MESSAGE.has(t.value)) {
          this.fail(
            `'${t.value}' is not supported inside a message in this proto2 subset`,
          );
        }
        this.fail(
          `expected 'required', 'optional' or 'repeated', got '${t.value}'`,
        );
      }
      fields.push(this.parseField());
    }
    return {
      name: nameTok.value,
      doc: kw.comments.map((c) => c.text),
      fields,
      line: kw.line,
      col: kw.col,
    };
  }

  private parseField(): FieldDecl {
    const labelTok = this.next(); // required | optional | repeated
    const typeTok = this.expectIdent("a field type");
    if (UNSUPPORTED_IN_MESSAGE.has(typeTok.value)) {
      this.fail(
        `'${typeTok.value}' is not supported as a field type in this proto2 subset`,
        typeTok,
      );
    }
    const nameTok = this.expectIdent("a field name");
    this.expectPunct("=");
    const noTok = this.peek();
    if (noTok.kind !== "number")
      this.fail(`expected a field number, got ${describe(noTok)}`);
    this.next();
    const no = parseInt(noTok.value, 10);

    let packed = false;
    if (this.eatPunct("[")) {
      for (;;) {
        const optTok = this.expectIdent("an option name");
        if (optTok.value !== "packed") {
          this.fail(
            `unsupported field option '${optTok.value}'; only 'packed' is supported`,
            optTok,
          );
        }
        this.expectPunct("=");
        const valTok = this.expectIdent("'true' or 'false'");
        if (valTok.value !== "true" && valTok.value !== "false") {
          this.fail(
            `packed must be 'true' or 'false', got '${valTok.value}'`,
            valTok,
          );
        }
        packed = valTok.value === "true";
        // The mere presence of the option is constrained, like protoc does:
        // repeated numeric scalar fields only. Label and type are already
        // known here, so misuse fails fast with an exact position.
        if (labelTok.value !== "repeated" || !PACKABLE_SET.has(typeTok.value)) {
          this.fail(
            `'packed' is only allowed for repeated numeric scalar fields (int32, uint32, sint32, bool), not on '${labelTok.value} ${typeTok.value}'`,
            optTok,
          );
        }
        if (this.eatPunct(",")) continue;
        break;
      }
      this.expectPunct("]");
    }
    const semi = this.expectPunct(";");
    const doc = labelTok.comments.map((c) => c.text);
    // A comment starting on the same line as the terminating ';' is a
    // trailing comment and belongs to this field, not the next one.
    const nextTok = this.peek();
    const first = nextTok.comments[0];
    if (first !== undefined && first.line === semi.line) {
      doc.push(nextTok.comments.shift()!.text);
    }
    return {
      label: labelTok.value as Label,
      typeName: typeTok.value,
      name: nameTok.value,
      no,
      packed,
      doc,
      line: labelTok.line,
      col: labelTok.col,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation (collects every problem, then reports them all at once)
// ---------------------------------------------------------------------------

function validateFile(file: ProtoFile): void {
  const errors: string[] = [];
  const err = (line: number, col: number, msg: string): void => {
    errors.push(`${line}:${col}: ${msg}`);
  };

  if (file.messages.length > MAX_MESSAGES) {
    const extra = file.messages[MAX_MESSAGES]!;
    err(
      extra.line,
      extra.col,
      `at most ${MAX_MESSAGES} top-level messages allowed, got ${file.messages.length}`,
    );
  }
  if (file.messages.length === 0) {
    err(1, 1, "the file declares no messages");
  }

  const messageNames = new Map<string, MessageDecl>();
  for (const m of file.messages) {
    const prev = messageNames.get(m.name);
    if (prev !== undefined) {
      err(
        m.line,
        m.col,
        `duplicate message name '${m.name}' (first declared at ${prev.line}:${prev.col})`,
      );
    } else {
      messageNames.set(m.name, m);
    }
    if (SCALAR_SET.has(m.name)) {
      err(
        m.line,
        m.col,
        `message name '${m.name}' conflicts with a built-in scalar type`,
      );
    }
  }

  for (const m of file.messages) {
    const seenNames = new Map<string, FieldDecl>();
    const seenNos = new Map<number, FieldDecl>();
    for (const f of m.fields) {
      const where = `field '${m.name}.${f.name}'`;

      const prevName = seenNames.get(f.name);
      if (prevName !== undefined) {
        err(
          f.line,
          f.col,
          `duplicate field name '${f.name}' in message '${m.name}' (first declared at ${prevName.line}:${prevName.col})`,
        );
      } else {
        seenNames.set(f.name, f);
      }

      if (!Number.isInteger(f.no) || f.no < 1 || f.no > MAX_FIELD_NO) {
        err(
          f.line,
          f.col,
          `illegal field number ${f.no} on ${where}: must be an integer in [1, ${MAX_FIELD_NO}]`,
        );
      } else if (
        f.no >= RESERVED_FIELD_NO_MIN &&
        f.no <= RESERVED_FIELD_NO_MAX
      ) {
        err(
          f.line,
          f.col,
          `illegal field number ${f.no} on ${where}: ${RESERVED_FIELD_NO_MIN}–${RESERVED_FIELD_NO_MAX} are reserved by the protocol`,
        );
      } else {
        const prevNo = seenNos.get(f.no);
        if (prevNo !== undefined) {
          err(
            f.line,
            f.col,
            `duplicate field number ${f.no} in message '${m.name}' (already used by field '${prevNo.name}')`,
          );
        } else {
          seenNos.set(f.no, f);
        }
      }

      if (!SCALAR_SET.has(f.typeName) && !messageNames.has(f.typeName)) {
        err(f.line, f.col, `unknown type '${f.typeName}' on ${where}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new CompileError(errors.join("\n"));
  }
}
