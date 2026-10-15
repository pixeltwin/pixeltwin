import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { type BuildView, listBuilds } from '../../domain/builds';
import { createProject, getProjectBySlug, listProjects } from '../../domain/projects';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import { Badge, Pager, When } from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';

function ProjectsPage(props: {
  ui: Ui;
  projects: Project[];
  notice?: string;
  error?: string;
  form?: { slug?: string; name?: string };
}) {
  const { ui, projects } = props;
  const isAdmin = ui.user?.role === 'admin';
  return (
    <Layout ui={ui} title="Projects" notice={props.notice} error={props.error}>
      <h1>Projects</h1>
      <p class="sub">Each project has its own builds, baselines and tokens.</p>
      {projects.length === 0 ? (
        <p class="panel">No projects yet.{isAdmin ? ' Create one below.' : ' Ask an admin to create one.'}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Slug</th>
              <th>Main branch</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr>
                <td>
                  <a href={ui.url(`/ui/p/${p.slug}`)}>{p.name}</a>
                </td>
                <td class="muted">{p.slug}</td>
                <td>{p.mainBranch}</td>
                <td>
                  <When at={p.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isAdmin && (
        <>
          <h2>New project</h2>
          <form class="panel row" method="post" action={ui.url('/ui/projects')}>
            <div>
              <label for="name">Name</label>
              <input id="name" name="name" type="text" required value={props.form?.name ?? ''} />
            </div>
            <div>
              <label for="slug">Slug (lowercase letters, digits, hyphens)</label>
              <input
                id="slug"
                name="slug"
                type="text"
                required
                pattern="[a-z0-9][a-z0-9-]{1,62}"
                value={props.form?.slug ?? ''}
              />
            </div>
            <button class="primary" type="submit">
              Create
            </button>
          </form>
        </>
      )}
    </Layout>
  );
}

function BuildsPage(props: {
  ui: Ui;
  project: Project;
  builds: BuildView[];
  branch?: string | undefined;
  newer?: string | undefined;
  older?: string | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, builds } = props;
  return (
    <Layout ui={ui} title={project.name} notice={props.notice}>
      <h1>{project.name}</h1>
      <p class="sub">
        Main branch <strong>{project.mainBranch}</strong>
        {ui.user?.role === 'admin' && (
          <>
            {' · '}
            <a href={ui.url(`/ui/p/${project.slug}/settings`)}>Settings and tokens</a>
          </>
        )}
      </p>
      <form class="row" method="get" action={ui.url(`/ui/p/${project.slug}`)}>
        <div>
          <label for="branch">Branch</label>
          <input id="branch" name="branch" type="text" placeholder="all branches" value={props.branch ?? ''} />
        </div>
        <button type="submit">Filter</button>
      </form>
      <h2>Builds</h2>
      {builds.length === 0 ? (
        <p class="panel">
          No builds yet. Send screenshots with a project token; see {<a href={ui.url('/llms.txt')}>/llms.txt</a>}.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Build</th>
              <th>Branch</th>
              <th>Verdict</th>
              <th>Checks</th>
              <th>State</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr>
                <td>
                  <a href={ui.url(`/ui/builds/${b.id}`)}>{b.externalId ?? b.id.slice(-8)}</a>
                </td>
                <td>
                  {b.branch}
                  {b.branch !== b.baseBranch && <span class="muted">{` ← ${b.baseBranch}`}</span>}
                </td>
                <td>
                  <Badge value={b.verdict} />
                </td>
                <td class="muted">
                  {`${b.counts.total} total · ${b.counts.review.pending} pending · ${b.counts.result.changed} changed · ${b.counts.result.new} new`}
                </td>
                <td>{b.state}</td>
                <td>
                  <When at={b.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager newer={props.newer} older={props.older} />
    </Layout>
  );
}

export function registerProjectPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui', async (c) =>
    c.html(<ProjectsPage ui={uiOf(c, s)} projects={await listProjects(s.deps)} notice={noticeOf(c)} />),
  );

  app.post('/ui/projects', async (c) => {
    const ui = uiOf(c, s);
    if (!hasPermission(userOf(c), 'project.admin')) {
      throw new AppError('forbidden', 403, 'Only admins can create projects.');
    }
    const form = await c.req.parseBody();
    const input = { slug: field(form, 'slug'), name: field(form, 'name') };
    try {
      const project = await createProject(s.deps, input);
      return c.redirect(ui.url(`/ui/p/${project.slug}?done=project-created`), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      const message = err.errors?.length ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : err.detail;
      const page = <ProjectsPage ui={ui} projects={await listProjects(s.deps)} error={message} form={input} />;
      return c.html(page, err.status as 409 | 422);
    }
  });

  app.get('/ui/p/:slug', async (c) => {
    const ui = uiOf(c, s);
    const slug = c.req.param('slug');
    const branch = c.req.query('branch') || undefined;
    const cursor = c.req.query('cursor') || undefined;
    const project = await getProjectBySlug(s.deps, slug);
    const page = await listBuilds(s.deps, slug, { branch, cursor, limit: 50 });
    const query = (extra: Record<string, string>) =>
      `?${new URLSearchParams({ ...(branch ? { branch } : {}), ...extra }).toString()}`;
    return c.html(
      <BuildsPage
        ui={ui}
        project={project}
        builds={page.items}
        branch={branch}
        newer={cursor ? ui.url(`/ui/p/${slug}${query({})}`) : undefined}
        older={page.nextCursor ? ui.url(`/ui/p/${slug}${query({ cursor: page.nextCursor })}`) : undefined}
        notice={noticeOf(c)}
      />,
    );
  });
}
