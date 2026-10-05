/**
 * Runtime unit tests. Descriptors are built by hand here; the generated
 * module is exercised end-to-end in integration.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as rt from "../src/runtime/runtime.js";

// ----- test schema ---------------------------------------------------------

const Inner$desc: rt.MessageDesc = {
  name: "Inner",
  fields: [
    { no: 1, name: "a", label: "required", type: "int32" },
    { no: 2, name: "b", label: "optional", type: "string" },
  ],
};

const Outer$desc: rt.MessageDesc = {
  name: "Outer",
  fields: [
    { no: 1, name: "id", label: "required", type: "int32" },
    { no: 2, name: "flag", label: "optional", type: "bool" },
    { no: 3, name: "nums", label: "repeated", type: "sint32", packed: true },
    {
      no: 4,
      name: "inner",
      label: "optional",
      type: "message",
      msg: () => Inner$desc,
    },
    { no: 5, name: "data", label: "optional", type: "bytes" },
    { no: 6, name: "u", label: "optional", type: "uint32" },
    { no: 7, name: "tags", label: "repeated", type: "string" },
    { no: 8, name: "plain_nums", label: "repeated", type: "int32" },
    {
      no: 9,
      name: "inners",
      label: "repeated",
      type: "message",
      msg: () => Inner$desc,
    },
  ],
};

const Node$desc: rt.MessageDesc = {
  name: "Node",
  fields: [
    { no: 1, name: "v", label: "optional", type: "int32" },
    {
      no: 2,
      name: "child",
      label: "optional",
      type: "message",
      msg: () => Node$desc,
    },
  ],
};

interface OuterMsg {
  id?: number;
  flag?: boolean;
  nums?: number[];
  inner?: Record<string, unknown>;
  data?: Uint8Array;
  u?: number;
  tags?: string[];
  plain_nums?: number[];
  inners?: Record<string, unknown>[];
  [k: string]: unknown;
}

function decodeOuter(buf: Uint8Array): OuterMsg {
  return rt.decodeMessage(Outer$desc, buf) as OuterMsg;
}

/** Build a buffer from tagged pieces. */
function build(fn: (w: rt.Writer) => void): Uint8Array {
  const w = new rt.Writer();
  fn(w);
  return w.finish();
}

function putStr(w: rt.Writer, no: number, s: string): void {
  const b = new TextEncoder().encode(s);
  w.tag(no, 2);
  w.varint(BigInt(b.length));
  w.bytes(b);
}

function putVarint(w: rt.Writer, no: number, v: bigint): void {
  w.tag(no, 0);
  w.varint(v);
}

// ----- varint / zigzag primitives ------------------------------------------

test("varint round trips across the 64-bit range", () => {
  const values = [
    0n,
    1n,
    127n,
    128n,
    300n,
    16384n,
    2n ** 31n - 1n,
    2n ** 32n - 1n,
    2n ** 53n,
    2n ** 63n,
    2n ** 64n - 1n,
  ];
  for (const v of values) {
    const w = new rt.Writer();
    w.varint(v);
    const r = new rt.Reader(w.finish());
    assert.equal(r.varint(), v, `round trip ${v}`);
    assert.ok(r.eof);
  }
});

test("varint: 2^64-1 needs exactly 10 bytes", () => {
  const w = new rt.Writer();
  w.varint(2n ** 64n - 1n);
  assert.equal(w.finish().length, 10);
});

test("varint rejects out-of-range encodes", () => {
  assert.throws(() => new rt.Writer().varint(-1n), rt.EncodeError);
  assert.throws(() => new rt.Writer().varint(2n ** 64n), rt.EncodeError);
});

