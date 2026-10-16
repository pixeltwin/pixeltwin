import type { Project } from '../db/schema';
import { regionsFor } from './checks';
import type { Deps } from './deps';
import { loadImage } from './images';

/** How a branch screen differs from main's: what the promote page shows per screen. */
export interface PromotionDiff {
  percent: number;
  /** Changed regions (at least this many when the engine truncated the list). */
  changes: number;
  /** The diff image (changes in red); null when nothing differs. */
  diffPng: Uint8Array | null;
}

/** Recent comparisons by images, areas and threshold: the page and its diff images share them. */
const cache = new Map<string, PromotionDiff>();
const CACHE_MAX = 200;

/**
 * Compares main's current image of a screen with the branch's, with the screen's ignore and compare
 * areas and the project's threshold, as a review would. Null when an image is missing or the
 * comparison failed.
 */
export async function promotionDiff(
  deps: Deps,
  project: Project,
  snapshotKey: string,
  mainSha: string,
  branchSha: string,
): Promise<PromotionDiff | null> {
  const regions = await regionsFor(deps.db, project.id, snapshotKey, []);
  const key = `${mainSha}:${branchSha}:${project.colorThreshold}:${JSON.stringify(regions)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const [main, branch] = await Promise.all([loadImage(deps, mainSha), loadImage(deps, branchSha)]);
  if (!main || !branch) return null;
  const result = await deps.runDiff({
    current: branch,
    baseline: main,
    ignoreRegions: regions.ignore,
    compareRegions: regions.compare,
    colorThreshold: project.colorThreshold,
    tolerancePercent: 0,
    maxPixels: deps.limits.maxImagePixels,
  });
  if (result.kind !== 'compared') return null;
  const diff: PromotionDiff = {
    percent: result.diff.percent,
    changes: result.diff.regions.length,
    diffPng: result.diffPng,
  };
  cache.set(key, diff);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return diff;
}
