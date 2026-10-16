import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { hasPermission } from '../../domain/auth/policy';
import { listProjectTokens } from '../../domain/auth/tokens';
import { type PromotionCandidate, promoteBranch, promotionCandidates } from '../../domain/baselines';
import { type BranchSummary, listBranchSummaries } from '../../domain/branches';
import { type BuildView, listBuilds } from '../../domain/builds';
import { firstPendingCheckId } from '../../domain/checks';
import { createProject, getProjectBySlug, listProjects } from '../../domain/projects';
import { type PromotionDiff, promotionDiff } from '../../domain/promotion-diff';
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
  VerdictPill,
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
  const slugHint =
    'Leave empty to make it from the name (“Web shop” → web-shop). It is the project’s address in URLs, the API and CI (PIXELTWIN_PROJECT); unlike the name, it never changes.';
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
      {/* Only the name is needed; the slug comes from it. A custom one hides here (open when it has a value or an error). */}
      <details class="advanced" open={Boolean(values.slug || errors.slug)}>
        <summary>Custom slug</summary>
        <Field id="project-slug" label="Slug" hint={slugHint} error={errors.slug}>
          <input
            name="slug"
            type="text"
            autocomplete="off"
            pattern="[a-z0-9][a-z0-9-]{1,62}"
            value={values.slug ?? ''}
            {...describedBy('project-slug', slugHint, errors.slug)}
          />
        </Field>
      </details>
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

/**
 * One status beside a card's name: a running build is a quiet pulsing dot; a finished one shows
 * its verdict, except "needs review", which the card's "N to review" already says.
 */
function CardStatus({ build }: { build: BuildView }) {
  if (build.state === 'open') {
    return (
      <span class="running-indicator">
        <span class="pulse" aria-hidden="true" />
        running
      </span>
    );
  }
  return build.verdict === 'pending' ? null : <VerdictPill verdict={build.verdict} />;
}

function ProjectCardView({ ui, card }: { ui: Ui; card: ProjectCard }) {
  const { project, latest } = card;
  return (
    <a class="project-card" href={ui.url(`/ui/p/${project.slug}`)}>
      <div class="project-card-head">
        <span class="project-name">{project.name}</span>
        {latest && <CardStatus build={latest} />}
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
    <Layout ui={ui} title="Projects" notice={notice} islands={['live']}>
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
        <div class="empty" data-live="projects" data-live-watch="">
          <h2>{isAdmin ? 'Create your first project' : 'No projects yet'}</h2>
          <p>
            {isAdmin
              ? 'A project holds the baselines, builds and tokens of one app or site.'
              : 'Ask an admin to add a project.'}
          </p>
          {isAdmin && <NewProjectButton ui={ui} />}
        </div>
      ) : (
        <div class="project-grid" data-live="projects" data-live-watch="">
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

function Lane(props: {
  ui: Ui;
  slug: string;
  summary: BranchSummary;
  reviewHref?: string | undefined;
  /** Screens this branch would change on main, for admins; 0 or undefined hides Promote. */
  promotable?: number | undefined;
  mainBranch: string;
}) {
  const { ui, slug, summary } = props;
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
          {props.promotable ? (
            <a
              class="button small"
              href={ui.url(`/ui/p/${slug}/promote?branch=${encodeURIComponent(summary.branch)}`)}
              title={`Copy this branch's baselines to ${props.mainBranch}`}
            >
              {`Promote ${props.promotable} to ${props.mainBranch}`}
            </a>
          ) : null}
          {props.reviewHref && (
            <a class="button small" href={props.reviewHref}>
              Review
            </a>
          )}
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
  /** Per branch: its latest build's first check waiting for review. */
  laneReviews: Map<string, string>;
  lanePromotions: Map<string, number>;
  canManage: boolean;
  onboarding?: { hasToken: boolean; publicUrl: string } | undefined;
  notice?: string | undefined;
}) {
  const { ui, project, summaries } = props;
  // Open builds still receive checks: the live island keeps the lanes current until they finish.
  const running = summaries.some((x) => x.latest.state === 'open');
  return (
    <Layout
      ui={ui}
      title={project.name}
      crumbs={[{ label: project.name }]}
      notice={props.notice}
      project={project.slug}
      islands={[
        ...(props.onboarding && props.canManage ? ['tokens'] : []),
        // Live always: running builds update every 5 s, new ones show up within 10 s.
        'live',
      ]}
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
        <div class="page-actions" data-live="actions">
          {props.review && (
            <a class="button primary" href={props.review.href} data-palette-review>
              {`Review ${props.review.count} →`}
            </a>
          )}
        </div>
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
        <div
          class="lanes"
          data-live="lanes"
          data-live-open={running ? '' : undefined}
          data-live-watch={running ? undefined : ''}
        >
          {summaries.map((summary) => (
            <Lane
              ui={ui}
              slug={project.slug}
              summary={summary}
              reviewHref={props.laneReviews.get(summary.branch)}
              promotable={props.lanePromotions.get(summary.branch)}
              mainBranch={project.mainBranch}
            />
          ))}
        </div>
      )}
    </Layout>
  );
}

