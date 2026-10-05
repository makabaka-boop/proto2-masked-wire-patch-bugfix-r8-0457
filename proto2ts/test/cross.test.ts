/**
 * Cross-decoding tests against the official protoc (grpc-tools devDependency):
 *
 *  1. protoc-encoded fixtures must decode to the expected objects with OUR
 *     runtime (protoc -> us).
 *  2. OUR encodings, decoded by protoc, must print the same text as protoc's
 *     own encodings of the same messages (us -> protoc).
 *  3. Unknown fields we preserve must be visible to protoc --decode.
 *
 * protoc is a test-only tool here; the production path never invokes it.
 * Tests skip gracefully when protoc or the fixtures are unavailable
 * (run `npm run fixtures` to generate them).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as rt from "../src/runtime/runtime.js";
import {
  decodeAddressBook,
  decodeChain,
  decodePerson,
  encodeAddressBook,
  encodeChain,
  encodePerson,
  patchPerson,
} from "../demo/addressbook.pb.js";
import type { AddressBook, Chain, Person } from "../demo/addressbook.pb.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOC = `${ROOT}node_modules/grpc-tools/bin/protoc`;
const FIXTURES = `${ROOT}test/fixtures`;

const available =
  existsSync(PROTOC) && existsSync(`${FIXTURES}/person_full.bin`);
const skip = available
  ? false
  : "protoc or fixtures unavailable; run npm install && npm run fixtures";

function protocDecode(type: string, bin: Uint8Array): string {
  return execFileSync(
    PROTOC,
    [`--proto_path=${ROOT}demo`, `--decode=demo.${type}`, "addressbook.proto"],
    {
      input: bin,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}/${name}.bin`));
}

// ----- 1. protoc -> us -------------------------------------------------------

test(
  "cross: protoc-encoded Person (all fields) decodes with our runtime",
  { skip },
  () => {
    const msg = decodePerson(fixture("person_full"));
    assert.deepEqual(msg, {
      name: "Alice",
      id: -123,
      email: "alice@example.com",
      address: { street: "1 Main St", city: "Springfield", zip: "01101" },
      deltas: [-1, 0, 300],
      lucky_numbers: [7, -8],
      active: false,
      avatar: new Uint8Array([0, 1, 255]),
      score: 4000000000,
    });
  },
);

test(
  "cross: protoc-encoded minimal Person decodes with our runtime",
  { skip },
  () => {
    const msg = decodePerson(fixture("person_min"));
    assert.deepEqual(msg, {
      name: "Min",
      id: 1,
      deltas: [],
      lucky_numbers: [],
    });
  },
);

test(
  "cross: protoc-encoded AddressBook decodes with our runtime",
  { skip },
  () => {
    const msg = decodeAddressBook(fixture("addressbook"));
    assert.deepEqual(msg, {
      people: [
        { name: "Alice", id: 1, deltas: [5], lucky_numbers: [7] },
        {
          name: "Bob",
          id: -2,
          deltas: [],
          lucky_numbers: [],
          address: { street: "2 Oak Ave", city: "Shelbyville" },
        },
      ],
      owner: {
        name: "Carol",
        id: 3,
        deltas: [],
        lucky_numbers: [],
        active: true,
      },
    });
  },
);

test(
  "cross: protoc-encoded 8-deep Chain decodes with our runtime",
  { skip },
  () => {
    const msg = decodeChain(fixture("chain8"));
    let depth = 0;
    for (let c: Chain | undefined = msg; c !== undefined; c = c.next) {
      depth++;
      assert.equal(c.value, depth);
    }
    assert.equal(depth, 8);
  },
);

// ----- 2. us -> protoc --------------------------------------------------------

test("cross: our encodings decode identically under protoc", { skip }, () => {
  const personFull: Person = {
    name: "Alice",
    id: -123,
    email: "alice@example.com",
    address: { street: "1 Main St", city: "Springfield", zip: "01101" },
    deltas: [-1, 0, 300],
    lucky_numbers: [7, -8],
    active: false,
    avatar: new Uint8Array([0, 1, 255]),
    score: 4000000000,
  };
  const personMin: Person = {
    name: "Min",
    id: 1,
    deltas: [],
    lucky_numbers: [],
  };
  const book: AddressBook = {
    people: [
      { name: "Alice", id: 1, deltas: [5], lucky_numbers: [7] },
      {
        name: "Bob",
        id: -2,
        deltas: [],
        lucky_numbers: [],
        address: { street: "2 Oak Ave", city: "Shelbyville" },
      },
    ],
    owner: {
      name: "Carol",
      id: 3,
      deltas: [],
      lucky_numbers: [],
      active: true,
    },
  };
  const makeChain = (depth: number): Chain => {
    let c: Chain = { value: depth };
    for (let i = depth - 1; i >= 1; i--) c = { value: i, next: c };
    return c;
  };

  const cases: Array<[string, string, Uint8Array]> = [
    ["Person", "person_full", encodePerson(personFull)],
    ["Person", "person_min", encodePerson(personMin)],
    ["AddressBook", "addressbook", encodeAddressBook(book)],
    ["Chain", "chain8", encodeChain(makeChain(8))],
  ];
  for (const [type, fixtureName, ours] of cases) {
    const fromOurs = protocDecode(type, ours);
    const fromFixture = protocDecode(type, fixture(fixtureName));
    assert.equal(
      fromOurs,
      fromFixture,
      `protoc --decode differs for ${fixtureName}`,
    );
  }
});

// ----- 2b. masked patch -> protoc ----------------------------------------------

test(
  "cross: a masked-patch result decodes under protoc with the expected content",
  { skip },
  () => {
    const base = encodePerson({
      name: "Alice",
      id: 1,
      email: "alice@example.com",
      address: { street: "1 Main St", city: "Springfield", zip: "01101" },
      deltas: [1, -2],
      lucky_numbers: [7, 13],
      active: true,
      score: 5,
    });
    // Partial patch (no required name/id): replace lucky_numbers, set an
    // explicit active=false, move only address.zip, and clear email.
    const w = new rt.Writer();
    w.tag(6, 0);
    w.varint(9n); // lucky_numbers = [9]
    w.tag(7, 0);
    w.varint(0n); // active = false, explicit
    const zip = new TextEncoder().encode("99999");
    const addr = new rt.Writer();
    addr.tag(3, 2);
    addr.varint(BigInt(zip.length));
    addr.bytes(zip);
    const ab = addr.finish();
    w.tag(4, 2);
    w.varint(BigInt(ab.length));
    w.bytes(ab); // address = { zip: "99999" }
    const out = patchPerson(base, w.finish(), [
      "lucky_numbers",
      "active",
      "address.zip",
      "email",
    ]);

    const text = protocDecode("Person", out);
    assert.match(text, /name: "Alice"/);
    assert.match(text, /lucky_numbers: 9/);
    assert.doesNotMatch(text, /lucky_numbers: 7/); // replaced, not appended
    assert.match(text, /active: false/); // explicit default present on the wire
    assert.doesNotMatch(text, /email/); // selected + absent -> cleared
    assert.match(text, /zip: "99999"/);
    assert.match(text, /street: "1 Main St"/); // unselected sibling kept
    assert.match(text, /score: 5/); // unselected field kept
  },
);

// ----- 3. unknown fields visible to protoc ------------------------------------
test(
  "cross: unknown fields we preserve are visible to protoc --decode",
  { skip },
  () => {
    const base = encodePerson({
      name: "X",
      id: 1,
      deltas: [],
      lucky_numbers: [],
    });
    const extra = new rt.Writer();
    extra.tag(30, 0);
    extra.varint(150n);
    extra.tag(31, 2);
    extra.varint(1n);
    extra.bytes(new Uint8Array([0x00])); // not parseable as a message, prints as "\000"
    const withUnknown = new Uint8Array([...base, ...extra.finish()]);

    // decode with us, modify a known field, re-encode: unknowns must survive
    const msg = decodePerson(withUnknown);
    msg.score = 9;
    const reencoded = encodePerson(msg);

    const text = protocDecode("Person", reencoded);
    assert.match(text, /score: 9/);
    assert.match(text, /30: 150/);
    assert.match(text, /31: "\\000"/);
  },
);
