/**
 * Demo consumer of the proto2ts-generated module (demo/addressbook.pb.ts).
 *
 * Walks through the runtime guarantees one section at a time; every section
 * asserts what it prints, so the demo doubles as a smoke test. Run with:
 *
 *   npm run demo
 */

import * as rt from "../src/runtime/runtime.js";
import {
  decodeAddressBook,
  decodeChain,
  decodePerson,
  encodeAddressBook,
  encodeChain,
  encodePerson,
  patchPerson,
} from "./addressbook.pb.js";
import type { AddressBook, Chain, Person } from "./addressbook.pb.js";

let failures = 0;

function check(cond: boolean, label: string): void {
  if (!cond) {
    failures++;
    console.error(`    ✗ ASSERTION FAILED: ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function hex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Key-order-insensitive canonical form for comparing decoded vs. literal objects. */
function canon(v: unknown): unknown {
  if (v instanceof Uint8Array) return [...v];
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
section("1. Round trip: encode -> decode an AddressBook");
{
  const book: AddressBook = {
    people: [
      {
        name: "Alice",
        id: 1,
        email: "alice@example.com",
        address: { street: "1 Main St", city: "Springfield", zip: "01101" },
        deltas: [-3, 0, 7],
        lucky_numbers: [7, 13],
        active: true,
        avatar: new Uint8Array([0, 1, 255]),
        score: 4_000_000_000,
      },
      { name: "Bob", id: -2, deltas: [], lucky_numbers: [] },
    ],
    owner: { name: "Carol", id: 3, deltas: [1], lucky_numbers: [] },
  };
  const buf = encodeAddressBook(book);
  const back = decodeAddressBook(buf);
  console.log(
    `    ${buf.length} bytes; decoded ${back.people.length} people, owner=${back.owner?.name}`,
  );
  check(
    JSON.stringify(canon(back)) === JSON.stringify(canon(book)),
    "round trip preserves the message",
  );
  check(
    back.people[0]!.avatar instanceof Uint8Array,
    "bytes decode to Uint8Array",
  );
}

// ---------------------------------------------------------------------------
section("2. Presence: absent vs. explicit default value");
{
  // Craft a Person buffer where `active` (optional bool) is explicitly false.
  const explicit = new rt.Writer();
  explicit.tag(1, 2);
  const name = new TextEncoder().encode("Dave");
  explicit.varint(BigInt(name.length));
  explicit.bytes(name);
  explicit.tag(2, 0);
  explicit.varint(4n); // id = 4
  explicit.tag(7, 0);
  explicit.varint(0n); // active = false, present on the wire

  const withDefault = decodePerson(explicit.finish());
  const without = decodePerson(
    encodePerson({ name: "Dave", id: 4, deltas: [], lucky_numbers: [] }),
  );
  console.log(
    `    explicit false -> active=${String(withDefault.active)}; absent -> active=${String(without.active)}`,
  );
  check(
    withDefault.active === false,
    "explicit default decodes to false, not undefined",
  );
  check("active" in withDefault, "explicit default is present ('in' operator)");
  check(without.active === undefined, "absent field decodes to undefined");
  check(!("active" in without), "absent field is not present");
  // And re-encoding keeps the distinction: explicit false is written, absent is not.
  check(
    decodePerson(encodePerson(withDefault)).active === false,
    "explicit default survives re-encode",
  );
  check(
    decodePerson(encodePerson(without)).active === undefined,
    "absent stays absent after re-encode",
  );
}

// ---------------------------------------------------------------------------
section("3. Negative int32 -> 10-byte varint; sint32 -> ZigZag");
{
  const buf = encodePerson({
    name: "E",
    id: -1,
    deltas: [],
    lucky_numbers: [],
  });
  // id is field 2, wire type 0: tag 0x10 followed by the varint.
  const tagAt = buf.indexOf(0x10);
  const varintBytes = buf.subarray(tagAt + 1);
  console.log(
    `    id=-1 encoded as ${varintBytes.length} varint bytes: ${hex(varintBytes)}`,
  );
  check(varintBytes.length === 10, "negative int32 uses a 10-byte varint");
  check(decodePerson(buf).id === -1, "decodes back to -1");

  const min = encodePerson({
    name: "E",
    id: -2147483648,
    deltas: [],
    lucky_numbers: [],
  });
  check(decodePerson(min).id === -2147483648, "int32 min round-trips");

  const z = encodePerson({
    name: "E",
    id: 1,
    deltas: [-1, 1, -2147483648, 2147483647],
    lucky_numbers: [],
  });
  check(
    JSON.stringify(decodePerson(z).deltas) ===
      JSON.stringify([-1, 1, -2147483648, 2147483647]),
    "sint32 ZigZag round-trips incl. extremes",
  );
  console.log(
    `    zigzag: -1->${rt.zigzagEncode32(-1)}, 1->${rt.zigzagEncode32(1)}, min->${rt.zigzagEncode32(-2147483648)}`,
  );
}

// ---------------------------------------------------------------------------
section("4. Packed and unpacked repeated scalars, mixed on the wire");
{
  // deltas (field 5, sint32) declared packed=true. Send: 2 unpacked elements,
  // then a packed block of 2, then 1 more unpacked element.
  const w = new rt.Writer();
  w.tag(1, 2);
  const name = new TextEncoder().encode("F");
  w.varint(BigInt(name.length));
  w.bytes(name);
  w.tag(2, 0);
  w.varint(9n);
  const putUnpacked = (v: number) => {
    w.tag(5, 0);
    w.varint(BigInt(rt.zigzagEncode32(v)));
  };
  putUnpacked(10);
  putUnpacked(-20);
  const packedPayload = new rt.Writer();
  for (const v of [30, -40]) packedPayload.varint(BigInt(rt.zigzagEncode32(v)));
  const pp = packedPayload.finish();
  w.tag(5, 2);
  w.varint(BigInt(pp.length));
  w.bytes(pp);
  putUnpacked(50);

  const msg = decodePerson(w.finish());
  console.log(`    decoded deltas: ${JSON.stringify(msg.deltas)}`);
  check(
    JSON.stringify(msg.deltas) === JSON.stringify([10, -20, 30, -40, 50]),
    "mixed packed/unpacked decode in order",
  );

  // Our encoder emits packed form because the field is declared packed=true.
  const re = encodePerson(msg);
  const tagIdx = re.indexOf(0x2a); // field 5, wire type 2
  check(tagIdx !== -1, "re-encode uses the packed (length-delimited) form");
  check(
    re.indexOf(0x28) === -1,
    "re-encode emits no unpacked elements for a packed field",
  );
  check(
    JSON.stringify(decodePerson(re).deltas) === JSON.stringify(msg.deltas),
    "packed re-encode round-trips",
  );
}

// ---------------------------------------------------------------------------
section(
  "5. Duplicated singular nested message merges recursively; required checked after merge",
);
{
  // Person.address (singular) appears twice: first chunk has only `street`,
  // second chunk only `city`. Neither chunk alone satisfies Address's
  // required fields; the merged message does.
  const chunk = (fieldNo: number, value: string): Uint8Array => {
    const w = new rt.Writer();
    w.tag(fieldNo, 2);
    const b = new TextEncoder().encode(value);
    w.varint(BigInt(b.length));
    w.bytes(b);
    return w.finish();
  };
  const w = new rt.Writer();
  w.bytes(chunk(1, "G")); // name
  w.tag(2, 0);
  w.varint(7n); // id
  const c1 = chunk(1, "5 Oak Ave"); // address.street only
  const c2 = chunk(2, "Shelbyville"); // address.city only
  w.tag(4, 2);
  w.varint(BigInt(c1.length));
  w.bytes(c1);
  w.tag(4, 2);
  w.varint(BigInt(c2.length));
  w.bytes(c2);

  const msg = decodePerson(w.finish());
  console.log(`    merged address: ${JSON.stringify(msg.address)}`);
  check(
    msg.address?.street === "5 Oak Ave" && msg.address?.city === "Shelbyville",
    "two chunks merge into one address",
  );

  // Sanity: a genuinely missing required field is still rejected after the merge.
  const bad = new rt.Writer();
  bad.tag(1, 2);
  const n = new TextEncoder().encode("H");
  bad.varint(BigInt(n.length));
  bad.bytes(n); // name only; id missing
  let threw = false;
  try {
    decodePerson(bad.finish());
  } catch (e) {
    threw =
      e instanceof rt.DecodeError && /Person\.id/.test((e as Error).message);
  }
  check(threw, "missing required field fails after full merge");
  console.log(
    "    missing required field is still rejected (after the merge, not before)",
  );
}

// ---------------------------------------------------------------------------
section(
  "6. Unknown fields: raw bytes and order survive decode -> modify -> encode",
);
{
  const base = encodePerson({
    name: "I",
    id: 11,
    deltas: [],
    lucky_numbers: [],
  });
  const unknown = new rt.Writer();
  unknown.tag(30, 0);
  unknown.varint(150n); // varint
  unknown.tag(31, 5);
  unknown.bytes(new Uint8Array([1, 2, 3, 4])); // 32-bit
  unknown.tag(32, 2);
  unknown.varint(2n);
  unknown.bytes(new TextEncoder().encode("hi")); // length-delimited
  unknown.tag(33, 1);
  unknown.bytes(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1])); // 64-bit
  const withUnknown = new Uint8Array([...base, ...unknown.finish()]);

  const decoded = decodePerson(withUnknown);
  const fields = rt.getUnknownFields(decoded);
  console.log(
    `    kept ${fields.length} unknown fields: ${fields.map((f) => `#${f.no}(wt${f.wireType})`).join(", ")}`,
  );
  check(fields.length === 4, "four unknown fields preserved");
  check(
    fields.map((f) => f.no).join(",") === "30,31,32,33",
    "unknown field order preserved",
  );

  // Modify a known field, re-encode: unknown fields must not be lost.
  decoded.email = "i@example.com";
  const reencoded = encodePerson(decoded);
  const decoded2 = decodePerson(reencoded);
  check(decoded2.email === "i@example.com", "known field modification applied");
  const fields2 = rt.getUnknownFields(decoded2);
  check(
    fields2.length === 4 &&
      fields2.every((f, i) => hex(f.bytes) === hex(fields[i]!.bytes)),
    "unknown raw bytes survive a modify/re-encode cycle",
  );
  // Unknown fields do not leak into JSON.
  check(
    !JSON.stringify(decoded).includes("150"),
    "unknown fields stay out of JSON.stringify",
  );
}

// ---------------------------------------------------------------------------
section("7. Malformed input fails explicitly");
{
  const expectDecodeError = (
    label: string,
    buf: Uint8Array,
    pattern: RegExp,
  ) => {
    try {
      decodePerson(buf);
      check(false, `${label}: expected DecodeError`);
    } catch (e) {
      const ok =
        e instanceof rt.DecodeError && pattern.test((e as Error).message);
      check(ok, `${label}: ${(e as Error).message}`);
      console.log(`    ${label}: ${(e as Error).message}`);
    }
  };

  // Truncated varint: field 2 tag, then a varint that never terminates.
  expectDecodeError(
    "truncated varint",
    new Uint8Array([0x0a, 0x01, 0x41, 0x10, 0x80]),
    /truncated varint/,
  );
  // Length out of bounds: name (field 1) claims 100 bytes, buffer has 1.
  expectDecodeError(
    "length out of bounds",
    new Uint8Array([0x0a, 0x64, 0x41]),
    /only \d+ remain/,
  );
  // Unsupported wire type 3 (group start) on an unknown field.
  expectDecodeError(
    "wire type 3 rejected",
    new Uint8Array([0x0a, 0x01, 0x41, 0x10, 0x01, 0xf3, 0x01, 0x00]),
    /unsupported wire type 3/,
  );
  // Truncated fixed32 in an unknown field.
  expectDecodeError(
    "truncated fixed32",
    new Uint8Array([0x0a, 0x01, 0x41, 0x10, 0x01, 0xfd, 0x01, 0xaa]),
    /only \d+ remain/,
  );

  // Depth limit: Chain nests `next`; 8 levels are fine, 9 are not.
  const makeChain = (depth: number): Chain => {
    let c: Chain = { value: depth };
    for (let i = depth - 1; i >= 1; i--) c = { value: i, next: c };
    return c;
  };
  const deep8 = encodeChain(makeChain(8));
  check(
    decodeChain(deep8).next!.next!.next!.next!.next!.next!.next!.value === 8,
    "depth 8 decodes",
  );
  console.log("    depth 8: ok");
  try {
    encodeChain(makeChain(9));
    check(false, "depth 9 encode should fail");
  } catch (e) {
    check(
      e instanceof rt.EncodeError && /depth/.test((e as Error).message),
      "depth 9 encode fails",
    );
    console.log(`    depth 9 encode: ${(e as Error).message}`);
  }
  // A hand-built 9-deep buffer fails to decode as well.
  let payload: Uint8Array = new Uint8Array([0x08, 0x09]); // innermost: value = 9
  for (let i = 8; i >= 1; i--) {
    const w = new rt.Writer();
    w.tag(1, 0);
    w.varint(BigInt(i));
    w.tag(2, 2);
    w.varint(BigInt(payload.length));
    w.bytes(payload);
    payload = w.finish();
  }
  try {
    decodeChain(payload);
    check(false, "depth 9 decode should fail");
  } catch (e) {
    check(
      e instanceof rt.DecodeError && /depth/.test((e as Error).message),
      "depth 9 decode fails",
    );
    console.log(`    depth 9 decode: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
section("8. Masked patch: whitelist replace/clear on wire bytes");
{
  // Base: a complete Person on the wire, plus one unknown field (no. 30).
  const baseBody = encodePerson({
    name: "J",
    id: 5,
    email: "j@example.com",
    address: { street: "7 Elm St", city: "Capital City", zip: "11111" },
    deltas: [],
    lucky_numbers: [1, 2, 3],
    active: true,
  });
  const tail = new rt.Writer();
  tail.tag(30, 0);
  tail.varint(150n);
  const base = new Uint8Array([...baseBody, ...tail.finish()]);

  // Patch: partial Person — explicit active=false, new lucky_numbers, and a
  // new address.zip (no street/city: a patch may omit required fields).
  const pw = new rt.Writer();
  pw.tag(7, 0);
  pw.varint(0n); // active = false, explicit
  pw.tag(6, 0);
  pw.varint(9n); // lucky_numbers = [9]
  const addr = new rt.Writer();
  const zip = new TextEncoder().encode("99999");
  addr.tag(3, 2);
  addr.varint(BigInt(zip.length));
  addr.bytes(zip);
  const addrBytes = addr.finish();
  pw.tag(4, 2);
  pw.varint(BigInt(addrBytes.length));
  pw.bytes(addrBytes);
  const patch = pw.finish();

  const out = patchPerson(base, patch, [
    "active",
    "lucky_numbers",
    "address.zip",
    "email", // selected but absent from the patch -> cleared
  ]);
  const merged = decodePerson(out);
  console.log(
    `    merged: active=${String(merged.active)}, lucky=${JSON.stringify(merged.lucky_numbers)}, zip=${merged.address?.zip}, email=${String(merged.email)}`,
  );
  check(merged.active === false, "explicit false replaces true");
  check("active" in merged, "explicit default keeps presence");
  check(
    JSON.stringify(merged.lucky_numbers) === JSON.stringify([9]),
    "repeated field is replaced, not appended",
  );
  check(merged.address?.zip === "99999", "sub-path updates only address.zip");
  check(
    merged.address?.street === "7 Elm St" && merged.address?.city === "Capital City",
    "unselected siblings of address.zip are kept",
  );
  check(merged.email === undefined, "selected-but-absent singular is cleared");
  check(merged.id === 5 && merged.name === "J", "unselected fields are kept");
  check(
    rt.getUnknownFields(merged).map((u) => u.no).join(",") === "30",
    "unknown wire data of the untouched root is preserved",
  );

  // Invalid selections fail the whole operation.
  for (const [label, paths] of [
    ["overlap", ["address", "address.zip"]],
    ["duplicate", ["email", "email"]],
    ["through repeated", ["deltas.x"]],
    ["unknown field", ["nosuch"]],
  ] as const) {
    let threw = false;
    try {
      patchPerson(base, patch, paths);
    } catch (e) {
      threw = e instanceof rt.PatchError;
    }
    check(threw, `invalid selection rejected: ${label}`);
  }
  // A candidate that loses a required field fails as a whole.
  let requiredFailed = false;
  try {
    patchPerson(base, patch, ["name"]);
  } catch (e) {
    requiredFailed =
      e instanceof rt.DecodeError && /Person\.name/.test((e as Error).message);
  }
  check(requiredFailed, "clearing a required field fails the whole patch");
  console.log("    invalid selections and incomplete candidates are rejected");
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? "\nAll demo assertions passed."
    : `\n${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
