import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { listProjectTokens } from '../../domain/auth/tokens';
import { type BranchSummary, listBranchSummaries } from '../../domain/branches';
import { type BuildView, listBuilds } from '../../domain/builds';
import { firstPendingCheckId } from '../../domain/checks';
import { createProject, getProjectBySlug, listProjects } from '../../domain/projects';
import { AppError } from '../../errors';
import type { AppEnv, Services } from '../../http/env';
import {
  Ago,
  BuildDot,
  BuildStatus,
  countsText,
  describedBy,
  Field,
  formErrors,
  Pill,
  ProjectTabs,
  toneOf,
  VERDICT_LABELS,
} from '../components';
import { field, noticeOf, type Ui, uiOf, userOf } from '../context';
import { Layout } from '../layout';
import { Onboarding } from '../onboarding';

interface ProjectCard {
  project: Project;
  latest: BuildView | null;
  toReview: number;
  branches: number;
}

/** Checks waiting for review in the latest build of each branch: what "N to review" counts. */
function pendingIn(summaries: BranchSummary[]): number {
  return summaries.reduce((n, s) => n + s.latest.counts.review.pending, 0);
}

async function projectCards(s: Services, projects: Project[]): Promise<ProjectCard[]> {
  return Promise.all(
    projects.map(async (project) => {
      const summaries = await listBranchSummaries(s.deps, project.slug);
      // The card's verdict is the main branch's health; feature branches show up in "to review".
      const main = summaries.find((x) => x.branch === project.mainBranch)?.latest;
      const latest = main ?? summaries.map((x) => x.latest).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      return { project, latest, toReview: pendingIn(summaries), branches: summaries.length };
    }),
  );
}

type FormValues = { name?: string | undefined; slug?: string | undefined };

function NewProjectForm({
  ui,
  values = {},
  errors = {},
  inDialog,
}: {
  ui: Ui;
  values?: FormValues;
  errors?: Record<string, string>;
  inDialog: boolean;
}) {
  const slugHint = 'Lowercase letters, digits and hyphens. Used in URLs and the API.';
  return (
    <form method="post" action={ui.url('/ui/projects')}>
      {errors._form && <p class="flash error">{errors._form}</p>}
      <Field id="project-name" label="Name" error={errors.name}>
        <input
          name="name"
          type="text"
          required
          autocomplete="off"
          value={values.name ?? ''}
          {...describedBy('project-name', undefined, errors.name)}
        />
      </Field>
      <Field id="project-slug" label="Slug" hint={slugHint} error={errors.slug}>
        <input
          name="slug"
          type="text"
          required
          autocomplete="off"
          pattern="[a-z0-9][a-z0-9-]{1,62}"
          value={values.slug ?? ''}
          {...describedBy('project-slug', slugHint, errors.slug)}
        />
      </Field>
      <div class="dialog-actions">
        {inDialog ? (
          <button type="button" data-dialog-close>
            Cancel
          </button>
        ) : (
          <a class="button" href={ui.url('/ui')}>
            Cancel
          </a>
        )}
        <button class="primary" type="submit">
          Create project
        </button>
      </div>
    </form>
  );
}

/** Opens the dialog with JavaScript; without it, the link leads to the form's own page. */
function NewProjectButton({ ui }: { ui: Ui }) {
  return (
    <a class="button primary" href={ui.url('/ui/projects/new')} data-dialog-open="new-project">
      New project
    </a>
  );
}

function ProjectCardView({ ui, card }: { ui: Ui; card: ProjectCard }) {
  const { project, latest } = card;
  return (
    <a class="project-card" href={ui.url(`/ui/p/${project.slug}`)}>
      <div class="project-card-head">
        <span class="project-name">{project.name}</span>
        {latest && <BuildStatus build={latest} />}
      </div>
      <span class="mono muted">{project.slug}</span>
      <div class="project-card-foot">
        {latest ? (
          <>
            {card.toReview > 0 && <Pill tone="amber">{`${card.toReview} to review`}</Pill>}
            <span class="muted">
              {'Last build '}
              <Ago at={latest.createdAt} />
              {` · ${card.branches} ${card.branches === 1 ? 'branch' : 'branches'}`}
            </span>
          </>
        ) : (
          <span class="muted">No builds yet</span>
        )}
      </div>
    </a>
  );
}

