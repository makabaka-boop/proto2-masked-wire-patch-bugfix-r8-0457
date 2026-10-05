/**
 * Masked-patch tests: rt.applyMaskedPatch exercised through the patch*()
 * functions of the generated demo module (real codegen -> shared runtime ->
 * re-decode of the returned wire bytes).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as rt from "../src/runtime/runtime.js";
import {
  decodeAddressBook,
  decodePerson,
  encodeAddressBook,
  encodePerson,
  patchAddressBook,
  patchPerson,
} from "../demo/addressbook.pb.js";

// ----- wire builders (patches may omit required fields, so hand-craft) ------

function wire(fn: (w: rt.Writer) => void): Uint8Array {
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

function putMsg(w: rt.Writer, no: number, payload: Uint8Array): void {
  w.tag(no, 2);
  w.varint(BigInt(payload.length));
  w.bytes(payload);
}

function putPackedSint32(w: rt.Writer, no: number, vs: number[]): void {
  const p = new rt.Writer();
  for (const v of vs) p.varint(BigInt(rt.zigzagEncode32(v)));
  const pb = p.finish();
  w.tag(no, 2);
  w.varint(BigInt(pb.length));
  w.bytes(pb);
}

const EMPTY: Uint8Array = new Uint8Array([]);

function basePerson(): Uint8Array {
  return encodePerson({
    name: "Alice",
    id: -7,
    email: "alice@example.com",
    address: { street: "1 Main St", city: "Springfield", zip: "01101" },
    deltas: [1, -2],
    lucky_numbers: [7, 13],
    active: true,
    avatar: new Uint8Array([0, 1, 255]),
    score: 4_000_000_000,
  });
}

/** Base whose address node and top level both carry unknown fields. */
function basePersonWithUnknowns(): Uint8Array {
  const addr = wire((a) => {
    putStr(a, 1, "1 Main St");
    putStr(a, 2, "Springfield");
    putVarint(a, 31, 7n); // unknown inside Address
  });
  return wire((w) => {
    putStr(w, 1, "A");
    putVarint(w, 2, 1n);
    putMsg(w, 4, addr);
    putVarint(w, 30, 150n); // unknown, wt 0
    w.tag(33, 5);
    w.bytes(new Uint8Array([4, 3, 2, 1])); // unknown, wt 5
  });
}

// ----- replacement / clearing semantics -------------------------------------

test("selected repeated scalar field is replaced, not appended", () => {
  const patch = wire((w) => putVarint(w, 6, 100n)); // lucky_numbers = [100]
  const out = decodePerson(patchPerson(basePerson(), patch, ["lucky_numbers"]));
  assert.deepEqual(out.lucky_numbers, [100]); // not [7, 13, 100]
  assert.deepEqual(out.deltas, [1, -2]); // unselected repeated untouched
});

test("selected packed repeated field is replaced (and stays packed)", () => {
  const patch = wire((w) => putPackedSint32(w, 5, [9, -9]));
  const out = decodePerson(patchPerson(basePerson(), patch, ["deltas"]));
  assert.deepEqual(out.deltas, [9, -9]);
});

test("selected repeated field absent from the patch clears to empty", () => {
  const out = decodePerson(patchPerson(basePerson(), EMPTY, ["deltas"]));
  assert.deepEqual(out.deltas, []);
});

test("selected repeated message field is replaced wholesale", () => {
  const base = encodeAddressBook({
    people: [
      { name: "A", id: 1, deltas: [], lucky_numbers: [] },
      { name: "B", id: 2, deltas: [], lucky_numbers: [] },
    ],
  });
  const patch = wire((w) => {
    const c = wire((p) => {
      putStr(p, 1, "C");
      putVarint(p, 2, 3n);
    });
    putMsg(w, 1, c); // people = [C]
  });
  const out = decodeAddressBook(patchAddressBook(base, patch, ["people"]));
  assert.deepEqual(
    out.people.map((p) => p.name),
    ["C"],
  );
});

test("selected singular field absent from the patch is cleared", () => {
  const out = decodePerson(patchPerson(basePerson(), EMPTY, ["email"]));
  assert.equal(out.email, undefined);
  assert.ok(!("email" in out));
});

test("selected message field absent from the patch is cleared as a whole", () => {
  const out = decodePerson(patchPerson(basePerson(), EMPTY, ["address"]));
  assert.equal(out.address, undefined);
  assert.ok(!("address" in out));
});

test("explicit default values in the patch keep their presence", () => {
  const patch = wire((w) => {
    putVarint(w, 7, 0n); // active = false, explicit
    putVarint(w, 9, 0n); // score = 0, explicit
  });
  const out = decodePerson(patchPerson(basePerson(), patch, ["active", "score"]));
  assert.equal(out.active, false);
  assert.ok("active" in out);
  assert.equal(out.score, 0);
  assert.ok("score" in out);
  // Presence survives a re-encode: explicit defaults are written back out.
  const again = decodePerson(encodePerson(out));
  assert.ok("active" in again && again.active === false);
  assert.ok("score" in again && again.score === 0);
});