test("varint decode failures: truncated, overlong, overflowing", () => {
  assert.throws(
    () => new rt.Reader(new Uint8Array([0x80])).varint(),
    /truncated varint/,
  );
  // 10 continuation bytes -> never terminates within 64 bits
  assert.throws(
    () =>
      new rt.Reader(
        new Uint8Array([
          0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
        ]),
      ).varint(),
    /exceeds 64 bits/,
  );
  // 10th byte carries more than one payload bit
  assert.throws(
    () =>
      new rt.Reader(
        new Uint8Array([
          0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
        ]),
      ).varint(),
    /exceeds 64 bits/,
  );
  // legal 10-byte form: nine 0xff then 0x01 == 2^64-1
  assert.equal(
    new rt.Reader(
      new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
      ]),
    ).varint(),
    2n ** 64n - 1n,
  );
});

test("zigzag mapping table", () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [-1, 1],
    [1, 2],
    [-2, 3],
    [2, 4],
    [2147483647, 4294967294],
    [-2147483648, 4294967295],
  ];
  for (const [signed, zigged] of cases) {
    assert.equal(rt.zigzagEncode32(signed), zigged);
    assert.equal(rt.zigzagDecode32(zigged), signed);
  }
});

// ----- scalar encoding specifics -------------------------------------------

test("negative int32 encodes as a 10-byte varint and decodes back", () => {
  const buf = rt.encodeMessage(Outer$desc, {
    id: -1,
    nums: [],
    tags: [],
    plain_nums: [],
    inners: [],
  });
  // field 1 tag (0x08) + 10 varint bytes
  assert.equal(buf.length, 11);
  assert.equal(buf[0], 0x08);
  assert.deepEqual(
    [...buf.subarray(1)],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  );
  assert.equal(decodeOuter(buf).id, -1);
});

test("int32 extremes round trip", () => {
  for (const id of [0, 1, -1, 2147483647, -2147483648]) {
    const msg = decodeOuter(
      rt.encodeMessage(Outer$desc, {
        id,
        nums: [],
        tags: [],
        plain_nums: [],
        inners: [],
      }),
    );
    assert.equal(msg.id, id);
  }
});

test("encode validates scalar ranges and types", () => {
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 2147483648 }),
    /Outer\.id/,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: -2147483649 }),
    /Outer\.id/,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1.5 }),
    rt.EncodeError,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1, u: -1 }),
    /Outer\.u/,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1, u: 4294967296 }),
    /Outer\.u/,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1, flag: 1 }),
    rt.EncodeError,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1, data: [1, 2] }),
    rt.EncodeError,
  );
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { id: 1, nums: "x" }),
    /Outer\.nums/,
  );
});

test("uint32 boundary values round trip", () => {
  for (const u of [0, 1, 4294967295]) {
    const msg = decodeOuter(rt.encodeMessage(Outer$desc, { id: 1, u }));
    assert.equal(msg.u, u);
  }
});

test("bool: any nonzero varint decodes to true", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putVarint(w, 2, 127n);
  });
  assert.equal(decodeOuter(buf).flag, true);
});

// ----- presence ------------------------------------------------------------

test("presence: absent vs explicit default are distinct", () => {
  const absent = decodeOuter(build((w) => putVarint(w, 1, 5n)));
  assert.equal(absent.flag, undefined);
  assert.ok(!("flag" in absent));

  const explicitFalse = decodeOuter(
    build((w) => {
      putVarint(w, 1, 5n);
      putVarint(w, 2, 0n);
    }),
  );
  assert.equal(explicitFalse.flag, false);
  assert.ok("flag" in explicitFalse);

  // explicit default is written back out; absent is not
  const re = rt.encodeMessage(Outer$desc, explicitFalse);
  assert.equal(decodeOuter(re).flag, false);
  assert.equal(
    decodeOuter(rt.encodeMessage(Outer$desc, absent)).flag,
    undefined,
  );
});

test("encode: missing required field fails; optional defaults are skipped", () => {
  assert.throws(
    () => rt.encodeMessage(Outer$desc, { flag: true }),
    /Outer\.id.*required/,
  );
  const buf = rt.encodeMessage(Outer$desc, {
    id: 0,
    flag: false,
    nums: [],
    tags: [],
    plain_nums: [],
    inners: [],
  });
  // id=0 and flag=false are still written: presence, not default-elision.
  assert.deepEqual([...buf], [0x08, 0x00, 0x10, 0x00]);
});

