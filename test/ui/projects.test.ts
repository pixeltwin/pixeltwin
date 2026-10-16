import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '../../src/db/schema';
import { createProjectToken } from '../../src/domain/auth/tokens';
import { finalizeBuild } from '../../src/domain/builds';
import { createProject, listProjects } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';
import { openBuild, seedBaseline, submit } from '../helpers/scenario';
import { html, location, postForm } from '../helpers/ui';

const white = makePng(100, 100);
const withSquare = makePng(100, 100, WHITE, [{ x: 10, y: 10, width: 10, height: 10, color: BLACK }]);

describe('UI projects', () => {
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

  /** web: main #1 finalized and passed, feature/cart #2 still open with one changed check pending. */
  async function seedWeb(): Promise<{ project: Project; mainBuild: string; cartBuild: string; pendingCheck: string }> {
    const project = await createProject(t.deps, { slug: 'web', name: 'Web shop' });
    await seedBaseline(t.deps, project, white, { name: 'home' });
    const mainBuild = await openBuild(t.deps, 'web', { branch: 'main', commitSha: 'abcdef1234567890' });
    await submit(t.deps, mainBuild, white, { name: 'home' });
    await finalizeBuild(t.deps, mainBuild);
    const cartBuild = await openBuild(t.deps, 'web', { branch: 'feature/cart', externalId: 'ci-77' });
    const pending = (await submit(t.deps, cartBuild, withSquare, { name: 'home' })).check;
    return { project, mainBuild, cartBuild, pendingCheck: pending.id };
  }

  describe('projects page', () => {
    test('shows a card per project with its main branch verdict and what waits for review', async () => {
      await seedWeb();
      await createProject(t.deps, { slug: 'docs', name: 'Docs site' });
      const page = await html(await t.request('GET', '/ui', { as: viewer }));
      expect(page).toContain('href="/ui/p/web"');
      expect(page).toContain('Web shop');
      // main passed; the waiting check is on feature/cart.
      expect(page).toContain('tone-green">passed</span>');
      expect(page).not.toContain('needs review');
      expect(page).toContain('1 to review');
      expect(page).toContain('Docs site');
      expect(page).toContain('No builds yet');
    });

    test('with no projects, admins are invited to create one and others to ask an admin', async () => {
      expect(await html(await t.request('GET', '/ui', { as: admin }))).toContain('Create your first project');
      expect(await html(await t.request('GET', '/ui', { as: viewer }))).toContain('Ask an admin');
    });

    test('admins get a New project dialog that also works as a page without JavaScript', async () => {
      const page = await html(await t.request('GET', '/ui', { as: admin }));
      expect(page).toContain('href="/ui/projects/new" data-dialog-open="new-project"');
      expect(page).toMatch(/<dialog id="new-project"[^>]*>[\s\S]*action="\/ui\/projects"/);
      const form = await html(await t.request('GET', '/ui/projects/new', { as: admin }));
      expect(form).toContain('action="/ui/projects"');
      expect(await html(await t.request('GET', '/ui', { as: viewer }))).not.toContain('New project');
      expect((await t.request('GET', '/ui/projects/new', { as: viewer })).status).toBe(403);
    });

    test('an admin creates a project; mistakes are shown next to the field', async () => {
      const res = await postForm(t, '/ui/projects', { name: 'Web shop', slug: 'web' }, admin);
      expect(location(res)).toBe('/ui/p/web?done=project-created');
      // The slug is optional: left empty it comes from the name.
      const named = await postForm(t, '/ui/projects', { name: 'Docs site', slug: '' }, admin);
      expect(location(named)).toBe('/ui/p/docs-site?done=project-created');
      const form = await html(await t.request('GET', '/ui/projects/new', { as: admin }));
      // Only the name is asked; a custom slug hides under a closed "Custom slug".
      expect(form).toContain('<details class="advanced"><summary>Custom slug</summary>');
      expect(form).toContain('<label for="project-slug">Slug</label>');
      // A bad slug opens it, so the error is seen.
      const bad = await html(await postForm(t, '/ui/projects', { name: 'Bad', slug: 'Bad Slug' }, admin));
      expect(bad).toContain('<details class="advanced" open="">');
      expect(form).not.toMatch(/name="slug"[^>]*required/);
      const invalid = await postForm(t, '/ui/projects', { name: 'Bad', slug: 'Bad Slug' }, admin);
      expect(invalid.status).toBe(422);
      const page = await html(invalid);
      expect(page).toContain('value="Bad Slug"');
      expect(page).toContain('aria-invalid="true"');
      expect(page).toContain('class="field-error"');
      expect((await listProjects(t.deps)).map((p) => p.slug).sort()).toEqual(['docs-site', 'web']);
      expect((await postForm(t, '/ui/projects', { name: 'Web', slug: 'web2' }, viewer)).status).toBe(403);
    });

    test('the welcome notice still shows after setup', async () => {
      expect(await html(await t.request('GET', '/ui?done=welcome', { as: admin }))).toContain(
        'Your admin account is ready',
      );
    });
  });

  describe('branches page', () => {
    test('lists branches, main first, with build numbers, verdicts and history', async () => {
      const { mainBuild, cartBuild } = await seedWeb();
      const page = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
      expect(page.indexOf('>main<')).toBeGreaterThan(0);
      expect(page.indexOf('>main<')).toBeLessThan(page.indexOf('>feature/cart<'));
      expect(page).toContain(`href="/ui/builds/${mainBuild}"`);
      expect(page).toContain(`href="/ui/builds/${cartBuild}"`);
      expect(page).toContain('#2');
      expect(page).toContain('title="#1 passed"');
      expect(page).toContain('vs main');
      expect(page).toContain('aria-current="page">Branches</a>');
      expect(page).toContain('href="/ui/p/web/builds"');
    });

    test('a Review button jumps to the first check waiting for review', async () => {
      const { pendingCheck } = await seedWeb();
      const page = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
      expect(page).toContain(`href="/ui/checks/${pendingCheck}?filter=pending"`);
      expect(page).toContain('Review 1');
    });

    test('open builds keep the page live; the Review button is a palette action too', async () => {
      const { cartBuild } = await seedWeb();
      const live = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
      expect(live).toContain('data-islands="live"');
      expect(live).toContain('data-live="lanes" data-live-open=""');
      expect(live).toContain('data-palette-review');
      await finalizeBuild(t.deps, cartBuild);
      const settled = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
      expect(settled).not.toContain('data-live-open');
      expect(settled).not.toContain('data-islands="live"');
    });

    test('a lane whose latest build waits for review links straight to it', async () => {
      const { pendingCheck } = await seedWeb();
      const page = await html(await t.request('GET', '/ui/p/web', { as: viewer }));
      const lane = page.slice(page.indexOf('>feature/cart<'));
      expect(lane.slice(0, lane.indexOf('</article>'))).toContain(
        `class="button small" href="/ui/checks/${pendingCheck}?filter=pending">Review</a>`,
      );
      const main = page.slice(page.indexOf('>main<'));
      expect(main.slice(0, main.indexOf('</article>'))).not.toContain('>Review</a>');
    });

    test('settings are a tab for admins only', async () => {
      await seedWeb();
      expect(await html(await t.request('GET', '/ui/p/web', { as: admin }))).toContain('href="/ui/p/web/settings"');
      expect(await html(await t.request('GET', '/ui/p/web', { as: viewer }))).not.toContain(
        'href="/ui/p/web/settings"',
      );
    });

    test('old build-list links move to the All builds tab', async () => {
      await seedWeb();
      const res = await t.request('GET', '/ui/p/web?branch=main', { as: viewer });
      expect(res.status).toBe(302);
      expect(location(res)).toBe('/ui/p/web/builds?branch=main');
    });
  });

  describe('onboarding', () => {
    test('a project without builds shows the three steps with snippets for this server', async () => {
      await createProject(t.deps, { slug: 'web', name: 'Web shop' });
      const page = await html(await t.request('GET', '/ui/p/web', { as: admin }));
      expect(page).toContain('Send your first screenshots');
      expect(page).toContain('http://pixeltwin.test/api/v1/projects/web/builds');
      expect(page).toContain('http://pixeltwin.test/llms.txt');
      for (const tab of ['Playwright', 'curl', 'AI agent']) expect(page).toContain(`>${tab}</label>`);
      expect(page).toContain('data-copy-from="snippet-curl"');
      expect(page).toContain('href="/ui/p/web/settings/tokens/new"');
      expect(page).not.toContain('class="step done"');
      // The page turns into the branch list by itself when the first build arrives.
      expect(page).toContain('data-live="onboarding" data-live-open="" data-live-reload=""');
      expect(page).toContain('data-islands="tokens live"');
    });

    test('the token step is done once the project has a token; viewers are told to ask an admin', async () => {
      await createProject(t.deps, { slug: 'web', name: 'Web shop' });
      expect(await html(await t.request('GET', '/ui/p/web', { as: viewer }))).toContain('Ask an admin for a token');
      await createProjectToken(t.deps, 'web', { name: 'ci', scopes: ['read', 'write'] });
      expect(await html(await t.request('GET', '/ui/p/web', { as: viewer }))).toContain('class="step done"');
    });
  });

  describe('all builds page', () => {
    test('a table of builds with number, branch, commit, CI run id and verdict', async () => {
      const { mainBuild, cartBuild } = await seedWeb();
      const page = await html(await t.request('GET', '/ui/p/web/builds', { as: viewer }));
      expect(page).toContain(`href="/ui/builds/${cartBuild}"`);
      expect(page).toContain(`href="/ui/builds/${mainBuild}"`);
      expect(page).toContain('abcdef1');
      expect(page).toContain('ci-77');
      expect(page).toContain('needs review');
      // feature/cart's build is still open: it is running, and its pending check shows too.
      expect(page).toContain('tone-blue">running</span>');
      expect(page).toContain('aria-current="page">All builds</a>');
      expect(page).toContain('data-live="builds" data-live-open=""');
    });

    test('filters by branch from a list of the project branches', async () => {
      await seedWeb();
      const page = await html(await t.request('GET', '/ui/p/web/builds?branch=main', { as: viewer }));
      expect(page).toContain('<option value="main" selected="">main</option>');
      expect(page).toContain('<option value="feature/cart">feature/cart</option>');
      expect(page).not.toContain('ci-77');
    });
  });
});