/** `watch`: the first page, where new builds appear; a later page never changes by itself. */
function BuildsTable({ ui, builds, watch }: { ui: Ui; builds: BuildView[]; watch: boolean }) {
  const running = builds.some((b) => b.state === 'open');
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
      <tbody
        data-live="builds"
        data-live-open={running ? '' : undefined}
        data-live-watch={!running && watch ? '' : undefined}
      >
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
      project={project.slug}
      islands={builds.some((b) => b.state === 'open') || !props.newer ? ['live'] : undefined}
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
        <BuildsTable ui={ui} builds={builds} watch={!props.newer} />
      )}
      <div class="pager">
        <span>{props.newer && <a href={props.newer}>← Newest</a>}</span>
        <span>{props.older && <a href={props.older}>Older →</a>}</span>
      </div>
    </Layout>
  );
}

/** Choose the screens of a branch to copy to main: each shows main now → the branch. */
function PromotePage(props: {
  ui: Ui;
  project: Project;
  branch: string;
  candidates: PromotionCandidate[];
  diffs: Map<string, PromotionDiff | null>;
}) {
  const { ui, project, branch, candidates } = props;
  const main = project.mainBranch;
  const image = (src: string, alt: string, cls = 'promote-thumb') => (
    <img class={cls} src={src} alt={alt} loading="lazy" />
  );
  const imageUrl = (sha: string) => ui.url(`/api/v1/images/${sha}`);
  const diffUrl = (key: string) =>
    ui.url(
      `/ui/p/${project.slug}/promote/diff.png?branch=${encodeURIComponent(branch)}&key=${encodeURIComponent(key)}`,
    );
  return (
    <Layout
      ui={ui}
      title={`Promote ${branch}`}
      crumbs={[{ label: project.name, href: ui.url(`/ui/p/${project.slug}`) }, { label: `Promote ${branch}` }]}
      project={project.slug}
      islands={['promote']}
    >
      <div class="page-head">
        <div>
          <h1>{`Promote ${branch} to ${main}`}</h1>
          <p class="sub">
            {`The checked screens' baselines from ${branch} become ${main}'s, so ${main} does not ask to review them again after the merge. Uncheck what should wait; Compare shows a screen large, with its changes in red.`}
          </p>
        </div>
      </div>
      {candidates.length === 0 ? (
        <div class="empty">
          <h3>Nothing to promote</h3>
          <p class="muted">{`${main} already has every screen of ${branch} as it is.`}</p>
          <a class="button" href={ui.url(`/ui/p/${project.slug}`)}>
            Back to branches
          </a>
        </div>
      ) : (
        <form method="post" action={ui.url(`/ui/p/${project.slug}/promote`)}>
          <input type="hidden" name="branch" value={branch} />
          <ul class="promote-list">
            {candidates.map((c) => {
              const diff = props.diffs.get(c.snapshotKey);
              const what = !c.mainImageSha
                ? `new on ${main}`
                : diff
                  ? `${diff.percent}% changed · ${diff.changes} ${diff.changes === 1 ? 'change' : 'changes'}`
                  : `differs from ${main}`;
              const variant =
                Object.entries(c.variant)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ') || 'no variant';
              const showDiff = Boolean(c.mainImageSha && diff?.diffPng);
              return (
                <li class="promote-row">
                  <label class="promote-pick">
                    <input type="checkbox" name="snapshotKey" value={c.snapshotKey} checked />
                    <span class="promote-name">
                      <strong>{c.name}</strong>
                      <span class="muted">{variant}</span>
                      <span class={c.mainImageSha ? 'promote-what' : 'promote-what new'}>{what}</span>
                    </span>
                  </label>
                  <span class="promote-images">
                    {c.mainImageSha ? (
                      image(imageUrl(c.mainImageSha), `${main} now`)
                    ) : (
                      <span class="promote-none muted">new on {main}</span>
                    )}
                    <span aria-hidden="true">→</span>
                    {image(imageUrl(c.branchImageSha), branch)}
                    {showDiff && image(diffUrl(c.snapshotKey), 'changes in red', 'promote-thumb promote-diff-thumb')}
                  </span>
                  <details class="promote-compare">
                    <summary>Compare</summary>
                    {/* JavaScript shows the tools; without it Compare is side by side at fit. */}
                    <div class="promote-tools" hidden>
                      {c.mainImageSha && (
                        <fieldset class="segmented promote-modes">
                          <legend class="visually-hidden">Compare mode</legend>
                          <button type="button" data-promote-mode="side" aria-pressed="true">
                            Side by side
                          </button>
                          <button type="button" data-promote-mode="onion" aria-pressed="false">
                            Onion
                          </button>
                        </fieldset>
                      )}
                      {c.mainImageSha && (
                        <label class="promote-opacity" hidden>
                          <span class="muted">{`${main} now`}</span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value="50"
                            data-promote-opacity
                            aria-label={`How much of ${branch} shows over ${main}`}
                          />
                          <span class="muted">{branch}</span>
                        </label>
                      )}
                      <span class="promote-zoom">
                        <button type="button" class="small" data-promote-zoom="out" aria-label="Zoom out">
                          −
                        </button>
                        <button type="button" class="small" data-promote-zoom="fit" aria-label="Fit">
                          <span data-promote-zoom-label>Fit</span>
                        </button>
                        <button type="button" class="small" data-promote-zoom="in" aria-label="Zoom in">
                          +
                        </button>
                      </span>
                    </div>
                    <p class="hint">
                      Click or scroll to zoom, drag to move. In Onion, fade between main and the branch.
                    </p>
                    <div class={showDiff ? 'promote-large three' : 'promote-large'} data-mode="side">
                      <figure>
                        <figcaption>{`${main} now`}</figcaption>
                        {c.mainImageSha ? (
                          <div class="promote-viewport">
                            {image(imageUrl(c.mainImageSha), `${main} now`, 'promote-full')}
                          </div>
                        ) : (
                          <span class="promote-none muted">{`no baseline on ${main} yet`}</span>
                        )}
                      </figure>
                      <figure>
                        <figcaption>{branch}</figcaption>
                        <div class="promote-viewport">{image(imageUrl(c.branchImageSha), branch, 'promote-full')}</div>
                      </figure>
                      {showDiff && (
                        <figure>
                          <figcaption>Changes in red</figcaption>
                          <div class="promote-viewport">
                            {image(diffUrl(c.snapshotKey), 'changes in red', 'promote-full')}
                          </div>
                        </figure>
                      )}
                      {c.mainImageSha && (
                        <figure class="promote-onion-pane">
                          <div class="promote-viewport promote-onion">
                            {image(imageUrl(c.mainImageSha), `${main} now`, 'promote-full')}
                            <div class="promote-top-layer">
                              {image(imageUrl(c.branchImageSha), branch, 'promote-full')}
                            </div>
                          </div>
                        </figure>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          <div class="dialog-actions">
            <a class="button" href={ui.url(`/ui/p/${project.slug}`)}>
              Cancel
            </a>
            <button class="primary" type="submit">
              {`Promote checked to ${main}`}
            </button>
          </div>
        </form>
      )}
    </Layout>
  );
}

export function registerProjectPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  const requirePromote = (c: Parameters<typeof uiOf>[0]) => {
    if (!hasPermission(userOf(c), 'check.write')) {
      throw new AppError('forbidden', 403, 'Only admins can promote a branch.');
    }
  };

  app.get('/ui/p/:slug/promote', async (c) => {
    const ui = uiOf(c, s);
    requirePromote(c);
    const project = await getProjectBySlug(s.deps, c.req.param('slug'));
    const branch = (c.req.query('branch') ?? '').trim();
    const candidates = await promotionCandidates(s.deps, project.slug, branch);
    const diffs = new Map(
      await Promise.all(
        candidates.map(
          async (x) =>
            [
              x.snapshotKey,
              x.mainImageSha
                ? await promotionDiff(s.deps, project, x.snapshotKey, x.mainImageSha, x.branchImageSha)
                : null,
            ] as const,
        ),
      ),
    );
    return c.html(<PromotePage ui={ui} project={project} branch={branch} candidates={candidates} diffs={diffs} />);
  });

  // The diff image of one screen on the promote page (main now vs the branch, changes in red).
  app.get('/ui/p/:slug/promote/diff.png', async (c) => {
    requirePromote(c);
    const project = await getProjectBySlug(s.deps, c.req.param('slug'));
    const branch = (c.req.query('branch') ?? '').trim();
    const key = c.req.query('key') ?? '';
    const candidate = (await promotionCandidates(s.deps, project.slug, branch)).find((x) => x.snapshotKey === key);
    const diff = candidate?.mainImageSha
      ? await promotionDiff(s.deps, project, key, candidate.mainImageSha, candidate.branchImageSha)
      : null;
    if (!diff?.diffPng) throw new AppError('not_found', 404, 'No diff for this screen.');
    return new Response(new Uint8Array(diff.diffPng), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' },
    });
  });

  app.post('/ui/p/:slug/promote', async (c) => {
    const ui = uiOf(c, s);
    requirePromote(c);
    const form = await c.req.parseBody({ all: true });
    const slug = c.req.param('slug');
    const branch = field(form, 'branch') ?? '';
    const raw = form.snapshotKey;
    const snapshotKeys = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
      (k): k is string => typeof k === 'string',
    );
    await promoteBranch(s.deps, slug, branch, userOf(c).id, { snapshotKeys });
    return c.redirect(ui.url(`/ui/p/${slug}?done=promoted`), 303);
  });

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

    // Each lane whose latest build has checks waiting links to the first one; "Review N →" in the
    // header opens the most recent of those builds.
    const waiting = summaries
      .filter((x) => x.latest.counts.review.pending > 0)
      .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
    const laneReviews = new Map<string, string>();
    for (const x of waiting) {
      const first = await firstPendingCheckId(s.deps, x.latest.id);
      if (first) laneReviews.set(x.branch, ui.url(`/ui/checks/${first}?filter=pending`));
    }
    const newest = waiting[0] && laneReviews.get(waiting[0].branch);
    // Admins (who may promote) see on each other lane how many screens it would change on main.
    const lanePromotions = new Map<string, number>();
    if (hasPermission(userOf(c), 'check.write')) {
      for (const x of summaries) {
        if (x.branch === project.mainBranch) continue;
        lanePromotions.set(x.branch, (await promotionCandidates(s.deps, slug, x.branch)).length);
      }
    }
    const review = newest ? { href: newest, count: pendingIn(summaries) } : null;

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
        laneReviews={laneReviews}
        lanePromotions={lanePromotions}
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