// ----- packed / unpacked repeated scalars ----------------------------------

test("packed=true encodes as one length-delimited record", () => {
  const buf = rt.encodeMessage(Outer$desc, { id: 1, nums: [1, -2, 3] });
  assert.deepEqual([...buf], [0x08, 0x01, 0x1a, 0x03, 0x02, 0x03, 0x06]);
});

test("packed=false encodes one record per element", () => {
  const buf = rt.encodeMessage(Outer$desc, { id: 1, plain_nums: [1, 2, 3] });
  assert.deepEqual([...buf], [0x08, 0x01, 0x40, 0x01, 0x40, 0x02, 0x40, 0x03]);
});

test("empty packed array writes nothing", () => {
  const buf = rt.encodeMessage(Outer$desc, { id: 1, nums: [] });
  assert.deepEqual([...buf], [0x08, 0x01]);
});

test("decode accepts packed, unpacked and mixed forms regardless of the option", () => {
  const zig = (v: number) => BigInt(rt.zigzagEncode32(v));
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putVarint(w, 3, zig(10)); // unpacked
    putVarint(w, 3, zig(-20)); // unpacked
    const p = new rt.Writer(); // packed block
    p.varint(zig(30));
    p.varint(zig(-40));
    const pb = p.finish();
    w.tag(3, 2);
    w.varint(BigInt(pb.length));
    w.bytes(pb);
    putVarint(w, 3, zig(50)); // unpacked again
  });
  assert.deepEqual(decodeOuter(buf).nums, [10, -20, 30, -40, 50]);

  // a field declared unpacked must also accept a packed block on the wire
  const buf2 = build((w) => {
    putVarint(w, 1, 1n);
    const p = new rt.Writer();
    p.varint(7n);
    p.varint(8n);
    const pb = p.finish();
    w.tag(8, 2);
    w.varint(BigInt(pb.length));
    w.bytes(pb);
  });
  assert.deepEqual(decodeOuter(buf2).plain_nums, [7, 8]);
});

// ----- merge semantics ------------------------------------------------------

test("singular nested message appearing twice merges recursively", () => {
  // inner chunk 1: { b: "x" } (no required a!), chunk 2: { a: 5 }
  const inner1 = build((w) => putStr(w, 2, "x"));
  const inner2 = build((w) => putVarint(w, 1, 5n));
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(4, 2);
    w.varint(BigInt(inner1.length));
    w.bytes(inner1);
    w.tag(4, 2);
    w.varint(BigInt(inner2.length));
    w.bytes(inner2);
  });
  const msg = decodeOuter(buf);
  assert.deepEqual(msg.inner, { a: 5, b: "x" });
});

test("merge recurses into nested singular messages", () => {
  // Node.child appears in both chunks; children must merge, not replace.
  const chunk1 = build((w) => {
    putVarint(w, 1, 1n); // v = 1
    const child = build((c) => putVarint(c, 1, 10n)); // child { v: 10 }
    w.tag(2, 2);
    w.varint(BigInt(child.length));
    w.bytes(child);
  });
  const chunk2 = build((w) => {
    const child = build((c) => {
      putVarint(c, 1, 20n); // child { v: 20 }
    });
    w.tag(2, 2);
    w.varint(BigInt(child.length));
    w.bytes(child);
  });
  const buf = build((w) => {
    // Node.node? No: Node itself is the top-level message; make Node appear
    // twice inside a holder by using Node as top-level with duplicated child.
    w.bytes(chunk1);
    w.bytes(chunk2);
  });
  const node = rt.decodeMessage(Node$desc, buf) as {
    v?: number;
    child?: { v?: number };
  };
  assert.equal(node.v, 1);
  assert.equal(node.child?.v, 20);
});

test("singular scalar appearing twice: last one wins", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putVarint(w, 1, 2n);
  });
  assert.equal(decodeOuter(buf).id, 2);
});

