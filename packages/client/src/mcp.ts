// `pixeltwin mcp`: a Model Context Protocol server on stdio, so an agent (Claude Code, Cursor, …)
// can read what changed in a build, look at the screenshots and approve or reject with a reason.
// A small JSON-RPC 2.0 loop of its own instead of @modelcontextprotocol/sdk: this package has no
// dependencies, and a few tools over stdio need only initialize, tools/list, tools/call and ping.
import { createInterface } from 'node:readline';
import { PixeltwinClient, SDK_VERSION } from './client.js';
import { PixeltwinError, PixeltwinNetworkError } from './errors.js';
import { crop, decodePng, encodePng, shrink } from './png-image.js';
import { isRejectReason, REJECT_REASON_INFO, REJECT_REASONS, type RejectReason, TOO_EARLY } from './reasons.js';
import { gitBranch } from './run.js';
import type {
  Build,
  ChangeGroup,
  Check,
  Diff,
  ElementChange,
  Flaky,
  Rect,
  RejectionPatterns,
  ScreenRejections,
} from './types.js';

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

/** Protocol versions this server speaks, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** An image's longest side after shrinking: what vision models take in without scaling it themselves. */
const MAX_EDGE = 1568;
/** Members of a change group listed by list_changes; the rest are counted. */
const MAX_MEMBERS = 8;
/** Element changes listed per check by list_changes. */
const MAX_CHANGES = 10;

const INSTRUCTIONS = `pixeltwin compares screenshots of a web app with approved baselines.
Workflow after changing UI code: latest_build (your branch) → list_changes (what changed, element by
element) → get_check or get_check_images (look closer; crop to a change to save tokens) → decide
whether each change is what you meant to do → approve_check or reject_check with a reason. Reject or
leave for a person anything you did not intend. list_changes lists a change group (the same change on
several screens) once with one representative check: judge the representative and decide the whole
group at once with review_group. A check marked flaky is on a screen that keeps flipping by itself, so
its change is likely noise. A project may record your review as a suggestion that a person accepts;
the answer says so.
Learn from earlier rejections: list_changes and get_check carry a screen's recent rejections
(category, comment, who, when) and a hint; rejection_patterns sums them up for the project. Read them
before deciding, and fix the test rather than the page when they say so: not_loaded or late_asset
(captured too early: wait for network idle or the element, images, fonts), animation (disable
animations, or retakes), dynamic_data (fix the data or add an ignore area), environment (pin the
browser, OS, viewport), real_bug (a real regression: fix the code). Rejecting, always give a reasonCode
from these, plus other.`;

interface Content {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content: Content[];
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run(args: Json): Promise<ToolResult>;
}

class ToolError extends Error {}

const text = (value: string): Content => ({ type: 'text', text: value });
const json = (value: unknown): Content => text(JSON.stringify(value, null, 2));

/** Groups and flaky screens are newer than the rest of the API: an older server answers 404. */
async function optional<T>(call: Promise<T>, missing: T): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof PixeltwinError && err.status === 404) return missing;
    throw err;
  }
}

const rectSchema = {
  type: 'object',
  properties: {
    x: { type: 'integer', minimum: 0 },
    y: { type: 'integer', minimum: 0 },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
};

function str(args: Json, key: string, required: true): string;
function str(args: Json, key: string, required?: false): string | undefined;
function str(args: Json, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new ToolError(`"${key}" is required.`);
  return undefined;
}

function int(args: Json, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function rectOf(value: unknown): Rect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' ? Math.round(r[k] as number) : Number.NaN);
  const rect = { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
  if (Object.values(rect).some((v) => !Number.isFinite(v)) || rect.width < 1 || rect.height < 1) {
    throw new ToolError('A rectangle needs whole numbers x, y, width and height (width and height at least 1).');
  }
  return rect;
}

const diffOf = (check: Check): Diff | null => (check.diff && 'percent' in check.diff ? check.diff : null);

function variantText(variant: Record<string, string>): string {
  const parts = Object.entries(variant).map(([k, v]) => `${k}=${v}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** What an agent needs of a change: what, where, and the boxes to crop to. */
function changeView(change: ElementChange, index: number) {
  return {
    index,
    kind: change.kind,
    key: change.key,
    description: change.description,
    ...(change.from ? { from: change.from } : {}),
    ...(change.to ? { to: change.to } : {}),
    ...(change.text ? { text: change.text } : {}),
    ...(change.style ? { style: change.style } : {}),
  };
}

/** The smallest rectangle around a change's boxes, or a region. */
function around(boxes: Array<Rect | null | undefined>): Rect | undefined {
  const present = boxes.filter((b): b is Rect => !!b);
  if (present.length === 0) return undefined;
  const x = Math.min(...present.map((b) => b.x));
  const y = Math.min(...present.map((b) => b.y));
  const right = Math.max(...present.map((b) => b.x + b.width));
  const bottom = Math.max(...present.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function grow(rect: Rect, by: number): Rect {
  return {
    x: Math.max(0, rect.x - by),
    y: Math.max(0, rect.y - by),
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rejections of a screen listed per check by list_changes (get_check lists up to 5). */
const LIST_REJECTIONS = 3;

const REASON_CODE_SCHEMA = {
  type: 'string',
  enum: [...REJECT_REASONS],
  description:
    'Why it is wrong: not_loaded (captured before the page or content finished loading), late_asset (an image, banner, font or ad loaded late), animation (caught mid-animation), dynamic_data (dates, prices, random content), environment (browser, OS, rendering or viewport difference), real_bug (a real regression), other',
};

/** A screen's earlier rejections as an agent reads them: counts, the hint, the last few. */
function rejectionsView(screen: ScreenRejections | undefined, limit: number) {
  if (!screen) return undefined;
  return {
    count: screen.count,
    byCategory: screen.byCategory,
    hint: screen.hint,
    recent: screen.recent.slice(0, limit).map((r) => ({
      reasonCode: r.reasonCode,
      reason: r.reason,
      by: whoOf(r.by.kind, r.by.id, r.by.name),
      build: `#${r.buildNumber} on ${r.branch}`,
      at: new Date(r.at).toISOString(),
    })),
  };
}

