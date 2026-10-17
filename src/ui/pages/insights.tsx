import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Project } from '../../db/schema';
import { insightBranches } from '../../domain/insights';
import {
  dateOf,
  getInsights,
  type InsightBucket,
  type InsightsRange,
  type InsightsReport,
  insightBuckets,
  type NoiseReason,
  rangeOf,
} from '../../domain/insights-report';
import { REJECT_REASON_INFO } from '../../domain/reject-reasons';
import { visibleProject } from '../../http/access';
import type { AppEnv, Services } from '../../http/env';
import { type Bucket, Chart, type Series } from '../charts';
import { Ago, Pill, ProjectTabs, Variant } from '../components';
import { noticeOf, type Ui, uiOf } from '../context';
import { Layout } from '../layout';

/** The ranges the page offers, in days; a 90-day range is drawn in weeks. */
export const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Oct 3` (UTC). */
function short(day: number): string {
  const d = new Date(day * 86_400_000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `45 s`, `18m`, `2h 10m`, `3d 4h`: a time to decision. */
export function spanText(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** `1m 12s`, `38 s`, `0.4 s`: a run's visual-check time. */
function runText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Gridline steps of durations. */
const TIME_STEPS = [
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
  48 * HOUR,
  72 * HOUR,
  168 * HOUR,
];
const RUN_STEPS = [
  100,
  200,
  500,
  1000,
  2000,
  5000,
  10_000,
  15_000,
  30_000,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
];

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const NOISE_LABELS: Record<NoiseReason, string> = {
  not_loaded: REJECT_REASON_INFO.not_loaded.label,
  late_asset: REJECT_REASON_INFO.late_asset.label,
  animation: REJECT_REASON_INFO.animation.label,
  dynamic_data: REJECT_REASON_INFO.dynamic_data.label,
  flaky: 'Keeps flipping',
};

/** A stat tile: label, value, an optional change against the period before, one line of context. */
function Tile(props: {
  label: string;
  value: string;
  sub: string;
  delta?: { text: string; good: boolean | null } | null;
  id: string;
}) {
  return (
    <section class="tile" aria-labelledby={`${props.id}-label`} data-tile={props.id}>
      <h2 class="tile-label" id={`${props.id}-label`}>
        {props.label}
      </h2>
      <p class="tile-value">{props.value}</p>
      {props.delta && (
        <p class={`tile-delta ${props.delta.good === null ? 'same' : props.delta.good ? 'up-good' : 'down-bad'}`}>
          {props.delta.text}
        </p>
      )}
      <p class="tile-sub muted">{props.sub}</p>
    </section>
  );
}

/** "▲ 4 pts" / "▼ 2 pts" / "Same as": the auto-pass rate against the range before. */
function rateDelta(now: number | null, before: number | null, days: number) {
  if (now === null || before === null) return null;
  const pts = Math.round((now - before) * 100);
  const span = `the ${days} days before`;
  if (pts === 0) return { text: `Same as ${span}`, good: null };
  return { text: `${pts > 0 ? '▲' : '▼'} ${Math.abs(pts)} pts vs ${span}`, good: pts > 0 };
}

function timeDelta(now: number | null, before: number | null, days: number) {
  if (now === null || before === null || before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  const span = `the ${days} days before`;
  if (Math.abs(change) < 5) return { text: `About the same as ${span}`, good: null };
  return { text: `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% vs ${span}`, good: change < 0 };
}

function Tiles({ report, ui, slug }: { report: InsightsReport; ui: Ui; slug: string }) {
  const t = report.totals;
  const r = t.rejections;
  return (
    <div class="tiles">
      <Tile
        id="auto-pass"
        label="Auto-pass rate"
        value={percent(t.autoPassRate)}
        delta={rateDelta(t.autoPassRate, report.previous.autoPassRate, report.days)}
        sub={`${t.autoPassed} of ${plural(t.checks, 'check')} passed with no one looking`}
      />
      <Tile
        id="time-to-decision"
        label="Time to decision"
        value={spanText(t.timeToDecision.medianMs)}
        delta={timeDelta(t.timeToDecision.medianMs, report.previous.medianTimeToDecisionMs, report.days)}
        sub={`Median; p90 ${spanText(t.timeToDecision.p90Ms)} · ${plural(t.timeToDecision.decidedBuilds, 'build')} decided`}
      />
      <Tile
        id="noise"
        label="Rejections that were noise"
        value={r.total === 0 ? '—' : `${r.noise} of ${r.total}`}
        sub={
          r.total === 0
            ? 'Nothing was rejected'
            : `${plural(r.realBug, 'real bug')}${r.other ? ` · ${r.other} other` : ''}; noise is not loaded, late assets, animation, dynamic data`
        }
      />
      <Tile
        id="run-time"
        label="Visual-check time per run"
        value={runText(t.runTime.perBuildMs)}
        sub={
          t.builds === 0
            ? 'No runs'
            : `Screenshots ${runText(Math.round(t.runTime.screenshotMs / t.builds))} · upload ${runText(Math.round(t.runTime.uploadMs / t.builds))} · compare ${runText(Math.round(t.runTime.compareMs / t.builds))}`
        }
      />
      <section class="tile" aria-labelledby="flaky-label" data-tile="flaky">
        <h2 class="tile-label" id="flaky-label">
          Flaky screens now
        </h2>
        <p class="tile-value">{String(report.flakyScreensNow)}</p>
        <p class="tile-sub muted">
          {`On ${report.branch}, from their last 20 runs · `}
          <a href={ui.url(`/ui/p/${slug}/noisy`)}>Noisy screens</a>
        </p>
      </section>
    </div>
  );
}

/** Axis label and tooltip title of a bucket: a day, or a week in the 90-day range. */
function bucketTitles(b: InsightBucket): Pick<Bucket, 'label' | 'title'> {
  if (b.fromDay === b.toDay) {
    const weekday = WEEKDAYS[new Date(b.fromDay * 86_400_000).getUTCDay()];
    return { label: short(b.fromDay), title: `${weekday}, ${short(b.fromDay)}` };
  }
  return { label: short(b.fromDay), title: `${short(b.fromDay)} – ${short(b.toDay)}` };
}

const REVIEW_LOAD: Series[] = [
  { label: 'Passed by themselves', slot: 1 },
  { label: 'Approved', slot: 3 },
  { label: 'Rejected', slot: 2 },
];
const REASONS: Array<Series & { codes: Array<keyof InsightsReport['totals']['rejections']['byReason']> }> = [
  { label: 'Captured too early', slot: 1, codes: ['not_loaded', 'late_asset'] },
  { label: 'Animation', slot: 2, codes: ['animation'] },
  { label: 'Dynamic data', slot: 3, codes: ['dynamic_data'] },
  { label: 'Real bug', slot: 4, codes: ['real_bug'] },
  { label: 'Other', slot: 5, codes: ['environment', 'other', 'uncategorized'] },
];

function Charts({ buckets, weekly }: { buckets: InsightBucket[]; weekly: boolean }) {
  const per = weekly ? 'week' : 'day';
  const at = (b: InsightBucket, values: Array<number | null>): Bucket => ({ ...bucketTitles(b), values });
  const none = (b: InsightBucket) => b.totals.builds === 0;
  const count = (v: number) => String(Math.round(v));
  return (
    <div class="charts">
      <Chart
        id="chart-auto-pass"
        title="Auto-pass rate"
        description={`Share of checks per ${per} that passed with no one looking: unchanged, or new and approved by the project setting.`}
        kind="line"
        area
        max={1}
        format={(v) => `${Math.round(v * 100)}%`}
        series={[{ label: 'Auto-pass rate', slot: 1 }]}
        buckets={buckets.map((b) => at(b, [b.totals.autoPassRate]))}
      />
      <Chart
        id="chart-review-load"
        title="Review load"
        description={`Checks per ${per}: those that passed by themselves, and those a person or agent approved or rejected.`}
        kind="stack"
        format={count}
        series={REVIEW_LOAD}
        buckets={buckets.map((b) => at(b, [b.totals.autoPassed, b.totals.approved, b.totals.rejected]))}
      />
      <Chart
        id="chart-reasons"
        title="Why checks were rejected"
        description={`Rejections per ${per} by reason. Captured too early, animation and dynamic data are noise to fix in the test; a real bug is a regression.`}
        kind="stack"
        format={count}
        series={REASONS}
        buckets={buckets.map((b) =>
          at(
            b,
            REASONS.map((s) => s.codes.reduce((sum, code) => sum + b.totals.rejections.byReason[code], 0)),
          ),
        )}
      />
      <Chart
        id="chart-time-to-decision"
        title="Time to decision"
        description={`From a build's finalize to its last decision, per ${per}: the median and the slowest tenth (p90). Builds that needed review only.`}
        kind="line"
        format={(v) => spanText(v)}
        steps={TIME_STEPS}
        series={[
          { label: 'Median', slot: 1 },
          { label: 'p90', slot: 'muted' },
        ]}
        buckets={buckets.map((b) => at(b, [b.totals.timeToDecision.medianMs, b.totals.timeToDecision.p90Ms]))}
      />
      <Chart
        id="chart-run-time"
        title="Visual-check time per run"
        description={`Average per build each ${per}: screenshots and uploads as the SDK measured them (added up over its workers), and the server's compare time.`}
        kind="stack"
        format={(v) => runText(v)}
        steps={RUN_STEPS}
        series={[
          { label: 'Screenshots', slot: 1 },
          { label: 'Upload', slot: 2 },
          { label: 'Compare', slot: 3 },
        ]}
        buckets={buckets.map((b) =>
          at(
            b,
            none(b)
              ? [null, null, null]
              : [
                  Math.round(b.totals.runTime.screenshotMs / b.totals.builds),
                  Math.round(b.totals.runTime.uploadMs / b.totals.builds),
                  Math.round(b.totals.runTime.compareMs / b.totals.builds),
                ],
          ),
        )}
      />
    </div>
  );
}

