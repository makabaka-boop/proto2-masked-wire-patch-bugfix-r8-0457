/**
 * proto2ts shared runtime.
 *
 * Everything a generated module needs at run time:
 *  - varint / ZigZag primitives (Reader / Writer)
 *  - descriptor-driven encode / decode
 *  - presence semantics (absent vs. explicit default)
 *  - recursive merge of duplicated singular nested messages
 *  - required-field validation, deferred until the whole message is merged
 *  - unknown-field preservation (raw wire bytes, in order)
 *
 * Only wire types 0 (varint), 1 (64-bit), 2 (length-delimited) and 5
 * (32-bit) are supported. Groups (3/4) are rejected.
 */

export const MAX_DEPTH = 8;
export const MAX_FIELD_NO = 536870911; // 2^29 - 1

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

// ---------------------------------------------------------------------------
// Descriptors (emitted by the compiler, consumed by the generic codec)
// ---------------------------------------------------------------------------

export type ScalarType =
  | "int32"
  | "uint32"
  | "sint32"
  | "bool"
  | "string"
  | "bytes";
export type FieldType = ScalarType | "message";
export type Label = "required" | "optional" | "repeated";

export interface FieldDesc {
  no: number;
  name: string;
  label: Label;
  type: FieldType;
  packed?: boolean;
  /** Lazy reference to the nested message descriptor (handles forward refs and cycles). */
  msg?: () => MessageDesc;
}

export interface MessageDesc {
  name: string;
  fields: FieldDesc[];
}

const SCALAR_WIRE_TYPE: Record<ScalarType, number> = {
  int32: 0,
  uint32: 0,
  sint32: 0,
  bool: 0,
  string: 2,
  bytes: 2,
};

/** Packable == length-delimited encoding of concatenated payloads is defined. */
function isPackable(type: FieldType): boolean {
  return type !== "message" && SCALAR_WIRE_TYPE[type] === 0;
}

interface Prepared {
  byNo: Map<number, FieldDesc>;
  sorted: FieldDesc[]; // ascending field number, for deterministic encoding
}

const preparedCache = new WeakMap<MessageDesc, Prepared>();

