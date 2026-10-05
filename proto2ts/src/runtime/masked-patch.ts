/**
 * Masked patch: apply a partial patch message to a complete base message,
 * restricted to a whitelist of field paths.
 *
 * Semantics:
 *  - `paths` whitelists 1..32 known field paths. Duplicates, parent/child
 *    overlaps and paths passing through a repeated or scalar field are
 *    rejected (PatchError) before any payload is touched.
 *  - A selected repeated field is REPLACED as a whole, never appended; a
 *    selected singular field absent from the patch is CLEARED; a value
 *    explicitly present in the patch — default values included — keeps its
 *    presence in the result.
 *  - A sub-path (a.b.c) touches only that field; unselected siblings survive.
 *  - The patch may omit required fields; the patched candidate must satisfy
 *    them or the whole operation fails. On any failure nothing is returned
 *    and the caller's buffers are never mutated.
 *  - Unknown fields ride along with the base message's untouched nodes, in
 *    their original order. Replacing or deleting a node replaces or deletes
 *    its unknown subtree with it, and unknown fields found in the patch are
 *    never introduced into the result.
 */

import {
  assertRequiredMessage,
  decodeMessage,
  decodePartialMessage,
  encodeMessage,
} from "./runtime.js";
import type { FieldDesc, MessageDesc } from "./runtime.js";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export const MAX_PATCH_PATHS = 32;

export function applyMaskedPatch(
  desc: MessageDesc,
  base: Uint8Array,
  patch: Uint8Array,
  paths: readonly string[],
): Uint8Array {
  // Validate the mask before touching either payload.
  const mask = resolveMask(desc, paths);
  // The base must be a complete message; the patch may omit required fields.
  const candidate = decodeMessage<Record<string, unknown>>(desc, base);
  const update = decodePartialMessage(desc, patch);
  for (const steps of mask) applyPath(steps, candidate, update);
  // Only a complete candidate may be returned as wire bytes.
  assertRequiredMessage(desc, candidate);
  return encodeMessage(desc, candidate);
}

// ---------------------------------------------------------------------------
// Mask validation
// ---------------------------------------------------------------------------

/** Validate every path and resolve it to a chain of field descriptors. */
function resolveMask(desc: MessageDesc, paths: readonly string[]): FieldDesc[][] {
  if (!Array.isArray(paths)) {
    throw new PatchError(
      `paths must be an array of 1..${MAX_PATCH_PATHS} field paths`,
    );
  }
  if (paths.length < 1 || paths.length > MAX_PATCH_PATHS) {
    throw new PatchError(
      `paths must contain 1..${MAX_PATCH_PATHS} entries, got ${paths.length}`,
    );
  }
  const seen = new Set<string>();
  const mask: FieldDesc[][] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path === "") {
      throw new PatchError(
        `invalid path ${String(path)}: expected a non-empty field path`,
      );
    }
    if (seen.has(path)) throw new PatchError(`duplicate path '${path}'`);
    seen.add(path);
    mask.push(resolvePath(desc, path));
  }
  // A selected ancestor rewrites the very subtree a selected descendant
  // targets: reject parent/child overlaps regardless of their order.
  for (const path of paths) {
    const names = path.split(".");
    let prefix = "";
    for (const name of names.slice(0, -1)) {
      prefix = prefix === "" ? name : `${prefix}.${name}`;
      if (seen.has(prefix)) {
        throw new PatchError(
          `paths '${prefix}' and '${path}' overlap: a field and its own sub-field are both selected`,
        );
      }
    }
  }
  return mask;
}

function resolvePath(desc: MessageDesc, path: string): FieldDesc[] {
  const names = path.split(".");
  const steps: FieldDesc[] = [];
  let d = desc;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const at = names.slice(0, i + 1).join(".");
    const f = d.fields.find((x) => x.name === name);
    if (f === undefined) {
      throw new PatchError(
        `unknown field '${at}' in path '${path}' (message ${d.name})`,
      );
    }
    if (i < names.length - 1) {
      if (f.label === "repeated") {
        throw new PatchError(
          `path '${path}' passes through repeated field '${at}'; select the field itself`,
        );
      }
      if (f.type !== "message") {
        throw new PatchError(
          `path '${path}' passes through scalar field '${at}'; select the field itself`,
        );
      }
      d = f.msg!();
    }
    steps.push(f);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Applying one resolved path
// ---------------------------------------------------------------------------

function applyPath(
  steps: readonly FieldDesc[],
  candidate: Record<string, unknown>,
  update: Record<string, unknown>,
): void {
  const leaf = steps[steps.length - 1]!;
  // The patch node holding the leaf, if the patch reaches that deep.
  let src: Record<string, unknown> | undefined = update;
  for (const f of steps.slice(0, -1)) {
    if (src === undefined) break;
    const next: unknown = src[f.name];
    src = next === undefined ? undefined : (next as Record<string, unknown>);
  }

  if (leaf.label === "repeated") {
    // Wholesale replacement; an absent (hence empty) patch list clears.
    const arr = src === undefined ? [] : ((src[leaf.name] ?? []) as unknown[]);
    const existing = findChain(steps, candidate);
    if (existing !== undefined) {
      existing[leaf.name] = arr.map((el) => cloneValue(leaf, el));
    } else if (arr.length > 0) {
      // Only a non-empty replacement materializes missing intermediate nodes.
      ensureChain(steps, candidate)[leaf.name] = arr.map((el) =>
        cloneValue(leaf, el),
      );
    }
    return;
  }

  if (src !== undefined && leaf.name in src) {
    // Present in the patch — explicit defaults included — so it is set.
    ensureChain(steps, candidate)[leaf.name] = cloneValue(
      leaf,
      src[leaf.name],
    );
  } else {
    // Selected but absent from the patch: clear it, never creating nodes.
    const parent = findChain(steps, candidate);
    if (parent !== undefined) delete parent[leaf.name];
  }
}

/** Walk existing intermediate nodes only; undefined if the chain is broken. */
function findChain(
  steps: readonly FieldDesc[],
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let node = root;
  for (const f of steps.slice(0, -1)) {
    const next = node[f.name];
    if (next === undefined) return undefined;
    node = next as Record<string, unknown>;
  }
  return node;
}

/** Walk intermediate nodes, creating empty ones where the chain is missing. */
function ensureChain(
  steps: readonly FieldDesc[],
  root: Record<string, unknown>,
): Record<string, unknown> {
  let node = root;
  for (const f of steps.slice(0, -1)) {
    let next: Record<string, unknown> | undefined = node[f.name] as
      | Record<string, unknown>
      | undefined;
    if (next === undefined) {
      next = {};
      node[f.name] = next;
    }
    node = next;
  }
  return node;
}

function cloneValue(f: FieldDesc, v: unknown): unknown {
  return f.type === "message"
    ? cloneMessageNode(f.msg!(), v as Record<string, unknown>)
    : v;
}

/**
 * Deep-copy a patch-provided message node, keeping only known fields.
 * Unknown fields found in the patch are deliberately dropped here so they
 * can never leak into the patched result.
 */
function cloneMessageNode(
  desc: MessageDesc,
  node: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of desc.fields) {
    const v = node[f.name];
    if (v === undefined) continue;
    out[f.name] =
      f.label === "repeated"
        ? (v as unknown[]).map((el) => cloneValue(f, el))
        : cloneValue(f, v);
  }
  return out;
}
