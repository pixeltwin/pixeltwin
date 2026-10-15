import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject, deleteProject, getProjectBySlug, listProjects, updateProject } from '../../src/domain/projects';
import { newId } from '../../src/ids';
import { createTestDeps, type TestDeps } from '../helpers/deps';
import { appError } from '../helpers/errors';

describe('projects', () => {
  let deps: TestDeps;

  beforeEach(async () => {
    deps = await createTestDeps();
  });

  afterEach(async () => {
    await deps.handle.close();
  });

  test('creates a project with defaults', async () => {
    const project = await createProject(deps, { slug: 'web', name: 'Web app' });
    expect(project).toMatchObject({
      slug: 'web',
      name: 'Web app',
      mainBranch: 'main',
      colorThreshold: 0.1,
      tolerancePercent: 0,
      retentionDays: 90,
    });
    expect(project.id).toStartWith('prj_');
    expect(await getProjectBySlug(deps, 'web')).toEqual(project);
  });

  test('rejects a duplicate slug with 409', async () => {
    await createProject(deps, { slug: 'web', name: 'Web' });
    const err = await appError(createProject(deps, { slug: 'web', name: 'Other' }));
    expect(err.code).toBe('project_slug_taken');
    expect(err.status).toBe(409);
  });

  test('rejects invalid slugs and unknown fields with 422', async () => {
    const bad = await appError(createProject(deps, { slug: 'Web App', name: 'x' }));
    expect(bad.code).toBe('validation_failed');
    expect(bad.errors?.[0]?.path).toBe('slug');
    const typo = await appError(createProject(deps, { slug: 'web', name: 'x', mainBrnach: 'dev' }));
    expect(typo.code).toBe('validation_failed');
  });

  test('updates settings', async () => {
    await createProject(deps, { slug: 'web', name: 'Web' });
    const updated = await updateProject(deps, 'web', { mainBranch: 'trunk', tolerancePercent: 0.5 });
    expect(updated).toMatchObject({ mainBranch: 'trunk', tolerancePercent: 0.5 });
    expect(await getProjectBySlug(deps, 'web')).toEqual(updated);
  });

  test('lists projects by slug', async () => {
    await createProject(deps, { slug: 'zeta', name: 'Z' });
    await createProject(deps, { slug: 'alpha', name: 'A' });
    expect((await listProjects(deps)).map((p) => p.slug)).toEqual(['alpha', 'zeta']);
  });

  test('deleting a project removes its builds', async () => {
    const project = await createProject(deps, { slug: 'web', name: 'Web' });
    await deps.db
      .insertInto('builds')
      .values({
        id: newId('bld'),
        projectId: project.id,
        branch: 'main',
        baseBranch: 'main',
        externalId: null,
        commitSha: null,
        state: 'open',
        createdAt: Date.now(),
        finalizedAt: null,
      })
      .execute();
    await deleteProject(deps, 'web');
    expect(await deps.db.selectFrom('builds').selectAll().execute()).toEqual([]);
    expect((await appError(getProjectBySlug(deps, 'web'))).code).toBe('project_not_found');
  });
});