function ProjectsPage({ ui, cards, notice }: { ui: Ui; cards: ProjectCard[]; notice?: string | undefined }) {
  const isAdmin = ui.user?.role === 'admin';
  return (
    <Layout ui={ui} title="Projects" notice={notice}>
      <div class="page-head">
        <div>
          <h1>Projects</h1>
          <p class="sub">Each project has its own baselines, builds and tokens.</p>
        </div>
        {isAdmin && cards.length > 0 && (
          <div class="page-actions">
            <NewProjectButton ui={ui} />
          </div>
        )}
      </div>
      {cards.length === 0 ? (
        <div class="empty">
          <h2>{isAdmin ? 'Create your first project' : 'No projects yet'}</h2>
          <p>
            {isAdmin
              ? 'A project holds the baselines, builds and tokens of one app or site.'
              : 'Ask an admin to add a project.'}
          </p>
          {isAdmin && <NewProjectButton ui={ui} />}
        </div>
      ) : (
        <div class="project-grid">
          {cards.map((card) => (
            <ProjectCardView ui={ui} card={card} />
          ))}
        </div>
      )}
      {isAdmin && (
        <dialog id="new-project" aria-labelledby="new-project-title">
          <h2 id="new-project-title">New project</h2>
          <NewProjectForm ui={ui} inDialog />
        </dialog>
      )}
    </Layout>
  );
}

function NewProjectPage(props: { ui: Ui; values?: FormValues; errors?: Record<string, string> }) {
  return (
    <Layout ui={props.ui} title="New project" crumbs={[{ label: 'New project' }]}>
      <div class="panel narrow">
        <h1>New project</h1>
        <NewProjectForm ui={props.ui} values={props.values} errors={props.errors} inDialog={false} />
      </div>
    </Layout>
  );
}

function Lane({ ui, slug, summary }: { ui: Ui; slug: string; summary: BranchSummary }) {
  const build = summary.latest;
  return (
    <article class="lane">
      <div class="lane-head">
        <BuildDot build={build} />
        <a class="lane-branch mono" href={ui.url(`/ui/p/${slug}/builds?branch=${encodeURIComponent(summary.branch)}`)}>
          {summary.branch}
        </a>
        {summary.branch !== build.baseBranch && <span class="muted">vs {build.baseBranch}</span>}
        <BuildStatus build={build} />
        <span class="lane-meta">
          <a href={ui.url(`/ui/builds/${build.id}`)}>{`#${build.number}`}</a>
          <span class="muted">
            <Ago at={build.createdAt} />
          </span>
        </span>
      </div>
      <div class="lane-body">
        <ol class="history" aria-label="Recent builds, newest first">
          {summary.recent.map((r) => (
            <li>
              <a
                class={`square tone-${toneOf(r.verdict)}`}
                href={ui.url(`/ui/builds/${r.id}`)}
                title={`#${r.number} ${VERDICT_LABELS[r.verdict]}`}
              >
                <span class="visually-hidden">{`#${r.number} ${VERDICT_LABELS[r.verdict]}`}</span>
              </a>
            </li>
          ))}
        </ol>
        <span class="muted">{countsText(build.counts)}</span>
      </div>
    </article>
  );
}

