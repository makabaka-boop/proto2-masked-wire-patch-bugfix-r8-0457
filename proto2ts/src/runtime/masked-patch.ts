/**
 * Masked (field-whitelist) patching for the proto2ts shared runtime.
 *
 * `applyMaskedPatch(desc, base, patch, paths)` applies an incomplete patch
 * message to a complete base message, touching only the whitelisted field
 * paths:
 *
 *  - `paths` holds 1..32 dot-separated field paths. Every segment must name
 *    a known field; intermediate segments must be singular message fields
 *    (a path may not pass through a repeated or scalar field). Duplicate
 *    paths and parent/child overlapping paths are rejected.
 *  - A selected repeated field is REPLACED as a whole by the patch's
 *    elements (never appended); a patch that carries no elements for it
 *    clears it.
 *  - A selected singular field present in the patch is replaced — explicit
 *    default values (0, false, "") keep their presence — and is CLEARED
 *    when the patch leaves it absent.
 *  - A sub-path (e.g. `address.zip`) touches only that leaf; unselected
 *    sibling fields and the unknown fields of every node that is not
 *    wholesale-replaced or deleted keep their original wire bytes and order.
 *    A replaced or deleted message node takes its whole subtree (unknown
 *    fields included) with it.
 *  - The patch may omit required fields, but the merged candidate must
 *    satisfy every required field or the whole operation fails.
 *  - Unknown fields contained in the patch are never introduced into the
 *    result.
 *  - Any failure (bad path, corrupt payload, incomplete candidate) aborts
 *    the operation; the caller's input buffers are never modified.
 */

import {
  assertRequiredMessage,
  decodeMessage,
  decodePartialMessage,
  encodeMessage,
} from "./runtime.js";
import type { FieldDesc, MessageDesc } from "./runtime.js";

/** Thrown for any invalid patch request (bad path list). */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/** A patch selects between 1 and this many field paths. */
export const MAX_PATCH_PATHS = 32;

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Resolve one dot-separated path to its chain of field descriptors. */
function resolvePath(
  desc: MessageDesc,
  path: unknown,
): { segments: string[]; steps: FieldDesc[] } {
  if (typeof path !== "string" || path.length === 0) {
    throw new PatchError("patch paths must be non-empty strings");
  }
  const segments = path.split(".");
  const steps: FieldDesc[] = [];
  let current = desc;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]!;
    if (name.length === 0) {
      throw new PatchError(`invalid patch path "${path}": empty segment`);
    }
    const field = current.fields.find((f) => f.name === name);
    if (field === undefined) {
      throw new PatchError(
        `invalid patch path "${path}": ${current.name} has no field "${name}"`,
      );
    }
    if (i < segments.length - 1) {
      if (field.label === "repeated") {
        throw new PatchError(
          `invalid patch path "${path}": cannot pass through repeated field ${current.name}.${name}`,
        );
      }
      if (field.type !== "message") {
        throw new PatchError(
          `invalid patch path "${path}": cannot pass through scalar field ${current.name}.${name}`,
        );
      }
      current = field.msg!();
    }
    steps.push(field);
  }
  return { segments, steps };
}

/** True when `a` and `b` are equal or one is a strict prefix of the other. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Validate the whole path list and resolve every path. */
function resolvePaths(
  desc: MessageDesc,
  paths: readonly string[],
): FieldDesc[][] {
  if (paths.length < 1 || paths.length > MAX_PATCH_PATHS) {
    throw new PatchError(
      `expected between 1 and ${MAX_PATCH_PATHS} patch paths, got ${paths.length}`,
    );
  }
  const seen: string[][] = [];
  const resolved: FieldDesc[][] = [];
  for (const path of paths) {
    const { segments, steps } = resolvePath(desc, path);
    for (const prev of seen) {
      if (prev.length === segments.length && overlaps(prev, segments)) {
        throw new PatchError(`duplicate patch path "${path}"`);
      }
      if (overlaps(prev, segments)) {
        throw new PatchError(
          `overlapping patch paths "${prev.join(".")}" and "${path}": select the parent or the children, not both`,
        );
      }
    }
    seen.push(segments);
    resolved.push(steps);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Value handling
// ---------------------------------------------------------------------------

/**
 * Deep-copy a patch-provided value, keeping only known fields. Unknown
 * fields carried by the patch's decoded nodes are dropped, so they can
 * never leak into the patched result. Presence is preserved: a field that
 * is present with an explicit default value is copied like any other.
 */
function sanitizeValue(field: FieldDesc, value: unknown): unknown {
  if (field.type !== "message") return value; // scalars carry no unknowns
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of field.msg!().fields) {
    const v = src[f.name];
    if (v === undefined) continue;
    out[f.name] =
      f.label === "repeated"
        ? (v as unknown[]).map((el) => sanitizeValue(f, el))
        : sanitizeValue(f, v);
  }
  return out;
}

/**
 * Walk `root` along the intermediate steps of a path. With `create`, missing
 * singular message nodes are materialized (needed to plant a new value);
 * without it a missing node yields `undefined` (nothing to clear).
 */
function findParent(
  root: Record<string, unknown>,
  steps: readonly FieldDesc[],
  create: boolean,
): Record<string, unknown> | undefined {
  let node = root;
  for (const f of steps.slice(0, -1)) {
    let next = node[f.name];
    if (next === undefined || next === null) {
      if (!create) return undefined;
      next = {};
      node[f.name] = next;
    }
    node = next as Record<string, unknown>;
  }
  return node;
}

/** Apply one resolved path: replace or clear the selected leaf. */
function applyPath(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  steps: readonly FieldDesc[],
): void {
  const leaf = steps[steps.length - 1]!;
  // Resolve the patch-side parent first: it decides replace vs. clear.
  const srcParent = findParent(source, steps, false);
  const present =
    srcParent !== undefined && srcParent[leaf.name] !== undefined;

  if (leaf.label === "repeated") {
    // Wholesale replacement by the patch's elements; absent means empty.
    const elements = present
      ? (srcParent![leaf.name] as unknown[]).map((el) =>
          sanitizeValue(leaf, el),
        )
      : [];
    // Create missing nodes only when there is something to plant; a clear of
    // an already-absent chain is a no-op.
    const parent = findParent(target, steps, elements.length > 0);
    if (parent !== undefined) parent[leaf.name] = elements;
  } else if (present) {
    const parent = findParent(target, steps, true)!;
    parent[leaf.name] = sanitizeValue(leaf, srcParent![leaf.name]);
  } else {
    const parent = findParent(target, steps, false);
    if (parent !== undefined) delete parent[leaf.name];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply `patch` (wire bytes of a possibly-incomplete `desc` message) to
 * `base` (wire bytes of a complete one) along the whitelisted `paths`, and
 * return the re-encoded candidate message.
 *
 * Throws PatchError for an invalid path list, DecodeError for corrupt input
 * or an incomplete base/candidate, and EncodeError if the candidate cannot
 * be serialized. The caller's buffers are never modified.
 */
export function applyMaskedPatch(
  desc: MessageDesc,
  base: Uint8Array,
  patch: Uint8Array,
  paths: readonly string[],
): Uint8Array {
  const resolved = resolvePaths(desc, paths);
  // The base must be a complete message; the patch may be partial.
  const value = decodeMessage<Record<string, unknown>>(desc, base);
  const update = decodePartialMessage(desc, patch);
  for (const steps of resolved) applyPath(value, update, steps);
  // Only a candidate that satisfies every required field may be encoded.
  assertRequiredMessage(desc, value);
  return encodeMessage(desc, value);
}