function whoOf(kind: string, id: string, name: string | null): string {
  if (kind === 'token') return `agent (token "${name ?? id}")`;
  if (kind === 'auto') return 'auto-approve';
  return `person (${id})`;
}

/** The sentence an approval gets when its screen was rejected before as captured too early. */
function tooEarlyWarning(screen: ScreenRejections | undefined): string {
  if (!screen || screen.tooEarly === 0) return '';
  const early = TOO_EARLY.filter((code) => screen.byCategory[code])
    .map((code) => `${screen.byCategory[code]}× ${code}`)
    .join(', ');
  return `Careful: this screen was rejected before as captured too early (${early}); make sure the change is not a loading artefact (a blank image, a spinner, a missing font) before you rely on this approval.`;
}

/** A check as list_changes shows it: summary, element changes, review state. */
function changeItem(check: Check, url: string, flaky: Flaky | undefined, rejected?: ScreenRejections) {
  const diff = diffOf(check);
  return {
    checkId: check.id,
    name: `${check.name}${variantText(check.variant)}`,
    result: check.result,
    review: check.review,
    ...(flaky ? { flakyScore: flaky.score } : {}),
    ...(diff ? { percent: diff.percent, summary: diff.summary } : {}),
    ...(diff?.changes
      ? {
          changes: diff.changes.slice(0, MAX_CHANGES).map(changeView),
          ...(diff.changes.length > MAX_CHANGES || diff.changesTruncated ? { moreChanges: true } : {}),
        }
      : {}),
    ...(diff ? { regions: diff.regions.length } : {}),
    ...(check.suggestion ? { suggestion: check.suggestion } : {}),
    ...(rejected ? { rejections: rejectionsView(rejected, LIST_REJECTIONS) } : {}),
    url,
  };
}

/** The reasonCode argument; rejecting needs one (an isError answer otherwise). */
function reasonCodeOf(args: Json, required: boolean): RejectReason | undefined {
  const value = args.reasonCode;
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ToolError(
        `"reasonCode" is required to reject: one of ${REJECT_REASONS.join(', ')}. It is how people and later runs learn why the screen was wrong.`,
      );
    }
    return undefined;
  }
  if (!isRejectReason(value)) throw new ToolError(`"reasonCode" is one of ${REJECT_REASONS.join(', ')}.`);
  return value;
}

