import type { Project } from '../../src/db/schema';
import { appendBaseline } from '../../src/domain/baselines';
import { createBuild } from '../../src/domain/builds';
import { submitCheck } from '../../src/domain/checks';
import { readPngHeader, storeImage } from '../../src/domain/images';
import { createProject } from '../../src/domain/projects';
import { snapshotKey } from '../../src/domain/snapshot-key';
import type { TestDeps } from './deps';

export async function seedProject(deps: TestDeps, slug = 'web'): Promise<Project> {
  return createProject(deps, { slug, name: slug, mainBranch: 'main' });
}

export async function openBuild(deps: TestDeps, slug = 'web', input: Record<string, unknown> = {}): Promise<string> {
  return (await createBuild(deps, slug, input)).build.id;
}

/** Stores `png` and makes it the current baseline for (name, variant) on `branch`. */
export async function seedBaseline(
  deps: TestDeps,
  project: Project,
  png: Uint8Array,
  options: { name?: string; variant?: Record<string, string>; branch?: string } = {},
) {
  const name = options.name ?? 'home';
  const variant = options.variant ?? {};
  const imageSha = await storeImage(deps, png, readPngHeader(png, deps.limits));
  return appendBaseline(deps.db, {
    projectId: project.id,
    snapshotKey: snapshotKey(name, variant),
    name,
    variant: JSON.stringify(variant),
    branch: options.branch ?? project.mainBranch,
    imageSha,
    sourceCheckId: null,
    approvedBy: 'usr_seed',
  });
}

export function submit(deps: TestDeps, buildId: string, png: Uint8Array, meta: Record<string, unknown> = {}) {
  return submitCheck(deps, buildId, { image: png, meta: { name: 'home', ...meta } });
}