function BranchesPage(props: {
  ui: Ui;
  project: Project;
  summaries: BranchSummary[];
  review: { href: string; count: number } | null;
  canManage: boolean;
  onboarding?: { hasToken: boolean; publicUrl: string } | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, summaries } = props;
  return (
    <Layout
      ui={ui}
      title={project.name}
      crumbs={[{ label: project.name }]}
      notice={props.notice}
      islands={props.onboarding && props.canManage ? ['tokens'] : undefined}
    >
      <div class="page-head">
        <div>
          <h1>{project.name}</h1>
          <p class="sub">
            <span class="mono">{project.slug}</span>
            {' · main branch '}
            <span class="mono">{project.mainBranch}</span>
          </p>
        </div>
        {props.review && (
          <div class="page-actions">
            <a class="button primary" href={props.review.href}>
              {`Review ${props.review.count} →`}
            </a>
          </div>
        )}
      </div>
      <ProjectTabs ui={ui} slug={project.slug} current="branches" canManage={props.canManage} />
      {props.onboarding ? (
        <Onboarding
          ui={ui}
          project={project}
          publicUrl={props.onboarding.publicUrl}
          hasToken={props.onboarding.hasToken}
          canManage={props.canManage}
        />
      ) : (
        <div class="lanes">
          {summaries.map((summary) => (
            <Lane ui={ui} slug={project.slug} summary={summary} />
          ))}
        </div>
      )}
    </Layout>
  );
}