function errorText(err: unknown): string {
  if (err instanceof ToolError || err instanceof PixeltwinError || err instanceof PixeltwinNetworkError)
    return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The tools, bound to a client and project. */
export function tools(client: PixeltwinClient | null, project: string, env: Env, cwd = process.cwd()): Tool[] {
  const need = (): PixeltwinClient => {
    if (!client || !project) {
      throw new ToolError(
        "pixeltwin is not configured: set PIXELTWIN_URL, PIXELTWIN_TOKEN (a project token with read, and review to approve) and PIXELTWIN_PROJECT in the MCP server's environment.",
      );
    }
    return client;
  };
  const absolute = (path: string) => `${need().url}${path}`;
  const buildSummary = (build: Build) => ({
    id: build.id,
    number: build.number,
    branch: build.branch,
    state: build.state,
    verdict: build.verdict,
    counts: {
      total: build.counts.total,
      changed: build.counts.result.changed,
      new: build.counts.result.new,
      errors: build.counts.result.error,
      waitingForReview: build.counts.review.pending,
      rejected: build.counts.review.rejected,
      agentSuggestions: build.counts.suggested,
    },
    createdAt: new Date(build.createdAt).toISOString(),
    url: need().buildUrl(build.id),
  });

  /** The newest build of the branch: the argument, else PIXELTWIN_BRANCH or the checked-out branch, else any. */
  const latest = async (branch: string | undefined): Promise<{ build: Build | null; note: string }> => {
    const c = need();
    const wanted = branch ?? (env.PIXELTWIN_BRANCH?.trim() || gitBranch(cwd));
    if (wanted) {
      const [build] = (await c.listBuilds(project, { branch: wanted, limit: 1 })).items;
      if (build || branch) return { build: build ?? null, note: build ? '' : `No builds on branch "${wanted}" yet.` };
    }
    const [any] = (await c.listBuilds(project, { limit: 1 })).items;
    const note = wanted ? `No builds on branch "${wanted}"; this is the newest build of the project.` : '';
    return { build: any ?? null, note: any ? note : 'The project has no builds yet.' };
  };

  const checkUrl = (check: Check) => absolute(check.links.review);

  return [
    {
      name: 'latest_build',
      description:
        "The newest pixeltwin build of a branch with its verdict (passed, pending, rejected, error…) and counts of changed, new and waiting checks. Without `branch`, the checked-out git branch (or PIXELTWIN_BRANCH); when it has no builds, the project's newest build. Start here after a test run.",
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string', description: 'Branch name, e.g. feature/login' } },
        additionalProperties: false,
      },
      async run(args) {
        const { build, note } = await latest(str(args, 'branch'));
        if (!build) return { content: [text(note)] };
        return { content: [...(note ? [text(note)] : []), json(buildSummary(build))] };
      },
    },
    {
      name: 'list_changes',
      description:
        "What changed in a build: the checks that differ from their baselines (changed) or have none yet (new), each with its one-sentence summary and its element changes (moved, resized, text, style, added, removed, with the element's key such as [data-testid=submit] and its boxes in screenshot pixels), its review state and any agent suggestion. Checks with exactly the same changes (a header changed on 40 screens) come once as a change group: its members by name (with their review state unless pending) and one representative check with the summary and changes they share; judge the representative and decide the group with review_group. `flakyScore` (0 to 1) marks a check whose screen keeps flipping by itself: its change is likely noise. `rejections` (and `rejectedBefore` on group members) are the screen's earlier rejections with their category, comment, who and when, and a hint on what to do: read them before deciding. Defaults to the latest build of the branch.",
      inputSchema: {
        type: 'object',
        properties: {
          buildId: { type: 'string', description: 'A build id (bld_…); default: the latest build of `branch`' },
          branch: { type: 'string', description: 'Used when buildId is missing' },
        },
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        let buildId = str(args, 'buildId');
        let note = '';
        if (!buildId) {
          const found = await latest(str(args, 'branch'));
          if (!found.build) return { content: [text(found.note)] };
          buildId = found.build.id;
          note = found.note;
        }
        const build = await c.getBuild(buildId);
        const checks: Check[] = [];
        for (const result of ['changed', 'new'] as const) {
          let cursor: string | undefined;
          do {
            const page = await c.listChecks(buildId, { result, limit: 200, ...(cursor ? { cursor } : {}) });
            checks.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
        }
        const [groups, noisy, rejections] = await Promise.all([
          optional(c.listGroups(buildId), []),
          optional(c.noisyScreens(project), []),
          optional(c.buildRejections(buildId), null),
        ]);
        const rejectedByScreen = new Map((rejections?.screens ?? []).map((r) => [r.snapshotKey, r]));
        const flakyByScreen = new Map(
          noisy.filter((n) => n.branch === build.branch && n.flaky).map((n) => [n.snapshotKey, n.flaky as Flaky]),
        );
        const byId = new Map(checks.map((check) => [check.id, check]));
        const flakyOf = (id: string) => {
          const check = byId.get(id);
          return check ? flakyByScreen.get(check.snapshotKey) : undefined;
        };
        const grouped = new Set<string>();
        const groupItems = groups.flatMap((group: ChangeGroup) => {
          const members = group.checks.filter((m) => byId.has(m.id));
          if (members.length < 2) return [];
          for (const m of members) grouped.add(m.id);
          // The representative: a member that still waits for review, else the newest one.
          const representative = byId.get(
            (members.find((m) => m.review === 'pending') ?? members[0])?.id ?? '',
          ) as Check;
          const shown = members.slice(0, MAX_MEMBERS);
          return [
            {
              groupId: group.id,
              size: members.length,
              review: Object.fromEntries(Object.entries(group.counts).filter(([, n]) => n > 0)),
              members: shown.map((m) => {
                const flaky = flakyOf(m.id);
                const rejected = rejectedByScreen.get(byId.get(m.id)?.snapshotKey ?? '');
                return {
                  checkId: m.id,
                  name: `${m.name}${variantText(m.variant)}`,
                  // Pending is what the group's counts say of most members; only the others say so.
                  ...(m.review === 'pending' ? {} : { review: m.review }),
                  ...(flaky ? { flakyScore: flaky.score } : {}),
                  ...(m.suggestion ? { suggestion: m.suggestion } : {}),
                  ...(rejected ? { rejectedBefore: rejected.hint } : {}),
                };
              }),
              ...(members.length > shown.length ? { moreMembers: `+${members.length - shown.length} more` } : {}),
              representative: changeItem(
                representative,
                checkUrl(representative),
                flakyOf(representative.id),
                rejectedByScreen.get(representative.snapshotKey),
              ),
            },
          ];
        });
        const single = checks
          .filter((check) => !grouped.has(check.id))
          .map((check) =>
            changeItem(
              check,
              checkUrl(check),
              flakyByScreen.get(check.snapshotKey),
              rejectedByScreen.get(check.snapshotKey),
            ),
          );
        const flakyCount = checks.filter((check) => flakyByScreen.has(check.snapshotKey)).length;
        const rejectedCount = checks.filter((check) => rejectedByScreen.has(check.snapshotKey)).length;
        const head = [
          `Build #${build.number} on ${build.branch}: verdict ${build.verdict}; ${plural(checks.length, 'changed or new check')}`,
          groupItems.length
            ? `: ${plural(groupItems.length, 'change group')} of ${plural(grouped.size, 'check')} (each member has the same changes as its representative: judge it once, decide with review_group) and ${single.length} on ${single.length === 1 ? 'its' : 'their'} own.`
            : '.',
          flakyCount ? ` ${plural(flakyCount, 'check')} on flaky screens (flakyScore): likely noise.` : '',
          rejectedCount
            ? ` ${plural(rejectedCount, 'check')} on screens rejected before (rejections, rejectedBefore): read why before deciding.`
            : '',
        ].join('');
        return {
          content: [text([note, head].filter(Boolean).join(' ')), json({ groups: groupItems, checks: single })],
        };
      },
    },
    {
      name: 'get_check',
      description:
        'Everything about one check: result, review state, diff percent and summary, every element change, the changed regions (boxes in screenshot pixels), any agent suggestion, its change group (id and size), whether its screen is flaky (score, flips, the unstable area: likely noise), the review history (who approved or rejected, why and the rejection category), the recent rejections of the same screen on any branch (category, comment, who, when) with a hint on what to do, and links to the images and the review page.',
      inputSchema: {
        type: 'object',
        properties: { checkId: { type: 'string', description: 'A check id (chk_…)' } },
        required: ['checkId'],
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        const check = await c.getCheck(str(args, 'checkId', true));
        const [history, screen, groups, rejections] = await Promise.all([
          c.listReviews(check.id),
          optional(c.checkHistory(check.id), null),
          check.groupId ? optional(c.listGroups(check.buildId), []) : Promise.resolve([]),
          optional(c.rejectionPatterns(project, { snapshotKey: check.snapshotKey }), null),
        ]);
        const rejected = rejections?.screens.find((r) => r.snapshotKey === check.snapshotKey);
        const group = groups.find((g) => g.id === check.groupId);
        const diff = diffOf(check);
        return {
          content: [
            json({
              checkId: check.id,
              buildId: check.buildId,
              name: check.name,
              variant: check.variant,
              result: check.result,
              review: check.review,
              baseline: check.baseline ? { branch: check.baseline.branch, fallback: check.baseline.fallback } : null,
              diff: diff
                ? {
                    percent: diff.percent,
                    summary: diff.summary,
                    dimensions: diff.dimensions,
                    changes: diff.changes?.map(changeView) ?? null,
                    regions: diff.regions,
                    regionsTruncated: diff.regionsTruncated,
                  }
                : check.diff,
              elementCount: check.elementCount,
              suggestion: check.suggestion,
              reviewComment: check.reviewComment,
              ...(check.reviewReasonCode ? { reviewReasonCode: check.reviewReasonCode } : {}),
              group: group ? { groupId: group.id, size: group.size } : null,
              flaky: screen?.flaky
                ? { score: screen.flaky.score, flips: screen.flaky.flips, unstableArea: screen.flaky.unstableArea }
                : null,
              history: history.slice(0, 20).map((e) => ({
                action: e.action,
                by: whoOf(e.actorKind, e.actor, e.actorName),
                reason: e.comment,
                ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}),
                at: new Date(e.createdAt).toISOString(),
              })),
              rejections: rejectionsView(rejected, 5) ?? null,
              links: {
                review: checkUrl(check),
                image: absolute(check.links.image),
                baseline: check.links.baseline ? absolute(check.links.baseline) : null,
                diff: check.links.diff ? absolute(check.links.diff) : null,
              },
            }),
          ],
        };
      },
    },
    {
      name: 'get_check_images',
      description:
        "The check's screenshots as images: the baseline, the new screenshot (current) and the diff (changed pixels in red). Crop to save tokens: `change` (an index from list_changes or get_check) crops all three to that element change, `region` to a rectangle in screenshot pixels; `padding` adds room around it. Large images are shrunk to at most 1568 px on their longest side.",
      inputSchema: {
        type: 'object',
        properties: {
          checkId: { type: 'string', description: 'A check id (chk_…)' },
          images: {
            type: 'array',
            items: { type: 'string', enum: ['baseline', 'current', 'diff'] },
            description: 'Which images; default all that exist',
          },
          change: {
            type: 'integer',
            minimum: 0,
            description: "Crop to this element change (index into the diff's changes)",
          },
          region: { ...rectSchema, description: 'Crop to this rectangle (screenshot pixels)' },
          padding: { type: 'integer', minimum: 0, maximum: 500, description: 'Pixels around the crop; default 24' },
        },
        required: ['checkId'],
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        const check = await c.getCheck(str(args, 'checkId', true));
        const diff = diffOf(check);
        let area = rectOf(args.region);
        const changeIndex = int(args, 'change');
        if (changeIndex !== undefined) {
          const change = diff?.changes?.[changeIndex];
          if (!change) throw new ToolError(`Check ${check.id} has no element change ${changeIndex}.`);
          area = around([change.from, change.to]);
        }
        if (area) area = grow(area, int(args, 'padding') ?? 24);
        const wanted =
          Array.isArray(args.images) && args.images.length > 0
            ? args.images.map(String)
            : ['baseline', 'current', 'diff'];
        const links: Record<string, string | null> = {
          baseline: check.links.baseline,
          current: check.links.image,
          diff: check.links.diff,
        };
        const content: Content[] = [];
        for (const which of ['baseline', 'current', 'diff']) {
          const link = links[which];
          if (!wanted.includes(which) || !link) continue;
          const png = await c.fetchImage(link);
          const notes: string[] = [];
          let out = png;
          const decoded = decodePng(png);
          if (decoded) {
            let image = decoded;
            if (area) {
              const part = crop(image, area);
              if (part) {
                image = part;
                notes.push(`cropped to x ${area.x}, y ${area.y}, ${part.width}×${part.height}`);
              } else notes.push('the crop is outside this image; showing all of it');
            }
            const factor = Math.ceil(Math.max(image.width, image.height) / MAX_EDGE);
            if (factor > 1) {
              image = shrink(image, factor);
              notes.push(`shrunk to 1/${factor}`);
            }
            if (image !== decoded) out = encodePng(image);
          } else if (area) notes.push('this PNG cannot be cropped here; showing all of it');
          content.push(text(`${which}${notes.length ? ` (${notes.join(', ')})` : ''}:`));
          content.push({ type: 'image', data: Buffer.from(out).toString('base64'), mimeType: 'image/png' });
        }
        if (content.length === 0) return { content: [text(`Check ${check.id} has none of the images asked for.`)] };
        return { content };
      },
    },
    ...(['approve', 'reject'] as const).map(
      (action): Tool => ({
        name: `${action}_check`,
        description:
          action === 'approve'
            ? "Approve a check: its screenshot becomes the baseline. Give a reason (what you changed and why this change is intended); it is kept in the review history. If the project reviews agents' decisions, the approval is recorded as a suggestion that a person accepts or dismisses; the answer says which happened, and warns when the screen was rejected before as captured too early (a loading artefact)."
            : "Reject a check: the change is wrong. Give a reasonCode (the category: not_loaded, late_asset, animation, dynamic_data, environment, real_bug, other) and a reason (what is wrong); both are kept in the review history, and later runs and people learn from them. If the project reviews agents' decisions, the rejection may be recorded as a suggestion instead; the answer says which happened.",
        inputSchema: {
          type: 'object',
          properties: {
            checkId: { type: 'string', description: 'A check id (chk_…)' },
            ...(action === 'reject' ? { reasonCode: REASON_CODE_SCHEMA } : {}),
            reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'Why, in a sentence or two' },
          },
          required: action === 'reject' ? ['checkId', 'reasonCode', 'reason'] : ['checkId', 'reason'],
          additionalProperties: false,
        },
        async run(args) {
          const c = need();
          const checkId = str(args, 'checkId', true);
          const reason = str(args, 'reason', true);
          const reasonCode = action === 'reject' ? reasonCodeOf(args, true) : undefined;
          const reviewed = await c.review(checkId, action, { reason, ...(reasonCode ? { reasonCode } : {}) });
          const done = action === 'approve' ? 'approved' : 'rejected';
          const line =
            reviewed.outcome === 'suggested'
              ? `Recorded as a suggestion to ${action}: this project has a person decide on agents' reviews. The check stays ${reviewed.review} until someone accepts or dismisses it at ${checkUrl(reviewed)}.`
              : `Applied: the check is ${done}. ${checkUrl(reviewed)}`;
          let warning = '';
          if (action === 'approve') {
            const patterns = await optional(c.rejectionPatterns(project, { snapshotKey: reviewed.snapshotKey }), null);
            warning = tooEarlyWarning(patterns?.screens.find((r) => r.snapshotKey === reviewed.snapshotKey));
          }
          return {
            content: [
              text(line),
              ...(warning ? [text(warning)] : []),
              json({ checkId: reviewed.id, outcome: reviewed.outcome, review: reviewed.review }),
            ],
          };
        },
      }),
    ),
    {
      name: 'review_group',
      description:
        "Approve or reject a whole change group at once (a groupId from list_changes): every member that waits for review, or only `checkIds`. The members share exactly the same change, so looking at one representative (get_check, get_check_images) is enough. Give a reason (what you changed and why it is intended, or what is wrong) and, rejecting, a reasonCode; they are kept on each review. Members already reviewed or outdated are skipped. If the project reviews agents' decisions, some or all members are recorded as suggestions that a person accepts or dismisses; the answer says which applied, which became suggestions and the build's new verdict.",
      inputSchema: {
        type: 'object',
        properties: {
          buildId: { type: 'string', description: 'The build id (bld_…)' },
          groupId: { type: 'string', description: 'The change group id, from list_changes or get_check' },
          action: { type: 'string', enum: ['approve', 'reject'] },
          reasonCode: {
            ...REASON_CODE_SCHEMA,
            description: `Rejecting (required then): ${REASON_CODE_SCHEMA.description}`,
          },
          reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'Why, in a sentence or two' },
          checkIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Only these members (check ids); default all',
          },
        },
        required: ['buildId', 'groupId', 'action', 'reason'],
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        const buildId = str(args, 'buildId', true);
        const groupId = str(args, 'groupId', true);
        const action = str(args, 'action', true);
        if (action !== 'approve' && action !== 'reject') throw new ToolError('"action" is approve or reject.');
        const reason = str(args, 'reason', true);
        const reasonCode = reasonCodeOf(args, action === 'reject');
        if (reasonCode && action === 'approve') throw new ToolError('"reasonCode" goes with a rejection only.');
        const checkIds =
          Array.isArray(args.checkIds) && args.checkIds.length > 0 ? args.checkIds.map(String) : undefined;
        const result = await c.reviewGroup(buildId, groupId, action, {
          reason,
          ...(reasonCode ? { reasonCode } : {}),
          ...(checkIds ? { checkIds } : {}),
        });
        const done = action === 'approve' ? 'approved' : 'rejected';
        const asked = checkIds ? new Set(checkIds) : null;
        const left = result.skipped.filter((s) => !asked || asked.has(s.checkId));
        const notAsked = result.skipped.length - left.length;
        const lines: string[] = [];
        if (result.changed.length) lines.push(`Applied: ${plural(result.changed.length, 'check')} ${done}.`);
        if (result.suggested.length) {
          const one = result.suggested.length === 1;
          lines.push(
            `Recorded as a suggestion to ${action} for ${plural(result.suggested.length, 'check')}: this project has a person decide on agents' reviews. ${one ? 'It stays' : 'They stay'} pending until someone accepts or dismisses ${one ? 'it' : 'them'} at ${c.buildUrl(buildId)}.`,
          );
        }
        if (!result.changed.length && !result.suggested.length) {
          lines.push('Nothing changed: no member asked for waits for review.');
        }
        if (left.length) {
          const states = new Map<string, number>();
          for (const s of left) states.set(s.review, (states.get(s.review) ?? 0) + 1);
          const counts = [...states].map(([state, n]) => `${n} ${state}`).join(', ');
          lines.push(
            `Skipped ${plural(left.length, 'check')}, left as ${left.length === 1 ? 'it was' : 'they were'} (${counts}).`,
          );
        }
        if (notAsked) {
          lines.push(
            `${plural(notAsked, 'other member')} not in checkIds left as ${notAsked === 1 ? 'it was' : 'they were'}.`,
          );
        }
        lines.push(`The build's verdict is now ${result.verdict}.`);
        const warnings: string[] = [];
        if (action === 'approve' && (result.changed.length || result.suggested.length)) {
          const decided = new Set([...result.changed, ...result.suggested]);
          const patterns = await optional(c.buildRejections(buildId), null);
          const early = (patterns?.screens ?? []).filter((r) => r.checkId && decided.has(r.checkId) && r.tooEarly > 0);
          if (early.length) {
            warnings.push(
              `Careful: ${plural(early.length, 'screen')} of this group ${early.length === 1 ? 'was' : 'were'} rejected before as captured too early (${early.map((r) => `${r.name}: ${r.tooEarly}×`).join(', ')}); make sure the change is not a loading artefact before you rely on this approval.`,
            );
          }
        }
        return {
          content: [
            text(lines.join(' ')),
            ...warnings.map(text),
            json({
              groupId: result.group.id,
              applied: result.changed,
              suggested: result.suggested,
              skipped: left,
              verdict: result.verdict,
            }),
          ],
        };
      },
    },
    {
      name: 'rejection_patterns',
      description:
        "Why this project's screens were rejected, so you can learn before deciding and fix the test code: counts per category (not_loaded, late_asset, animation, dynamic_data, environment, real_bug, other, uncategorized) with what each means and what to do, and per screen (the most recently rejected first) with counts, a hint and the last rejections (category, comment, who, when). Optionally on one `branch`, for one screen (`checkId` of any of its checks, or `snapshotKey`). Read it before judging a build, and when a screen keeps being rejected as not_loaded or late_asset add a wait to the test; dynamic_data needs an ignore area; animation needs animations off or retakes.",
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Only rejections on builds of this branch; default every branch' },
          checkId: { type: 'string', description: 'Only the screen of this check (chk_…)' },
          snapshotKey: { type: 'string', description: 'Only this screen (a check’s snapshotKey)' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rejections to look at, newest first' },
        },
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        const checkId = str(args, 'checkId');
        const snapshotKey = checkId ? (await c.getCheck(checkId)).snapshotKey : str(args, 'snapshotKey');
        const branch = str(args, 'branch');
        const limit = int(args, 'limit');
        let patterns: RejectionPatterns;
        try {
          patterns = await c.rejectionPatterns(project, {
            ...(branch ? { branch } : {}),
            ...(snapshotKey ? { snapshotKey } : {}),
            ...(limit ? { limit } : {}),
          });
        } catch (err) {
          if (err instanceof PixeltwinError && err.status === 404 && err.code !== 'project_not_found') {
            throw new ToolError('This pixeltwin server does not keep rejection reasons yet; update it.');
          }
          throw err;
        }
        const where = [branch ? `on ${branch}` : 'on every branch', snapshotKey ? 'for this screen' : ''];
        if (patterns.total === 0) {
          return { content: [text(`No rejections ${where.filter(Boolean).join(' ')}.`)] };
        }
        const top = patterns.categories
          .slice(0, 3)
          .map((cat) => `${cat.count}× ${cat.code}`)
          .join(', ');
        const head = `${plural(patterns.total, 'rejection')} ${where.filter(Boolean).join(' ')} on ${plural(patterns.screens.length, 'screen')}; most often ${top}.`;
        const tips = patterns.screens
          .filter((sc) => sc.top && sc.top !== 'real_bug' && sc.top !== 'other')
          .slice(0, 5)
          .map((sc) => `${sc.name}${variantText(sc.variant)}: ${sc.hint}`);
        return {
          content: [
            text([head, ...tips].join('\n')),
            json({
              total: patterns.total,
              categories: patterns.categories.map((cat) => ({
                ...cat,
                lastAt: new Date(cat.lastAt).toISOString(),
                ...(cat.code === 'uncategorized'
                  ? { meaning: 'rejected without a category' }
                  : { meaning: REJECT_REASON_INFO[cat.code].meaning, act: REJECT_REASON_INFO[cat.code].act }),
              })),
              screens: patterns.screens.map((sc) => ({
                name: `${sc.name}${variantText(sc.variant)}`,
                snapshotKey: sc.snapshotKey,
                count: sc.count,
                byCategory: sc.byCategory,
                hint: sc.hint,
                recent: rejectionsView(sc, 5)?.recent ?? [],
                lastAt: new Date(sc.lastAt).toISOString(),
              })),
            }),
          ],
        };
      },
    },
    {
      name: 'add_ignore_area',
      description:
        "Never compare a part of this screen again (a clock, an ad, random data): an ignore area on the check's snapshot, for every later check of it on every branch. Give a rectangle in screenshot pixels, or `change` (an element change index) or `regionIndex` (a changed region) to cover it. The check is compared again at once. Not for hiding a real change: approve or reject that instead.",
      inputSchema: {
        type: 'object',
        properties: {
          checkId: { type: 'string', description: 'A check id (chk_…)' },
          rect: { ...rectSchema, description: 'The area, screenshot pixels' },
          change: {
            type: 'integer',
            minimum: 0,
            description: "Cover this element change (index into the diff's changes)",
          },
          regionIndex: {
            type: 'integer',
            minimum: 0,
            description: "Cover this changed region (index into the diff's regions)",
          },
        },
        required: ['checkId'],
        additionalProperties: false,
      },
      async run(args) {
        const c = need();
        const check = await c.getCheck(str(args, 'checkId', true));
        const diff = diffOf(check);
        let rect = rectOf(args.rect);
        const change = int(args, 'change');
        const region = int(args, 'regionIndex');
        if (!rect && change !== undefined) {
          const found = diff?.changes?.[change];
          if (!found) throw new ToolError(`Check ${check.id} has no element change ${change}.`);
          rect = around([found.from, found.to]);
        }
        if (!rect && region !== undefined) {
          const found = diff?.regions[region];
          if (!found) throw new ToolError(`Check ${check.id} has no changed region ${region}.`);
          rect = { x: found.x, y: found.y, width: found.width, height: found.height };
        }
        if (!rect) throw new ToolError('Give `rect`, `change` or `regionIndex`.');
        const { area, check: after } = await c.addIgnoreArea(check.id, grow(rect, 4));
        const afterDiff = diffOf(after);
        return {
          content: [
            text(
              `Ignore area ${area.width}×${area.height} at (${area.x},${area.y}) added. The check is now ${after.result}${afterDiff ? `: ${afterDiff.summary}` : ''}`,
            ),
            json({ areaId: area.id, checkId: after.id, result: after.result, review: after.review }),
          ],
        };
      },
    },
  ];
}

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

