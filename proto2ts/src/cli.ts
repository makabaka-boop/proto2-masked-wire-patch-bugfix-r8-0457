#!/usr/bin/env node
/**
 * proto2ts CLI: compile a .proto file into a TypeScript encode/decode module.
 *
 *   proto2ts <input.proto> [-o output.ts] [--runtime module-specifier]
 *
 * Defaults: output is <input> with .proto replaced by .pb.ts; the runtime
 * import specifier defaults to "../src/runtime/runtime.js" (suits files
 * generated one directory below this package root, e.g. demo/).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compileProto, CompileError } from "./compiler/index.js";

function usage(): never {
  console.error(
    "usage: proto2ts <input.proto> [-o output.ts] [--runtime module-specifier]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let input: string | undefined;
let output: string | undefined;
let runtime = "../src/runtime/runtime.js";

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "-o") {
    output = args[++i];
  } else if (a === "--runtime") {
    runtime = args[++i];
  } else if (a.startsWith("-")) {
    usage();
  } else if (input === undefined) {
    input = a;
  } else {
    usage();
  }
}
if (input === undefined) usage();
if (output === undefined) output = input.replace(/\.proto$/, "") + ".pb.ts";
if (runtime === undefined) usage();

const source = readFileSync(input, "utf8");
try {
  const ts = compileProto(source, {
    sourceName: basename(input),
    runtimeImport: runtime,
  });
  writeFileSync(output, ts);
  console.error(`proto2ts: wrote ${output}`);
} catch (e) {
  if (e instanceof CompileError) {
    for (const line of e.message.split("\n")) {
      console.error(`${input}:${line}`);
    }
    process.exit(1);
  }
  throw e;
}