test("unselected fields survive untouched", () => {
  const patch = wire((w) => putStr(w, 3, "new@example.com"));
  const out = decodePerson(patchPerson(basePerson(), patch, ["email"]));
  assert.equal(out.email, "new@example.com");
  assert.equal(out.name, "Alice");
  assert.equal(out.id, -7);
  assert.equal(out.active, true);
  assert.equal(out.score, 4_000_000_000);
  assert.deepEqual([...out.avatar!], [0, 1, 255]);
  assert.deepEqual(out.address, {
    street: "1 Main St",
    city: "Springfield",
    zip: "01101",
  });
});

// ----- sub-paths --------------------------------------------------------------

test("a sub-path touches only its field; unselected siblings survive", () => {
  // The patch's address node omits the required street/city: legal in a patch.
  const patch = wire((w) => putMsg(w, 4, wire((a) => putStr(a, 3, "99999"))));
  const out = decodePerson(patchPerson(basePerson(), patch, ["address.zip"]));
  assert.deepEqual(out.address, {
    street: "1 Main St",
    city: "Springfield",
    zip: "99999",
  });
  assert.equal(out.email, "alice@example.com");
});

test("a sub-path absent from the patch clears only that sub-field", () => {
  const out = decodePerson(patchPerson(basePerson(), EMPTY, ["address.zip"]));
  assert.deepEqual(out.address, { street: "1 Main St", city: "Springfield" });
  assert.ok(!("zip" in out.address!));
});

test("whole-node replacement drops the old subtree entirely", () => {
  const patch = wire((w) =>
    putMsg(
      w,
      4,
      wire((a) => {
        putStr(a, 1, "2 Oak Ave");
        putStr(a, 2, "Shelbyville");
      }),
    ),
  );
  const out = decodePerson(patchPerson(basePerson(), patch, ["address"]));
  assert.deepEqual(out.address, { street: "2 Oak Ave", city: "Shelbyville" });
  assert.ok(!("zip" in out.address!)); // old zip did not survive the replacement
});

// ----- unknown-field evidence -------------------------------------------------

test("untouched nodes keep their unknown wire bytes, in order", () => {
  const base = basePersonWithUnknowns();
  const patch = wire((w) => putStr(w, 3, "x@y"));
  const out = decodePerson(patchPerson(base, patch, ["email"]));
  const top = rt.getUnknownFields(out);
  assert.deepEqual(
    top.map((u) => u.no),
    [30, 33],
  );
  assert.deepEqual([...top[0]!.bytes], [0xf0, 0x01, 0x96, 0x01]); // tag included
  assert.deepEqual(
    rt.getUnknownFields(out.address!).map((u) => u.no),
    [31],
  );
});

test("a replaced node takes its unknown subtree with it; patch unknowns never enter", () => {
  const base = basePersonWithUnknowns();
  const patch = wire((w) => {
    const addr = wire((a) => {
      putStr(a, 1, "2 Oak Ave");
      putStr(a, 2, "Shelbyville");
      putVarint(a, 41, 1n); // unknown inside the patch's Address
    });
    putMsg(w, 4, addr);
    putVarint(w, 40, 5n); // unknown at the patch's top level
  });
  const out = decodePerson(patchPerson(base, patch, ["address"]));
  assert.deepEqual(out.address, { street: "2 Oak Ave", city: "Shelbyville" });
  // Replaced node: old unknown #31 is gone, patch's #41 was not introduced.
  assert.deepEqual(rt.getUnknownFields(out.address!), []);
  // Untouched top-level unknowns survive; patch's #40 does not appear.
  assert.deepEqual(
    rt.getUnknownFields(out).map((u) => u.no),
    [30, 33],
  );
});

test("a sub-path patch keeps the node's own unknowns but not the patch's", () => {
  const base = basePersonWithUnknowns();
  const patch = wire((w) =>
    putMsg(
      w,
      4,
      wire((a) => {
        putStr(a, 3, "99999");
        putVarint(a, 41, 1n); // unknown inside the patch's Address
      }),
    ),
  );
  const out = decodePerson(patchPerson(base, patch, ["address.zip"]));
  assert.equal(out.address!.zip, "99999");
  assert.deepEqual(
    rt.getUnknownFields(out.address!).map((u) => u.no),
    [31], // base's evidence kept, patch's #41 dropped
  );
});

test("a known field number with a foreign wire type in the patch is not introduced", () => {
  // email (field 3, wt 2) sent as wt 5: unknown to the patch, so it must be
  // dropped — and the selected field reads as absent, i.e. cleared.
  const patch = wire((w) => {
    w.tag(3, 5);
    w.bytes(new Uint8Array([9, 9, 9, 9]));
  });
  const out = decodePerson(patchPerson(basePerson(), patch, ["email"]));
  assert.equal(out.email, undefined);
  assert.deepEqual(rt.getUnknownFields(out), []);
});

// ----- required-field contract --------------------------------------------------

test("the patch itself may omit required fields", () => {
  const patch = wire((w) => putStr(w, 3, "only-email@x")); // no name, no id
  const out = decodePerson(patchPerson(basePerson(), patch, ["email"]));
  assert.equal(out.email, "only-email@x");
  assert.equal(out.name, "Alice");
});

