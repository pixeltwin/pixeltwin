import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { getBuild } from '../../src/domain/builds';
import { getProjectBySlug, updateProject } from '../../src/domain/projects';
import { listReviews } from '../../src/domain/reviews';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedProject, submit } from '../helpers/scenario';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('auto-approve new screenshots (project setting)', () => {
  let deps: TestDeps;
  let project: Project;

  beforeEach(async () => {
    deps = await createTestDeps();
    project = await seedProject(deps);
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('is off by default: a new screenshot waits for review', async () => {
    expect(project.autoApproveNew).toBe(false);
    const buildId = await openBuild(deps);
    const { check } = await submit(deps, buildId, white, { name: 'home' });
    expect(check).toMatchObject({ result: 'new', review: 'pending' });
  });

  test('on: a new screenshot is approved at once and becomes the baseline; a change still waits', async () => {
    expect((await updateProject(deps, 'web', { autoApproveNew: true })).autoApproveNew).toBe(true);
    expect((await getProjectBySlug(deps, 'web')).autoApproveNew).toBe(true);

    const first = await openBuild(deps);
    const { check } = await submit(deps, first, white, { name: 'home' });
    expect(check).toMatchObject({ result: 'new', review: 'approved', reviewedBy: 'auto' });
    expect(await listReviews(deps, check.id)).toMatchObject([
      { action: 'approved', actor: 'auto', comment: 'New screenshot approved automatically (project setting).' },
    ]);
    expect((await getBuild(deps, first)).verdict).toBe('passed');

    // The next build compares with it.
    const second = await openBuild(deps);
    expect((await submit(deps, second, white, { name: 'home' })).check.result).toBe('unchanged');
    expect((await submit(deps, second, withSquare, { name: 'home', variant: { x: '1' } })).check.review).toBe(
      'approved',
    );
    const changed = (await submit(deps, second, withSquare, { name: 'home' })).check;
    expect(changed).toMatchObject({ result: 'changed', review: 'pending' });
  });
});
