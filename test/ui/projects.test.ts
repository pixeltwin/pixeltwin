import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject, listProjects } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI projects and builds', () => {
  let t: TestApp;
  let admin: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };

  beforeEach(async () => {
    t = await createTestApp();
    admin = await t.userAs('admin');
    viewer = await t.userAs('viewer');
  });

  afterEach(async () => {
    await t.close();
  });

  test('projects and builds list what exists', async () => {
    const project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    await seedBaseline(t.deps, project, white, { name: 'home' });
    const buildId = await openBuild(t.deps, 'web', { branch: 'feature/cart', externalId: 'ci-77' });
    await submit(t.deps, buildId, withSquare, { name: 'home' });
    const projects = await html(await t.request('GET', '/ui', { as: viewer }));
    expect(projects).toContain('href="/ui/p/web"');
    expect(projects).toContain('Web shop');
    expect(projects).not.toContain('New project');

    const builds = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
    expect(builds).toContain(`href="/ui/builds/${buildId}"`);
    expect(builds).toContain('ci-77');
    expect(builds).toContain('feature/cart');
    expect(builds).toContain('badge pending');
    expect(await html(await t.request('GET', '/ui/p/web?branch=main', { as: viewer }))).not.toContain('ci-77');
  });

  test('an admin creates a project from the projects page', async () => {
    const res = await postForm(t, '/ui/projects', { name: 'Web shop', slug: 'web' }, admin);
    expect(location(res)).toBe('/ui/p/web?done=project-created');
    const invalid = await postForm(t, '/ui/projects', { name: 'Bad', slug: 'Bad Slug' }, admin);
    expect(invalid.status).toBe(422);
    const page = await html(invalid);
    expect(page).toContain('slug:');
    expect(page).toContain('value="Bad Slug"');
    expect((await listProjects(t.deps)).map((p) => p.slug)).toEqual(['web']);
  });

  test('the projects page offers creation only to admins', async () => {
    expect(await html(await t.request('GET', '/ui', { as: admin }))).toContain('New project');
    expect(await html(await t.request('GET', '/ui?done=welcome', { as: admin }))).toContain(
      'Your admin account is ready',
    );
    expect(await html(await t.request('GET', '/ui', { as: viewer }))).not.toContain('New project');
    expect((await postForm(t, '/ui/projects', { name: 'Web', slug: 'web' }, viewer)).status).toBe(403);
  });
});