test("repeated fields concatenate across occurrences", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putStr(w, 7, "a");
    putStr(w, 7, "b");
    putStr(w, 7, "c");
  });
  assert.deepEqual(decodeOuter(buf).tags, ["a", "b", "c"]);
});

// ----- required validation ---------------------------------------------------

test("missing required field fails only after the whole message is merged", () => {
  // single chunk missing Inner.a -> error mentioning the full path
  const inner = build((w) => putStr(w, 2, "x"));
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(4, 2);
    w.varint(BigInt(inner.length));
    w.bytes(inner);
  });
  assert.throws(
    () => decodeOuter(buf),
    /missing required field Outer\.inner\.a/,
  );
});

test("required fields are validated inside repeated message elements", () => {
  const good = build((w) => putVarint(w, 1, 1n));
  const bad = build((w) => putStr(w, 2, "x"));
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    for (const el of [good, bad]) {
      w.tag(9, 2);
      w.varint(BigInt(el.length));
      w.bytes(el);
    }
  });
  assert.throws(() => decodeOuter(buf), /Outer\.inners\[1\]\.a/);
});

test("missing top-level required field fails", () => {
  assert.throws(() => decodeOuter(new Uint8Array([])), /Outer\.id/);
});

// ----- unknown fields --------------------------------------------------------

test("unknown fields of all supported wire types survive, in order", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putVarint(w, 30, 150n); // wt 0
    w.tag(31, 1);
    w.bytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); // wt 1
    w.tag(32, 2);
    w.varint(2n);
    w.bytes(new Uint8Array([0x68, 0x69])); // wt 2
    w.tag(33, 5);
    w.bytes(new Uint8Array([4, 3, 2, 1])); // wt 5
  });
  const msg = decodeOuter(buf);
  const unk = rt.getUnknownFields(msg);
  assert.deepEqual(
    unk.map((u) => [u.no, u.wireType]),
    [
      [30, 0],
      [31, 1],
      [32, 2],
      [33, 5],
    ],
  );
  // raw bytes include the tag
  assert.deepEqual([...unk[0]!.bytes], [0xf0, 0x01, 0x96, 0x01]);

  // modify a known field, re-encode: unknown bytes are still there, in order
  msg.id = 2;
  const re = rt.encodeMessage(Outer$desc, msg);
  const msg2 = decodeOuter(re);
  assert.equal(msg2.id, 2);
  const unk2 = rt.getUnknownFields(msg2);
  assert.deepEqual(
    unk2.map((u) => [...u.bytes]),
    unk.map((u) => [...u.bytes]),
  );
});

test("unknown fields merge in order when singular messages merge", () => {
  const chunk = (unknownNo: number) =>
    build((w) => {
      putVarint(w, 1, 5n); // Inner.a (required)
      putVarint(w, unknownNo, 1n);
    });
  const c1 = chunk(50);
  const c2 = chunk(51);
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    for (const c of [c1, c2]) {
      w.tag(4, 2);
      w.varint(BigInt(c.length));
      w.bytes(c);
    }
  });
  const msg = decodeOuter(buf);
  assert.deepEqual(
    rt.getUnknownFields(msg.inner!).map((u) => u.no),
    [50, 51],
  );
});

test("a known field number with a foreign wire type is kept as unknown", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(2, 5); // flag is bool (wt 0); send it as wt 5
    w.bytes(new Uint8Array([9, 9, 9, 9]));
  });
  const msg = decodeOuter(buf);
  assert.equal(msg.flag, undefined);
  const unk = rt.getUnknownFields(msg);
  assert.equal(unk.length, 1);
  assert.equal(unk[0]!.no, 2);
  assert.equal(unk[0]!.wireType, 5);
});

test("unknown fields stay out of JSON and enumeration", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    putVarint(w, 30, 150n);
  });
  const msg = decodeOuter(buf);
  assert.deepEqual(Object.keys(msg), [
    "nums",
    "tags",
    "plain_nums",
    "inners",
    "id",
  ]);
  assert.equal(
    JSON.stringify(msg),
    '{"nums":[],"tags":[],"plain_nums":[],"inners":[],"id":1}',
  );
});