test("a candidate missing a required field fails the whole operation", () => {
  // Selecting `name` while the patch omits it clears a required field.
  assert.throws(
    () => patchPerson(basePerson(), EMPTY, ["name"]),
    /missing required field Person\.name/,
  );
});

test("an incomplete base message is rejected", () => {
  const noId = wire((w) => putStr(w, 1, "A")); // missing required id
  assert.throws(
    () => patchPerson(noId, EMPTY, ["email"]),
    /missing required field Person\.id/,
  );
});

test("a sub-path that would materialize an incomplete node fails as a whole", () => {
  const baseNoAddr = encodePerson({
    name: "A",
    id: 1,
    deltas: [],
    lucky_numbers: [],
  });
  const patch = wire((w) => putMsg(w, 4, wire((a) => putStr(a, 3, "99999"))));
  assert.throws(
    () => patchPerson(baseNoAddr, patch, ["address.zip"]),
    /missing required field Person\.address\.street/,
  );
});

// ----- mask validation ----------------------------------------------------------

test("illegal, duplicate and overlapping paths fail before anything is applied", () => {
  const base = basePerson();
  const cases: Array<[string, readonly string[]]> = [
    ["unknown field", ["nosuch"]],
    ["unknown nested field", ["address.nosuch"]],
    ["duplicate", ["email", "email"]],
    ["parent then child", ["address", "address.zip"]],
    ["child then parent", ["address.zip", "address"]],
    ["through repeated scalar", ["deltas.x"]],
    ["through scalar", ["name.x"]],
    ["empty segment", ["address..zip"]],
    ["leading dot", [".address"]],
    ["trailing dot", ["address."]],
    ["empty path", [""]],
    ["zero paths", []],
  ];
  for (const [label, paths] of cases) {
    assert.throws(() => patchPerson(base, EMPTY, paths), rt.PatchError, label);
  }
  // through a repeated message field
  assert.throws(
    () => patchAddressBook(encodeAddressBook({ people: [] }), EMPTY, ["people.name"]),
    rt.PatchError,
  );
  // 33 paths exceed the limit even before content is checked
  assert.throws(
    () => patchPerson(base, EMPTY, Array(33).fill("email") as string[]),
    /1\.\.32/,
  );
});

test("mask size boundary: 32 paths accepted, 33 rejected", () => {
  const desc: rt.MessageDesc = {
    name: "Wide",
    fields: Array.from({ length: 40 }, (_, i) => ({
      no: i + 1,
      name: `f${i + 1}`,
      label: "optional" as const,
      type: "int32" as const,
    })),
  };
  const base = rt.encodeMessage(desc, { f1: 1 });
  const names = desc.fields.map((f) => f.name);
  const out = rt.applyMaskedPatch(desc, base, EMPTY, names.slice(0, 32));
  assert.equal(
    (rt.decodeMessage(desc, out) as Record<string, unknown>).f1,
    undefined, // selected + absent in the patch -> cleared
  );
  assert.throws(
    () => rt.applyMaskedPatch(desc, base, EMPTY, names.slice(0, 33)),
    rt.PatchError,
  );
});

// ----- corrupt payloads and atomicity -------------------------------------------

test("corrupt base or patch payload fails the whole operation", () => {
  const corrupt = new Uint8Array([0x0a, 0x64, 0x41]); // name claims 100 bytes
  assert.throws(() => patchPerson(corrupt, EMPTY, ["email"]), rt.DecodeError);
  const truncVarint = new Uint8Array([0x10, 0x80]); // id varint never terminates
  assert.throws(
    () => patchPerson(basePerson(), truncVarint, ["email"]),
    rt.DecodeError,
  );
});

test("caller buffers are never mutated, on success or failure", () => {
  const base = basePerson();
  const patch = wire((w) => putStr(w, 3, "x@y"));
  const baseBefore = [...base];
  const patchBefore = [...patch];

  patchPerson(base, patch, ["email"]); // success
  assert.deepEqual([...base], baseBefore);
  assert.deepEqual([...patch], patchBefore);

  for (const run of [
    () => patchPerson(base, patch, ["address", "address.zip"]), // bad mask
    () => patchPerson(base, EMPTY, ["name"]), // incomplete candidate
    () => patchPerson(base, new Uint8Array([0x10, 0x80]), ["email"]), // corrupt
  ]) {
    assert.throws(run);
    assert.deepEqual([...base], baseBefore);
    assert.deepEqual([...patch], patchBefore);
  }
});

test("the returned wire bytes re-decode to a complete message", () => {
  const patch = wire((w) => {
    putStr(w, 3, "new@x");
    putPackedSint32(w, 5, [4, 5]);
  });
  const out = patchPerson(basePerson(), patch, ["email", "deltas"]);
  const again = decodePerson(out); // must satisfy required validation
  assert.equal(again.email, "new@x");
  assert.deepEqual(again.deltas, [4, 5]);
  assert.equal(again.name, "Alice");
});