/** Answers one JSON-RPC message; null for a notification. */
export async function handle(message: Request, toolList: Tool[]): Promise<Json | null> {
  const isRequest = message.id !== undefined && message.id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code, message: msg },
  });
  if (typeof message.method !== 'string') return isRequest ? fail(-32600, 'Invalid request') : null;
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, …
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pixeltwin', version: SDK_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: toolList.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = toolList.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Json) : {};
      try {
        return reply(await tool.run(args));
      } catch (err) {
        // A failed call is a result the agent reads (MCP), not a protocol error.
        return reply({ content: [text(errorText(err))], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

/**
 * Serves MCP on stdin and stdout until stdin closes. Configured like the test run:
 * PIXELTWIN_URL, PIXELTWIN_TOKEN, PIXELTWIN_PROJECT (and PIXELTWIN_BRANCH). Logs go to stderr.
 */
export async function serveMcp(
  env: Env = process.env,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<number> {
  const url = env.PIXELTWIN_URL?.trim() || 'http://localhost:8080';
  const token = env.PIXELTWIN_TOKEN?.trim() ?? '';
  const project = env.PIXELTWIN_PROJECT?.trim() ?? '';
  const client = token ? new PixeltwinClient({ url, token, retries: 1 }) : null;
  if (!client || !project) {
    console.error('pixeltwin mcp: PIXELTWIN_TOKEN and PIXELTWIN_PROJECT are not set; every tool will say so.');
  }
  const toolList = tools(client, project, env);
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY });
  const write = (message: unknown) => io.output.write(`${JSON.stringify(message)}\n`);
  const pending: Promise<void>[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Requests run concurrently (an image download need not hold up a ping); each answers by id.
    const work = (async () => {
      if (Array.isArray(parsed)) {
        const answers = (await Promise.all(parsed.map((m) => handle(m as Request, toolList)))).filter(Boolean);
        if (answers.length > 0) write(answers);
      } else {
        const answer = await handle(parsed as Request, toolList);
        if (answer) write(answer);
      }
    })();
    pending.push(work);
  }
  await Promise.all(pending);
  return 0;
}