// ----- malformed input -------------------------------------------------------

test("wire types 3 and 4 are rejected", () => {
  for (const wt of [3, 4]) {
    const buf = build((w) => {
      putVarint(w, 1, 1n);
      w.tag(30, wt);
    });
    assert.throws(
      () => decodeOuter(buf),
      new RegExp(`unsupported wire type ${wt}`),
    );
  }
});

test("field number 0 is rejected", () => {
  assert.throws(
    () => decodeOuter(new Uint8Array([0x00, 0x01])),
    /illegal field number 0/,
  );
});

test("length prefix beyond the remaining input fails", () => {
  const buf = build((w) => {
    w.tag(5, 2); // data (bytes)
    w.varint(100n);
    w.byte(0x41);
  });
  assert.throws(() => decodeOuter(buf), /declares 100 bytes but only 1 remain/);
});

test("truncated fixed32/fixed64 in unknown fields fail", () => {
  const b32 = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(30, 5);
    w.byte(0xaa);
  });
  assert.throws(() => decodeOuter(b32), /cannot skip 4/);
  const b64 = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(30, 1);
    w.bytes(new Uint8Array([1, 2, 3]));
  });
  assert.throws(() => decodeOuter(b64), /cannot skip 8/);
});

test("invalid UTF-8 in a string field fails", () => {
  const buf = build((w) => {
    putVarint(w, 1, 1n);
    w.tag(7, 2);
    w.varint(1n);
    w.byte(0xff);
  });
  assert.throws(() => decodeOuter(buf), /invalid UTF-8/);
});

test("nesting deeper than 8 fails on decode and encode", () => {
  // hand-built 9-deep Node buffer
  let payload: Uint8Array = build((w) => putVarint(w, 1, 9n));
  for (let i = 8; i >= 1; i--) {
    payload = build((w) => {
      putVarint(w, 1, BigInt(i));
      w.tag(2, 2);
      w.varint(BigInt(payload.length));
      w.bytes(payload);
    });
  }
  assert.throws(() => rt.decodeMessage(Node$desc, payload), /depth 9 exceeds/);

  // 8 deep is fine
  const ok = rt.decodeMessage(Node$desc, payload.slice(0, 0)); // empty -> all absent
  assert.deepEqual(ok, {});
  let deep8: Uint8Array = build((w) => putVarint(w, 1, 8n));
  for (let i = 7; i >= 1; i--) {
    deep8 = build((w) => {
      putVarint(w, 1, BigInt(i));
      w.tag(2, 2);
      w.varint(BigInt(deep8.length));
      w.bytes(deep8);
    });
  }
  assert.doesNotThrow(() => rt.decodeMessage(Node$desc, deep8));

  // encode side
  const make = (depth: number): Record<string, unknown> => {
    let n: Record<string, unknown> = { v: depth };
    for (let i = depth - 1; i >= 1; i--) n = { v: i, child: n };
    return n;
  };
  assert.doesNotThrow(() => rt.encodeMessage(Node$desc, make(8)));
  assert.throws(() => rt.encodeMessage(Node$desc, make(9)), /depth 9 exceeds/);
});

// ----- misc ------------------------------------------------------------------

test("bytes fields copy out of the input buffer", () => {
  const buf = rt.encodeMessage(Outer$desc, {
    id: 1,
    data: new Uint8Array([1, 2, 3]),
  });
  const msg = decodeOuter(buf);
  buf[buf.indexOf(1, 2)] = 99; // mutate the input
  assert.deepEqual([...msg.data!], [1, 2, 3]);
});

test("decode of an empty buffer yields an object with empty repeated fields", () => {
  const msg = rt.decodeMessage(Node$desc, new Uint8Array([])) as Record<
    string,
    unknown
  >;
  assert.deepEqual(msg, {});
  const outer = decodeOuter(rt.encodeMessage(Outer$desc, { id: 1 }));
  assert.deepEqual(outer.nums, []);
  assert.deepEqual(outer.tags, []);
});
