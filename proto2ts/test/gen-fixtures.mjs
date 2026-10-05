/**
 * Generates binary test fixtures with the OFFICIAL protoc (from the
 * grpc-tools devDependency). protoc is used here ONLY to produce test
 * fixtures and, in cross.test.ts, to cross-decode our output — it plays no
 * role in the production compile/encode path.
 *
 * Usage: npm run fixtures
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOC = `${ROOT}node_modules/grpc-tools/bin/protoc`;
const OUT = `${ROOT}test/fixtures`;

if (!existsSync(PROTOC)) {
  console.error(
    "protoc not found (expected the grpc-tools devDependency). Run npm install first.",
  );
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const CASES = [
  {
    type: "Person",
    name: "person_full",
    text: `
name: "Alice"
id: -123
email: "alice@example.com"
address { street: "1 Main St" city: "Springfield" zip: "01101" }
deltas: -1
deltas: 0
deltas: 300
lucky_numbers: 7
lucky_numbers: -8
active: false
avatar: "\\000\\001\\377"
score: 4000000000
`,
  },
  {
    type: "Person",
    name: "person_min",
    text: `
name: "Min"
id: 1
`,
  },
  {
    type: "AddressBook",
    name: "addressbook",
    text: `
people { name: "Alice" id: 1 deltas: 5 lucky_numbers: 7 }
people { name: "Bob" id: -2 address { street: "2 Oak Ave" city: "Shelbyville" } }
owner { name: "Carol" id: 3 active: true }
`,
  },
  {
    type: "Chain",
    name: "chain8",
    text: `
value: 1
next { value: 2 next { value: 3 next { value: 4 next { value: 5 next { value: 6 next { value: 7 next { value: 8 } } } } } } }
`,
  },
];

for (const c of CASES) {
  const bin = execFileSync(
    PROTOC,
    [
      `--proto_path=${ROOT}demo`,
      `--encode=demo.${c.type}`,
      "addressbook.proto",
    ],
    { input: c.text, maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(`${OUT}/${c.name}.bin`, bin);
  writeFileSync(`${OUT}/${c.name}.txt`, c.text.trim() + "\n");
  console.log(`fixtures: ${c.name}.bin (${bin.length} bytes)`);
}
console.log("fixtures: done");