function prepare(desc: MessageDesc): Prepared {
  let p = preparedCache.get(desc);
  if (p === undefined) {
    p = {
      byNo: new Map(desc.fields.map((f) => [f.no, f])),
      sorted: [...desc.fields].sort((a, b) => a.no - b.no),
    };
    preparedCache.set(desc, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Unknown fields
// ---------------------------------------------------------------------------

export interface UnknownField {
  /** Field number seen on the wire. */
  no: number;
  /** Wire type: 0, 1, 2 or 5. */
  wireType: number;
  /** Raw wire bytes, tag included; copied out of the input buffer. */
  bytes: Uint8Array;
}

export const UNKNOWN_FIELDS: unique symbol = Symbol("proto2ts.unknownFields");

/** Unknown fields carried by a decoded message, in wire order. */
export function getUnknownFields(msg: unknown): readonly UnknownField[] {
  if (msg !== null && typeof msg === "object") {
    return (
      ((msg as Record<symbol, unknown>)[UNKNOWN_FIELDS] as
        | UnknownField[]
        | undefined) ?? []
    );
  }
  return [];
}

function setUnknownFields(msg: object, fields: UnknownField[]): void {
  Object.defineProperty(msg, UNKNOWN_FIELDS, {
    value: fields,
    writable: true,
    enumerable: false, // keep JSON.stringify / for-in clean
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class Writer {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
  }

  private reserve(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = Math.max(1, this.buf.length) * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.reserve(1);
    this.buf[this.len++] = b & 0xff;
  }

  bytes(bs: Uint8Array): void {
    this.reserve(bs.length);
    this.buf.set(bs, this.len);
    this.len += bs.length;
  }

  /** Unsigned 64-bit varint. */
  varint(v: bigint): void {
    if (v < 0n) throw new EncodeError(`varint must be non-negative, got ${v}`);
    if (v > 0xffff_ffff_ffff_ffffn)
      throw new EncodeError(`varint exceeds 64 bits: ${v}`);
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.byte(Number(v));
  }

  tag(fieldNo: number, wireType: number): void {
    // fieldNo * 8 stays below 2^32 for legal field numbers; avoid << (signed 32-bit).
    this.varint(BigInt(fieldNo * 8 + wireType));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class Reader {
  pos = 0;

  constructor(public readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Unsigned 64-bit varint; fails on truncation and on > 64 bits. */
  varint(): bigint {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) {
        throw new DecodeError(
          "truncated varint: buffer ended before the varint terminated",
        );
      }
      const b = this.buf[this.pos++]!;
      if (i === 9 && (b & 0xfe) !== 0) {
        // The 10th byte may carry a single payload bit (64 bits total) and no continuation.
        throw new DecodeError("varint exceeds 64 bits");
      }
      result |= BigInt(b & 0x7f) << BigInt(i * 7);
      if ((b & 0x80) === 0) return result;
    }
    throw new DecodeError("varint exceeds 64 bits");
  }

  /** Length prefix of a length-delimited field; must fit the remaining input. */
  readLength(): number {
    const v = this.varint();
    if (v > BigInt(this.remaining)) {
      throw new DecodeError(
        `length-delimited field declares ${v} bytes but only ${this.remaining} remain`,
      );
    }
    return Number(v);
  }

  skip(n: number): void {
    if (n > this.remaining) {
      throw new DecodeError(
        `cannot skip ${n} byte(s); only ${this.remaining} remain`,
      );
    }
    this.pos += n;
  }
}

// ---------------------------------------------------------------------------
// Scalar codecs
// ---------------------------------------------------------------------------

export function zigzagEncode32(v: number): number {
  return ((v << 1) ^ (v >> 31)) >>> 0;
}

export function zigzagDecode32(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function readScalar(r: Reader, type: ScalarType): unknown {
  switch (type) {
    case "int32":
      // Negative values arrive as 10-byte varints (sign-extended to 64 bits);
      // truncating back to 32 bits recovers the original number.
      return Number(BigInt.asIntN(32, r.varint()));
    case "uint32":
      return Number(BigInt.asUintN(32, r.varint()));
    case "sint32":
      return zigzagDecode32(Number(BigInt.asUintN(32, r.varint())));
    case "bool":
      return r.varint() !== 0n;
    case "string": {
      const len = r.readLength();
      const view = r.buf.subarray(r.pos, r.pos + len);
      let s: string;
      try {
        s = utf8Decoder.decode(view);
      } catch {
        throw new DecodeError("invalid UTF-8 in string field");
      }
      r.pos += len;
      return s;
    }
    case "bytes": {
      const len = r.readLength();
      const b = r.buf.slice(r.pos, r.pos + len); // copy: detach from the input buffer
      r.pos += len;
      return b;
    }
  }
}

function expectInt(v: unknown, what: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new EncodeError(
      `${what}: expected an integer in [${lo}, ${hi}], got ${String(v)}`,
    );
  }
  return v;
}

export function writeScalar(
  w: Writer,
  type: ScalarType,
  value: unknown,
  what = "value",
): void {
  switch (type) {
    case "int32": {
      const v = expectInt(value, what, -2147483648, 2147483647);
      // Negative int32 is sign-extended to 64 bits -> 10-byte varint.
      w.varint(v < 0 ? BigInt.asUintN(64, BigInt(v)) : BigInt(v));
      return;
    }
    case "uint32":
      w.varint(BigInt(expectInt(value, what, 0, 4294967295)));
      return;
    case "sint32":
      w.varint(
        BigInt(zigzagEncode32(expectInt(value, what, -2147483648, 2147483647))),
      );
      return;
    case "bool":
      if (typeof value !== "boolean") {
        throw new EncodeError(
          `${what}: expected a boolean, got ${typeof value}`,
        );
      }
      w.varint(value ? 1n : 0n);
      return;
    case "string": {
      if (typeof value !== "string") {
        throw new EncodeError(
          `${what}: expected a string, got ${typeof value}`,
        );
      }
      const b = utf8Encoder.encode(value);
      w.varint(BigInt(b.length));
      w.bytes(b);
      return;
    }
    case "bytes":
      if (!(value instanceof Uint8Array)) {
        throw new EncodeError(`${what}: expected a Uint8Array`);
      }
      w.varint(BigInt(value.length));
      w.bytes(value);
      return;
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodeMessage<T>(desc: MessageDesc, msg: T): Uint8Array {
  const w = new Writer();
  encodeInto(w, desc, msg, 1);
  return w.finish();
}

function encodeInto(
  w: Writer,
  desc: MessageDesc,
  msg: unknown,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new EncodeError(
      `message nesting depth ${depth} exceeds the limit of ${MAX_DEPTH}`,
    );
  }
  if (msg === null || typeof msg !== "object") {
    throw new EncodeError(
      `${desc.name}: expected an object, got ${msg === null ? "null" : typeof msg}`,
    );
  }
  const rec = msg as Record<string, unknown>;
  for (const f of prepare(desc).sorted) {
    const v = rec[f.name];
    const what = `${desc.name}.${f.name}`;
    if (f.label === "repeated") {
      if (v === undefined || v === null) continue; // nothing to write
      if (!Array.isArray(v))
        throw new EncodeError(`${what}: expected an array`);
      if (f.packed && isPackable(f.type)) {
        if (v.length === 0) continue;
        const pw = new Writer();
        for (const el of v) writeScalar(pw, f.type as ScalarType, el, what);
        const payload = pw.finish();
        w.tag(f.no, 2);
        w.varint(BigInt(payload.length));
        w.bytes(payload);
      } else {
        for (const el of v) writeSingular(w, desc, f, el, depth);
      }
    } else {
      if (v === undefined || v === null) {
        if (f.label === "required") {
          throw new EncodeError(`${what}: required field is missing`);
        }
        continue; // absent optional fields are not written, even if === default
      }
      writeSingular(w, desc, f, v, depth);
    }
  }
  // Unknown fields ride along, in their original relative order.
  for (const u of getUnknownFields(msg)) w.bytes(u.bytes);
}

function writeSingular(
  w: Writer,
  desc: MessageDesc,
  f: FieldDesc,
  v: unknown,
  depth: number,
): void {
  const what = `${desc.name}.${f.name}`;
  if (f.type === "message") {
    const sw = new Writer();
    encodeInto(sw, f.msg!(), v, depth + 1);
    const payload = sw.finish();
    w.tag(f.no, 2);
    w.varint(BigInt(payload.length));
    w.bytes(payload);
  } else {
    w.tag(f.no, SCALAR_WIRE_TYPE[f.type as ScalarType]);
    writeScalar(w, f.type as ScalarType, v, what);
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodeMessage<T>(desc: MessageDesc, buf: Uint8Array): T {
  const msg = decodeInto(new Reader(buf), desc, 1);
  // Required fields are validated only after the whole message (and every
  // duplicated nested chunk) has been merged.
  validateRequired(desc, msg, desc.name);
  return msg as T;
}

function acceptsWireType(f: FieldDesc, wt: number): boolean {
  if (f.type === "message") return wt === 2;
  const want = SCALAR_WIRE_TYPE[f.type];
  if (wt === want) return true;
  // Repeated packable scalars must also accept a length-delimited packed block,
  // regardless of the declared packed= option (encoders may send either form).
  return f.label === "repeated" && isPackable(f.type) && wt === 2;
}

function decodeInto(
  r: Reader,
  desc: MessageDesc,
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new DecodeError(
      `message nesting depth ${depth} exceeds the limit of ${MAX_DEPTH}`,
    );
  }
  const prep = prepare(desc);
  const msg: Record<string, unknown> = {};
  for (const f of desc.fields) {
    if (f.label === "repeated") msg[f.name] = [];
  }
  let unknown: UnknownField[] | undefined;

  while (!r.eof) {
    const tagStart = r.pos;
    const tag = r.varint();
    const no = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (no <= 0 || no > MAX_FIELD_NO) {
      throw new DecodeError(`illegal field number ${no} on the wire`);
    }
    const f = prep.byNo.get(no);
    if (f === undefined || !acceptsWireType(f, wt)) {
      // Unknown field (or a known field arriving with a foreign wire type):
      // keep the raw bytes so a later re-encode does not lose them.
      (unknown ??= []).push(readUnknownField(r, no, wt, tagStart));
      continue;
    }
    if (f.label === "repeated") {
      const arr = msg[f.name] as unknown[];
      if (f.type !== "message" && wt === 2 && isPackable(f.type)) {
        // Packed block: concatenated scalar payloads, no per-element tags.
        const len = r.readLength();
        const sub = new Reader(r.buf.subarray(r.pos, r.pos + len));
        r.pos += len;
        while (!sub.eof) arr.push(readScalar(sub, f.type as ScalarType));
      } else {
        arr.push(readFieldValue(r, f, depth));
      }
    } else if (f.type === "message") {
      const v = readFieldValue(r, f, depth);
      const prev = msg[f.name];
      // A singular nested message occurring again is merged recursively,
      // not replaced.
      msg[f.name] =
        prev === undefined
          ? v
          : mergeMessage(
              f.msg!(),
              prev as Record<string, unknown>,
              v as Record<string, unknown>,
            );
    } else {
      msg[f.name] = readScalar(r, f.type as ScalarType); // last one wins
    }
  }
  if (unknown !== undefined) setUnknownFields(msg, unknown);
  return msg;
}

function readFieldValue(r: Reader, f: FieldDesc, depth: number): unknown {
  if (f.type === "message") {
    const len = r.readLength();
    const sub = new Reader(r.buf.subarray(r.pos, r.pos + len));
    r.pos += len;
    return decodeInto(sub, f.msg!(), depth + 1);
  }
  return readScalar(r, f.type as ScalarType);
}

function readUnknownField(
  r: Reader,
  no: number,
  wt: number,
  tagStart: number,
): UnknownField {
  switch (wt) {
    case 0:
      r.varint();
      break;
    case 1:
      r.skip(8);
      break;
    case 2: {
      const len = r.readLength();
      r.skip(len);
      break;
    }
    case 5:
      r.skip(4);
      break;
    default:
      throw new DecodeError(
        `unsupported wire type ${wt} (field ${no}); only 0, 1, 2 and 5 are supported`,
      );
  }
  return { no, wireType: wt, bytes: r.buf.slice(tagStart, r.pos) };
}

/**
 * Recursive last-wins/concat merge of two occurrences of the same message
 * type: singular scalars are overwritten by the later chunk, repeated fields
 * are concatenated, singular nested messages merge recursively, and unknown
 * fields concatenate in order.
 */
function mergeMessage(
  desc: MessageDesc,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  for (const f of desc.fields) {
    const bv = b[f.name];
    if (f.label === "repeated") {
      const arr = bv as unknown[];
      if (arr.length > 0) {
        a[f.name] = [...((a[f.name] as unknown[] | undefined) ?? []), ...arr];
      }
    } else if (bv === undefined) {
      continue;
    } else if (f.type === "message") {
      const av = a[f.name];
      a[f.name] =
        av === undefined
          ? bv
          : mergeMessage(
              f.msg!(),
              av as Record<string, unknown>,
              bv as Record<string, unknown>,
            );
    } else {
      a[f.name] = bv;
    }
  }
  const bu = getUnknownFields(b);
  if (bu.length > 0) {
    setUnknownFields(a, [...getUnknownFields(a), ...bu]);
  }
  return a;
}

function validateRequired(
  desc: MessageDesc,
  msg: Record<string, unknown>,
  path: string,
): void {
  for (const f of desc.fields) {
    const v = msg[f.name];
    if (f.label === "required" && v === undefined) {
      throw new DecodeError(`missing required field ${path}.${f.name}`);
    }
    if (f.type === "message" && v !== undefined && v !== null) {
      const sub = f.msg!();
      if (f.label === "repeated") {
        (v as unknown[]).forEach((el, i) =>
          validateRequired(
            sub,
            el as Record<string, unknown>,
            `${path}.${f.name}[${i}]`,
          ),
        );
      } else {
        validateRequired(
          sub,
          v as Record<string, unknown>,
          `${path}.${f.name}`,
        );
      }
    }
  }
}

/** Decode a partial patch: required fields are checked only on its candidate. */
export function decodePartialMessage(
  desc: MessageDesc,
  buf: Uint8Array,
): Record<string, unknown> {
  return decodeInto(new Reader(buf), desc, 1);
}
export function assertRequiredMessage(
  desc: MessageDesc,
  msg: Record<string, unknown>,
): void {
  validateRequired(desc, msg, desc.name);
}

export { applyMaskedPatch, PatchError, MAX_PATCH_PATHS } from "./masked-patch.js";
