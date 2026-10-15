import { createHash } from 'node:crypto';

/** Variant entries sorted by key (code-unit order, not locale order, so it is stable everywhere). */
export function canonicalVariant(variant: Record<string, string>): Array<[string, string]> {
  return Object.entries(variant).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Identity of a snapshot: hex sha256 of `[name, sortedVariantEntries]`. */
export function snapshotKey(name: string, variant: Record<string, string>): string {
  return createHash('sha256')
    .update(JSON.stringify([name, canonicalVariant(variant)]))
    .digest('hex');
}