function BuildsTable({ ui, builds }: { ui: Ui; builds: BuildView[] }) {
  return (
    <table class="builds stack-on-phone">
      <thead>
        <tr>
          <th>Build</th>
          <th>Branch</th>
          <th>Commit</th>
          <th>CI run</th>
          <th>Verdict</th>
          <th>Checks</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {builds.map((b) => (
          <tr>
            <td>
              <span class="build-id">
                <BuildDot build={b} />
                <a href={ui.url(`/ui/builds/${b.id}`)}>{`#${b.number}`}</a>
              </span>
            </td>
            <td class="mono">
              {b.branch}
              {b.branch !== b.baseBranch && <span class="muted">{` ← ${b.baseBranch}`}</span>}
            </td>
            <td class={b.commitSha ? 'mono' : 'mono empty-on-phone'}>
              {b.commitSha ? b.commitSha.slice(0, 7) : <span class="muted">—</span>}
            </td>
            <td class={b.externalId ? undefined : 'empty-on-phone'}>{b.externalId ?? <span class="muted">—</span>}</td>
            <td>
              <BuildStatus build={b} />
            </td>
            <td class="muted">{countsText(b.counts)}</td>
            <td>
              <Ago at={b.createdAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AllBuildsPage(props: {
  ui: Ui;
  project: Project;
  builds: BuildView[];
  branches: string[];
  branch?: string | undefined;
  newer?: string | undefined;
  older?: string | undefined;
  canManage: boolean;
}) {
  const { ui, project, builds, branch } = props;
  return (
    <Layout
      ui={ui}
      title={`${project.name} builds`}
      crumbs={[{ label: project.name, href: ui.url(`/ui/p/${project.slug}`) }, { label: 'All builds' }]}
    >
      <div class="page-head">
        <div>
          <h1>{project.name}</h1>
        </div>
      </div>
      <ProjectTabs ui={ui} slug={project.slug} current="builds" canManage={props.canManage} />
      <form class="filter-bar" method="get" action={ui.url(`/ui/p/${project.slug}/builds`)}>
        <label class="visually-hidden" for="branch">
          Branch
        </label>
        <select id="branch" name="branch">
          <option value="">All branches</option>
          {props.branches.map((b) => (
            <option value={b} selected={b === branch}>
              {b}
            </option>
          ))}
        </select>
        <button type="submit">Filter</button>
      </form>
      {builds.length === 0 ? (
        <div class="empty">
          <h3>{branch ? `No builds on ${branch}` : 'No builds yet'}</h3>
        </div>
      ) : (
        <BuildsTable ui={ui} builds={builds} />
      )}
      <div class="pager">
        <span>{props.newer && <a href={props.newer}>← Newest</a>}</span>
        <span>{props.older && <a href={props.older}>Older →</a>}</span>
      </div>
    </Layout>
  );
}

export function registerProjectPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  const requireCreate = (ui: Ui) => {
    if (!ui.user || !hasPermission(ui.user, 'project.admin')) {
      throw new AppError('forbidden', 403, 'Only admins can create projects.');
    }
  };

  app.get('/ui', async (c) => {
    const ui = uiOf(c, s);
    const cards = await projectCards(s, await listProjects(s.deps));
    return c.html(<ProjectsPage ui={ui} cards={cards} notice={noticeOf(c)} />);
  });

  app.get('/ui/projects/new', (c) => {
    const ui = uiOf(c, s);
    requireCreate(ui);
    return c.html(<NewProjectPage ui={ui} />);
  });

  app.post('/ui/projects', async (c) => {
    const ui = uiOf(c, s);
    requireCreate(ui);
    const form = await c.req.parseBody();
    const values = { slug: field(form, 'slug'), name: field(form, 'name') };
    try {
      const project = await createProject(s.deps, values);
      return c.redirect(ui.url(`/ui/p/${project.slug}?done=project-created`), 303);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      const errors = err.code === 'project_slug_taken' ? { slug: err.detail } : formErrors(err);
      return c.html(<NewProjectPage ui={ui} values={values} errors={errors} />, err.status as 409 | 422);
    }
  });

  app.get('/ui/p/:slug', async (c) => {
    const ui = uiOf(c, s);
    const slug = c.req.param('slug');
    // The build list moved to its own tab; keep old filtered links working.
    const query = new URL(c.req.url).search;
    if (c.req.query('branch') !== undefined || c.req.query('cursor') !== undefined) {
      return c.redirect(ui.url(`/ui/p/${slug}/builds${query}`), 302);
    }
    const project = await getProjectBySlug(s.deps, slug);
    const summaries = await listBranchSummaries(s.deps, slug);
    const canManage = hasPermission(userOf(c), 'project.admin');

    // "Review N →" opens the most recent build that has checks waiting.
    const waiting = summaries
      .map((x) => x.latest)
      .filter((b) => b.counts.review.pending > 0)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const first = waiting ? await firstPendingCheckId(s.deps, waiting.id) : null;
    const review = first ? { href: ui.url(`/ui/checks/${first}?filter=pending`), count: pendingIn(summaries) } : null;

    const onboarding =
      summaries.length === 0
        ? { hasToken: (await listProjectTokens(s.deps, slug)).length > 0, publicUrl: s.config.publicUrl }
        : undefined;
    return c.html(
      <BranchesPage
        ui={ui}
        project={project}
        summaries={summaries}
        review={review}
        canManage={canManage}
        onboarding={onboarding}
        notice={noticeOf(c)}
      />,
    );
  });

  app.get('/ui/p/:slug/builds', async (c) => {
    const ui = uiOf(c, s);
    const slug = c.req.param('slug');
    const branch = c.req.query('branch') || undefined;
    const cursor = c.req.query('cursor') || undefined;
    const project = await getProjectBySlug(s.deps, slug);
    const [page, summaries] = await Promise.all([
      listBuilds(s.deps, slug, { branch, cursor, limit: 50 }),
      listBranchSummaries(s.deps, slug),
    ]);
    const branches = summaries.map((x) => x.branch);
    if (branch && !branches.includes(branch)) branches.push(branch);
    const query = (extra: Record<string, string>) =>
      `?${new URLSearchParams({ ...(branch ? { branch } : {}), ...extra }).toString()}`;
    return c.html(
      <AllBuildsPage
        ui={ui}
        project={project}
        builds={page.items}
        branches={branches}
        branch={branch}
        newer={cursor ? ui.url(`/ui/p/${slug}/builds${query({})}`) : undefined}
        older={page.nextCursor ? ui.url(`/ui/p/${slug}/builds${query({ cursor: page.nextCursor })}`) : undefined}
        canManage={hasPermission(userOf(c), 'project.admin')}
      />,
    );
  });
}