function NoisyTable({ ui, report }: { ui: Ui; report: InsightsReport }) {
  return (
    <section class="insights-section" aria-labelledby="noisy-title">
      <div class="section-head">
        <h2 id="noisy-title">Screens to fix in the tests</h2>
        <p class="muted">
          Flaky screens and screens rejected as noise in this range, with what to change. Open one to ignore its noisy
          area.
        </p>
      </div>
      {report.noisyScreens.length === 0 ? (
        <div class="empty">
          <p>No noisy screens in this range.</p>
        </div>
      ) : (
        <table class="stack-on-phone">
          <thead>
            <tr>
              <th scope="col">Screen</th>
              <th scope="col">Flaky</th>
              <th scope="col">Noise rejections</th>
              <th scope="col">What to do</th>
              <th scope="col">Last seen</th>
              <th scope="col">
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {report.noisyScreens.map((s) => (
              <tr>
                <td>
                  <a class="check-name" href={ui.url(`/ui/checks/${s.checkId}?filter=all`)}>
                    {s.name}
                  </a>{' '}
                  <Variant variant={s.variant} />
                </td>
                <td class="num" title="Flips per run in its last 20 runs">
                  {s.flakyScore === null ? '—' : `${Math.round(s.flakyScore * 100)}%`}
                </td>
                <td>
                  {s.noiseRejections === 0
                    ? '—'
                    : Object.entries(s.byReason)
                        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                        .map(([code, n]) => `${n}× ${NOISE_LABELS[code as NoiseReason].toLowerCase()}`)
                        .join(', ')}
                </td>
                <td>
                  <Pill tone="amber">{NOISE_LABELS[s.mainReason]}</Pill> <span class="muted">{s.action}</span>
                </td>
                <td>
                  <Ago at={s.lastSeen} />
                </td>
                <td>
                  {/* An area to ignore helps a screen that flips, dynamic data and late assets; a wait or no animations is test code. */}
                  {s.flakyScore !== null || s.mainReason === 'dynamic_data' || s.mainReason === 'late_asset' ? (
                    <a class="button small ignore-action" href={ui.url(`/ui/checks/${s.checkId}?filter=all`)}>
                      Ignore noisy area
                    </a>
                  ) : (
                    <a class="button small" href={ui.url(`/ui/checks/${s.checkId}?filter=all`)}>
                      Open check
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SlowTable({ ui, report }: { ui: Ui; report: InsightsReport }) {
  return (
    <section class="insights-section" aria-labelledby="slow-title">
      <div class="section-head">
        <h2 id="slow-title">Slowest screens</h2>
        <p class="muted">
          The server's compare time per screen. Screenshot and upload time are measured per run, in the chart above.
        </p>
      </div>
      {report.slowScreens.length === 0 ? (
        <div class="empty">
          <p>No checks in this range.</p>
        </div>
      ) : (
        <table class="stack-on-phone">
          <thead>
            <tr>
              <th scope="col">Screen</th>
              <th scope="col">Checks</th>
              <th scope="col">Compare, average</th>
              <th scope="col">Compare, slowest</th>
            </tr>
          </thead>
          <tbody>
            {report.slowScreens.map((s) => (
              <tr>
                <td>
                  <a class="check-name" href={ui.url(`/ui/checks/${s.checkId}?filter=all`)}>
                    {s.name}
                  </a>{' '}
                  <Variant variant={s.variant} />
                </td>
                <td class="num">{String(s.checks)}</td>
                <td class="num">{runText(s.compareMsAvg)}</td>
                <td class="num">{runText(s.compareMsMax)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ReviewersTable({ report }: { report: InsightsReport }) {
  return (
    <section class="insights-section" aria-labelledby="reviewers-title">
      <div class="section-head">
        <h2 id="reviewers-title">Reviewers</h2>
        <p class="muted">
          People and agents (project tokens): their decisions, how soon after the finalize, and agent suggestions.
        </p>
      </div>
      {report.reviewers.length === 0 ? (
        <div class="empty">
          <p>No one decided anything in this range.</p>
        </div>
      ) : (
        <table class="stack-on-phone">
          <thead>
            <tr>
              <th scope="col">Reviewer</th>
              <th scope="col">Decisions</th>
              <th scope="col">Median time</th>
              <th scope="col">Agent suggestions</th>
            </tr>
          </thead>
          <tbody>
            {report.reviewers.map((r) => {
              const decided = r.suggestionsAccepted + r.suggestionsDismissed;
              const suggestions =
                r.kind === 'token'
                  ? r.suggestionsMade === 0
                    ? '—'
                    : `${r.suggestionsMade} made · ${decided ? `${percent(r.acceptRate)} accepted` : 'none decided yet'}`
                  : decided === 0
                    ? '—'
                    : `${r.suggestionsAccepted} of ${decided} accepted`;
              return (
                <tr>
                  <td>
                    {r.name} {r.kind === 'token' && <Pill tone="blue">Agent</Pill>}
                  </td>
                  <td class="num">{`${r.decisions} (${r.approved} approved, ${r.rejected} rejected)`}</td>
                  <td class="num">{spanText(r.medianMs)}</td>
                  <td>{suggestions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Filters(props: { ui: Ui; project: Project; range: Range; branch: string; branches: string[] }) {
  const { ui, project } = props;
  const base = ui.url(`/ui/p/${project.slug}/insights`);
  const branches = [...new Set([project.mainBranch, ...props.branches, props.branch])];
  const query = (range: Range) =>
    `${base}?range=${range}${props.branch === project.mainBranch ? '' : `&branch=${encodeURIComponent(props.branch)}`}`;
  return (
    <form class="insights-filters" method="get" action={base} data-autosubmit="">
      <nav class="segmented" aria-label="Range">
        {RANGES.map((r) => (
          <a href={query(r)} aria-current={r === props.range ? 'page' : undefined} data-range={String(r)}>
            {`${r} days`}
          </a>
        ))}
      </nav>
      <input type="hidden" name="range" value={String(props.range)} />
      <label class="insights-branch">
        <span class="muted">Branch</span>
        <select name="branch">
          {branches.map((b) => (
            <option value={b} selected={b === props.branch}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <button class="small insights-apply" type="submit">
        Show
      </button>
    </form>
  );
}

function InsightsPage(props: {
  ui: Ui;
  project: Project;
  canManage: boolean;
  range: Range;
  span: InsightsRange;
  report: InsightsReport;
  buckets: InsightBucket[];
  branches: string[];
  notice?: string | undefined;
}) {
  const { ui, project, report } = props;
  const empty = report.totals.builds === 0;
  return (
    <Layout
      ui={ui}
      title={`${project.name} insights`}
      notice={props.notice}
      crumbs={[{ label: project.name, href: ui.url(`/ui/p/${project.slug}`) }, { label: 'Insights' }]}
      project={project.slug}
      canManage={props.canManage}
      islands={['charts']}
    >
      <div class="page-head">
        <div>
          <h1>{project.name}</h1>
        </div>
      </div>
      <ProjectTabs ui={ui} slug={project.slug} current="insights" canManage={props.canManage} />
      <Filters ui={ui} project={project} range={props.range} branch={report.branch} branches={props.branches} />
      <p class="muted insights-span">
        {`${short(props.span.fromDay)} – ${short(props.span.toDay)} · finalized builds on ${report.branch} · UTC days`}
      </p>
      <Tiles report={report} ui={ui} slug={project.slug} />
      {empty ? (
        <div class="empty insights-empty">
          <h3>No builds in this range</h3>
          <p class="muted">
            {`Nothing was finalized on ${report.branch} between ${dateOf(props.span.fromDay)} and ${dateOf(props.span.toDay)}. Pick a longer range or another branch.`}
          </p>
        </div>
      ) : (
        <Charts buckets={props.buckets} weekly={props.range === 90} />
      )}
      <NoisyTable ui={ui} report={report} />
      <SlowTable ui={ui} report={report} />
      <ReviewersTable report={report} />
      <p class="muted insights-note">
        {`The charts, tiles and reviewers outlive retention. The screen tables read the builds still kept (the last ${plural(report.retentionDays, 'day')}).`}
      </p>
    </Layout>
  );
}

export function registerInsightPages(app: OpenAPIHono<AppEnv>, s: Services): void {
  app.get('/ui/p/:slug/insights', async (c) => {
    const ui = uiOf(c, s);
    const { project, access } = await visibleProject(c, s.deps, c.req.param('slug'), 'project.read');
    const asked = Number(c.req.query('range'));
    const range: Range = (RANGES as readonly number[]).includes(asked) ? (asked as Range) : 30;
    const span = rangeOf(project, { days: range, branch: c.req.query('branch') });
    const report = await getInsights(s.deps, project, span);
    const [buckets, branches] = await Promise.all([
      insightBuckets(s.deps, project.id, span, range === 90 ? 7 : 1),
      insightBranches(s.deps, project.id),
    ]);
    return c.html(
      <InsightsPage
        ui={ui}
        project={project}
        canManage={access.can('project.admin')}
        range={range}
        span={span}
        report={report}
        buckets={buckets}
        branches={branches}
        notice={noticeOf(c)}
      />,
    );
  });
}
