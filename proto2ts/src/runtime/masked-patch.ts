import {
  decodeMessage,
  decodePartialMessage,
  encodeMessage,
} from "./runtime.js";
import type { MessageDesc } from "./runtime.js";
export function applyMaskedPatch(
  desc: MessageDesc,
  base: Uint8Array,
  patch: Uint8Array,
  paths: readonly string[],
): Uint8Array {
  const value = decodeMessage<Record<string, unknown>>(desc, base);
  const update = decodePartialMessage(desc, patch);
  for (const path of paths) {
    const names = path.split(".");
    let target = value,
      source = update;
    for (const name of names.slice(0, -1)) {
      target[name] ??= {};
      source[name] ??= {};
      target = target[name] as Record<string, unknown>;
      source = source[name] as Record<string, unknown>;
    }
    const field = names[names.length - 1]!;
    if (Array.isArray(source[field]))
      target[field] = [
        ...((target[field] ?? []) as unknown[]),
        ...(source[field] as unknown[]),
      ];
    else if (source[field] !== undefined) target[field] = source[field];
  }
  return encodeMessage(desc, value);
}
