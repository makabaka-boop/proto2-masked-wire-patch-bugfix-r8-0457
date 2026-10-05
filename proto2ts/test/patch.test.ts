/**
 * Masked-patch tests: field-whitelist patching of wire bytes through the
 * GENERATED demo module (patchPerson / patchAddressBook) and the shared
 * runtime. Every successful patch is verified by re-decoding its result.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as rt from "../src/runtime/runtime.js";
import {
  Chain$desc,
  decodeAddressBook,
  decodePerson,
  encodeAddressBook,
  encodePerson,
  patchAddressBook,
  patchPerson,
} from "../demo/addressbook.pb.js";
import type { AddressBook, Person } from "../demo/addressbook.pb.js";

// ----- wire-building helpers -------------------------------------------------
// Person:  name=1 id=2 email=3 address=4 deltas=5(packed) lucky_numbers=6
//          active=7 avatar=8 score=9
// Address: street=1 city=2 zip=3

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

function build(fn: (w: rt.Writer) => void): Uint8Array {
  const w = new rt.Writer();
  fn(w);
  return w.finish();
}

function addressWire(zip?: string): Uint8Array {
  return build((w) => {
    putStr(w, 1, "2 Oak Ave");
    putStr(w, 2, "Shelbyville");
    if (zip !== undefined) putStr(w, 3, zip);
  });
}

function fullPerson(): Person {
  return {
    name: "Alice",
    id: -7,
    email: "alice@example.com",
    address: { street: "1 Main St", city: "Springfield", zip: "01101" },
    deltas: [-1, 0, 1],
    lucky_numbers: [7, 13],
    active: true,
    avatar: new Uint8Array([9, 9]),
    score: 42,
  };
}

function hex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

// ----- replace / clear semantics ----------------------------------------------

test("patch: selected repeated fields are replaced, not appended", () => {
  const base = encodePerson(fullPerson()); // lucky [7,13], deltas [-1,0,1]
  const patch = build((w) => {
    putVarint(w, 6, 1n);
    putVarint(w, 6, 2n); // lucky_numbers <- [1,2]
    const packed = build((p) => p.varint(BigInt(rt.zigzagEncode32(5))));
    putMsg(w, 5, packed); // deltas <- [5]
  });
  const out = decodePerson(patchPerson(base, patch, ["lucky_numbers", "deltas"]));
  assert.deepEqual(out.lucky_numbers, [1, 2]);
  assert.deepEqual(out.deltas, [5]);
  // unselected fields are untouched
  assert.equal(out.name, "Alice");
  assert.equal(out.id, -7);
});

test("patch: selected repeated field absent from the patch is cleared", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => putStr(w, 3, "new@example.com")); // no lucky_numbers
  const out = decodePerson(patchPerson(base, patch, ["lucky_numbers", "email"]));
  assert.deepEqual(out.lucky_numbers, []);
  assert.equal(out.email, "new@example.com");
  assert.deepEqual(out.deltas, [-1, 0, 1]); // not selected: kept
});

test("patch: selected singular field absent from the patch is cleared", () => {
  const base = encodePerson(fullPerson()); // email and avatar set
  const out = decodePerson(patchPerson(base, new Uint8Array([]), ["email", "avatar"]));
  assert.equal(out.email, undefined);
  assert.ok(!("email" in out), "cleared field loses presence");
  assert.equal(out.avatar, undefined);
  assert.ok(!("avatar" in out));
  assert.equal(out.score, 42); // not selected: kept
});

test("patch: explicit default values keep their presence", () => {
  const base = encodePerson(fullPerson()); // active: true, score: 42
  const patch = build((w) => {
    putVarint(w, 7, 0n); // active = false, explicitly on the wire
    putVarint(w, 9, 0n); // score = 0, explicitly on the wire
  });
  const out = decodePerson(patchPerson(base, patch, ["active", "score"]));
  assert.equal(out.active, false);
  assert.ok("active" in out, "explicit false is present");
  assert.equal(out.score, 0);
  assert.ok("score" in out, "explicit 0 is present");
  // presence survives a further re-encode/decode cycle
  const again = decodePerson(encodePerson(out));
  assert.equal(again.active, false);
  assert.ok("active" in again);
});

test("patch: a sub-path changes only that subfield; siblings are kept", () => {
  const base = encodePerson(fullPerson());
  // The patch carries only address.zip — it may lack Address's required fields.
  const patch = build((w) => {
    putMsg(w, 4, build((a) => putStr(a, 3, "99999")));
  });
  const out = decodePerson(patchPerson(base, patch, ["address.zip"]));
  assert.deepEqual(out.address, {
    street: "1 Main St",
    city: "Springfield",
    zip: "99999",
  });
});

test("patch: a sub-path clear removes only that subfield", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => putMsg(w, 4, new Uint8Array([]))); // address {} present, zip absent
  const out = decodePerson(patchPerson(base, patch, ["address.zip"]));
  assert.deepEqual(out.address, { street: "1 Main St", city: "Springfield" });
  assert.ok(!("zip" in out.address!));
});

test("patch: sibling sub-paths under the same parent both apply", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => {
    putMsg(
      w,
      4,
      build((a) => {
        putStr(a, 1, "10 Downing St");
        putStr(a, 3, "SW1A");
      }),
    );
  });
  const out = decodePerson(
    patchPerson(base, patch, ["address.street", "address.zip"]),
  );
  assert.deepEqual(out.address, {
    street: "10 Downing St",
    city: "Springfield", // unselected sibling kept
    zip: "SW1A",
  });
});

test("patch: whole-node replacement swaps the entire subtree", () => {
  // Base address carries an unknown field (no. 40) inside its subtree.
  const base = build((w) => {
    putStr(w, 1, "Alice");
    putVarint(w, 2, 7n);
    putMsg(
      w,
      4,
      build((a) => {
        putStr(a, 1, "1 Main St");
        putStr(a, 2, "Springfield");
        putStr(a, 3, "01101");
        putVarint(a, 40, 1n); // unknown, inside address
      }),
    );
    putVarint(w, 30, 150n); // unknown, at the root
  });
  const patch = build((w) => putMsg(w, 4, addressWire())); // no zip
  const out = decodePerson(patchPerson(base, patch, ["address"]));
  assert.deepEqual(out.address, { street: "2 Oak Ave", city: "Shelbyville" });
  assert.ok(!("zip" in out.address!), "old subtree (zip) is gone with the node");
  assert.deepEqual(
    rt.getUnknownFields(out.address!).map((u) => u.no),
    [],
    "unknown fields of the replaced subtree are gone",
  );
  assert.deepEqual(
    rt.getUnknownFields(out).map((u) => u.no),
    [30],
    "unknown fields outside the replaced node stay",
  );
});

test("patch: whole-node clear removes the subtree with its unknown fields", () => {
  const base = build((w) => {
    putStr(w, 1, "Alice");
    putVarint(w, 2, 7n);
    putMsg(
      w,
      4,
      build((a) => {
        putStr(a, 1, "1 Main St");
        putStr(a, 2, "Springfield");
        putVarint(a, 40, 1n);
      }),
    );
  });
  const out = decodePerson(patchPerson(base, new Uint8Array([]), ["address"]));
  assert.equal(out.address, undefined);
  assert.deepEqual(rt.getUnknownFields(out).map((u) => u.no), []);
});

test("patch: unknown fields of untouched nodes keep their bytes and order", () => {
  const base = build((w) => {
    putStr(w, 1, "Alice");
    putVarint(w, 2, 7n);
    putMsg(
      w,
      4,
      build((a) => {
        putStr(a, 1, "1 Main St");
        putStr(a, 2, "Springfield");
        putVarint(a, 40, 5n); // unknown inside the (unselected) address
      }),
    );
    putVarint(w, 30, 150n); // root unknowns, in wire order
    w.tag(31, 5);
    w.bytes(new Uint8Array([1, 2, 3, 4]));
  });
  const before = decodePerson(base);
  const rootBefore = rt.getUnknownFields(before).map((u) => hex(u.bytes));
  const addrBefore = rt.getUnknownFields(before.address!).map((u) => hex(u.bytes));

  const patch = build((w) => putStr(w, 3, "patched@example.com"));
  const out = decodePerson(patchPerson(base, patch, ["email"]));
  assert.equal(out.email, "patched@example.com");
  assert.deepEqual(
    rt.getUnknownFields(out).map((u) => hex(u.bytes)),
    rootBefore,
    "root unknown wire bytes preserved, in order",
  );
  assert.deepEqual(
    rt.getUnknownFields(out.address!).map((u) => hex(u.bytes)),
    addrBefore,
    "unknown wire bytes of the unselected child preserved",
  );
});

test("patch: unknown fields carried by the patch are never introduced", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => {
    putStr(w, 3, "new@example.com");
    putVarint(w, 60, 1n); // unknown at the patch root
    putMsg(
      w,
      4,
      build((a) => {
        putStr(a, 1, "2 Oak Ave");
        putStr(a, 2, "Shelbyville");
        putVarint(a, 61, 2n); // unknown inside the patch's address
      }),
    );
  });
  const out = decodePerson(patchPerson(base, patch, ["email", "address"]));
  assert.equal(out.email, "new@example.com");
  assert.deepEqual(out.address, { street: "2 Oak Ave", city: "Shelbyville" });
  assert.deepEqual(rt.getUnknownFields(out), [], "no patch unknowns at the root");
  assert.deepEqual(
    rt.getUnknownFields(out.address!),
    [],
    "no patch unknowns inside the replaced node",
  );
});

// ----- required-field contract -------------------------------------------------

test("patch: the patch may omit required fields if the candidate stays complete", () => {
  const base = encodePerson(fullPerson());
  // Patch carries only an email — no name/id — which is fine for a patch.
  const patch = build((w) => putStr(w, 3, "only@example.com"));
  const out = decodePerson(patchPerson(base, patch, ["email"]));
  assert.equal(out.email, "only@example.com");
  assert.equal(out.name, "Alice");
  assert.equal(out.id, -7);
});

test("patch: clearing a required field fails the whole operation", () => {
  const base = encodePerson(fullPerson());
  assert.throws(
    () => patchPerson(base, new Uint8Array([]), ["name"]),
    /missing required field Person\.name/,
  );
});

test("patch: a replacement node must satisfy its own required fields", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) =>
    putMsg(w, 4, build((a) => putStr(a, 1, "2 Oak Ave"))), // city missing
  );
  assert.throws(
    () => patchPerson(base, patch, ["address"]),
    /missing required field Person\.address\.city/,
  );
});

test("patch: setting a sub-path under an absent node still requires completeness", () => {
  const base = encodePerson({
    name: "NoAddr",
    id: 1,
    deltas: [],
    lucky_numbers: [],
  });
  const patch = build((w) => putMsg(w, 4, build((a) => putStr(a, 3, "99999"))));
  assert.throws(
    () => patchPerson(base, patch, ["address.zip"]),
    /missing required field Person\.address\.street/,
  );
});

test("patch: clearing a sub-path under an absent node is a no-op", () => {
  const base = encodePerson({
    name: "NoAddr",
    id: 1,
    deltas: [],
    lucky_numbers: [],
  });
  const out = decodePerson(patchPerson(base, new Uint8Array([]), ["address.zip"]));
  assert.equal(out.address, undefined, "no empty node is materialized");
});

// ----- path list validation -----------------------------------------------------

test("patch: invalid paths fail the whole operation", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => putStr(w, 3, "x@example.com"));
  const bad: Array<[string, readonly string[], RegExp]> = [
    ["unknown field", ["nosuch"], /no field "nosuch"/],
    ["unknown nested field", ["address.nosuch"], /Address has no field "nosuch"/],
    ["through a scalar", ["email.x"], /cannot pass through scalar field Person\.email/],
    ["through a required scalar", ["id.x"], /cannot pass through scalar field Person\.id/],
    ["through a repeated scalar", ["deltas.x"], /cannot pass through repeated field Person\.deltas/],
    ["duplicate", ["email", "email"], /duplicate patch path "email"/],
    ["parent/child overlap", ["address", "address.zip"], /overlapping patch paths/],
    ["child/parent overlap", ["address.zip", "address"], /overlapping patch paths/],
    ["empty path", [""], /non-empty strings/],
    ["empty segment", ["address..zip"], /empty segment/],
    ["leading dot", [".address"], /empty segment/],
    ["trailing dot", ["address."], /empty segment/],
    ["zero paths", [], /between 1 and 32/],
    [
      "too many paths",
      Array.from({ length: 33 }, (_, i) => `p${i}`),
      /between 1 and 32/,
    ],
  ];
  for (const [label, paths, pattern] of bad) {
    assert.throws(() => patchPerson(base, patch, paths), pattern, label);
    assert.throws(() => patchPerson(base, patch, paths), rt.PatchError, label);
  }
});

test("patch: paths cannot pass through a repeated message field", () => {
  const book: AddressBook = {
    people: [{ name: "A", id: 1, deltas: [], lucky_numbers: [] }],
  };
  const base = encodeAddressBook(book);
  assert.throws(
    () => patchAddressBook(base, new Uint8Array([]), ["people.name"]),
    /cannot pass through repeated field AddressBook\.people/,
  );
});

test("patch: exactly 32 paths are accepted", () => {
  // Chain: value=1 (required), next=2 (optional Chain). 32 distinct paths.
  const chainPaths = ["value"];
  while (chainPaths.length < 32) {
    chainPaths.push(`${"next.".repeat(chainPaths.length)}value`);
  }
  assert.equal(chainPaths.length, 32);
  const base = build((w) => putVarint(w, 1, 1n)); // { value: 1 }
  // The patch supplies the root "value"; the deeper selected leaves are
  // absent from both patch and base, so clearing them is a no-op.
  const patch = build((w) => putVarint(w, 1, 2n));
  const out = rt.applyMaskedPatch(Chain$desc, base, patch, chainPaths);
  assert.deepEqual(rt.decodeMessage(Chain$desc, out), { value: 2 });
});

// ----- payload corruption and input immutability ---------------------------------

test("patch: corrupt payloads fail the whole operation", () => {
  const base = encodePerson(fullPerson());
  // patch: email claims 100 bytes, buffer has 1
  const corruptPatch = new Uint8Array([0x1a, 0x64, 0x41]);
  assert.throws(
    () => patchPerson(base, corruptPatch, ["email"]),
    /only 1 remain/,
  );
  // corrupt base: truncated varint in id
  const corruptBase = new Uint8Array([0x0a, 0x01, 0x41, 0x10, 0x80]);
  assert.throws(
    () => patchPerson(corruptBase, new Uint8Array([]), ["email"]),
    /truncated varint/,
  );
  // incomplete base (missing required id) is rejected before patching
  const incompleteBase = build((w) => putStr(w, 1, "Alice"));
  assert.throws(
    () => patchPerson(incompleteBase, new Uint8Array([]), ["email"]),
    /missing required field Person\.id/,
  );
});

test("patch: caller buffers are never modified, on success or failure", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => {
    putStr(w, 3, "new@example.com");
    putVarint(w, 7, 0n);
  });
  const baseCopy = base.slice();
  const patchCopy = patch.slice();

  patchPerson(base, patch, ["email", "active"]);
  assert.deepEqual([...base], [...baseCopy], "base untouched by success");
  assert.deepEqual([...patch], [...patchCopy], "patch untouched by success");

  assert.throws(() => patchPerson(base, patch, ["email", "email"]));
  assert.deepEqual([...base], [...baseCopy], "base untouched by failure");
  assert.deepEqual([...patch], [...patchCopy], "patch untouched by failure");

  const corrupt = new Uint8Array([0x1a, 0x64, 0x41]);
  const corruptCopy = corrupt.slice();
  assert.throws(() => patchPerson(base, corrupt, ["email"]));
  assert.deepEqual([...corrupt], [...corruptCopy], "corrupt patch untouched");
});

// ----- repeated message fields and multi-path application -------------------------

test("patch: a repeated message field is replaced as a whole", () => {
  const book: AddressBook = {
    people: [
      { name: "Alice", id: 1, deltas: [], lucky_numbers: [] },
      { name: "Bob", id: 2, deltas: [], lucky_numbers: [] },
    ],
    owner: { name: "Carol", id: 3, deltas: [], lucky_numbers: [] },
  };
  const base = encodeAddressBook(book);
  const patch = build((w) => {
    putMsg(
      w,
      1,
      build((p) => {
        putStr(p, 1, "Dave");
        putVarint(p, 2, 4n);
        putVarint(p, 50, 1n); // unknown field riding on the patch element
      }),
    );
  });
  const out = decodeAddressBook(patchAddressBook(base, patch, ["people"]));
  assert.equal(out.people.length, 1);
  assert.equal(out.people[0]!.name, "Dave");
  assert.deepEqual(
    rt.getUnknownFields(out.people[0]!),
    [],
    "patch element unknowns are stripped",
  );
  assert.equal(out.owner!.name, "Carol", "unselected sibling field kept");
});

test("patch: several independent paths apply in one call", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => {
    putStr(w, 3, "multi@example.com");
    putVarint(w, 7, 0n); // active = false
    putVarint(w, 6, 99n); // lucky_numbers = [99]
    putMsg(w, 4, build((a) => putStr(a, 3, "00000")));
  });
  const out = decodePerson(
    patchPerson(base, patch, ["email", "active", "lucky_numbers", "address.zip"]),
  );
  assert.equal(out.email, "multi@example.com");
  assert.equal(out.active, false);
  assert.deepEqual(out.lucky_numbers, [99]);
  assert.equal(out.address!.zip, "00000");
  assert.equal(out.address!.street, "1 Main St"); // sibling kept
  assert.equal(out.id, -7); // unselected kept
  assert.deepEqual(out.deltas, [-1, 0, 1]);
});

test("patch: result re-encodes to the same bytes (stability check)", () => {
  const base = encodePerson(fullPerson());
  const patch = build((w) => putStr(w, 3, "stable@example.com"));
  const out = patchPerson(base, patch, ["email"]);
  assert.deepEqual(
    [...encodePerson(decodePerson(out))],
    [...out],
    "re-encoding the decoded candidate reproduces the patch result",
  );
});

// ----- official protoc as an independent decoder -------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOC = `${ROOT}node_modules/grpc-tools/bin/protoc`;
const protocAvailable = existsSync(PROTOC);

test(
  "patch: protoc --decode sees the patched fields and the preserved unknowns",
  { skip: protocAvailable ? false : "protoc unavailable" },
  () => {
    const base = build((w) => {
      putStr(w, 1, "Alice");
      putVarint(w, 2, 7n);
      putVarint(w, 6, 1n);
      putVarint(w, 6, 2n);
      putVarint(w, 30, 150n); // unknown, must survive the patch
    });
    const patch = build((w) => {
      putStr(w, 3, "protoc@example.com");
      putVarint(w, 6, 9n); // lucky_numbers <- [9]
      putVarint(w, 60, 1n); // unknown in the patch: must NOT appear
    });
    const out = patchPerson(base, patch, ["email", "lucky_numbers"]);
    const text = execFileSync(
      PROTOC,
      [
        `--proto_path=${ROOT}demo`,
        "--decode=demo.Person",
        "addressbook.proto",
      ],
      { input: out, encoding: "utf8" },
    );
    assert.match(text, /email: "protoc@example\.com"/);
    assert.match(text, /lucky_numbers: 9/);
    assert.doesNotMatch(text, /lucky_numbers: [12]\b/, "no appended leftovers");
    assert.match(text, /30: 150/, "base unknown field preserved");
    assert.doesNotMatch(text, /60: 1/, "patch unknown field not introduced");
  },
);
