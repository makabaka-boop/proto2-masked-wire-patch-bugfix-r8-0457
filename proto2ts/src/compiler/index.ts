import { generateTs } from "./codegen.js";
import type { CodegenOptions } from "./codegen.js";
import { parseProto } from "./parser.js";

export { CompileError, lex } from "./lexer.js";
export type { Token, TokenKind } from "./lexer.js";
export {
  parseProto,
  MAX_MESSAGES,
  MAX_FIELD_NO,
  RESERVED_FIELD_NO_MIN,
  RESERVED_FIELD_NO_MAX,
} from "./parser.js";
export type { FieldDecl, MessageDecl, ProtoFile } from "./parser.js";
export { generateTs } from "./codegen.js";
export type { CodegenOptions } from "./codegen.js";

/** Compile .proto source text into a TypeScript module. */
export function compileProto(source: string, opts: CodegenOptions): string {
  return generateTs(parseProto(source), opts);
}
