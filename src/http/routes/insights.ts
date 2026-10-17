import { type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  digestSettingsSchema,
  getDigestSettings,
  sendDigestNow,
  serverTimeZone,
  updateDigestSettings,
} from '../../domain/insights-digest';
import { getInsights, MAX_RANGE_DAYS, rangeOf } from '../../domain/insights-report';
import { getProjectBySlug } from '../../domain/projects';
import { branchSchema } from '../../domain/schemas';
import { API, type AppEnv, type Services } from '../env';
import { defineRoute } from '../route';
import { DigestSettingsSchema, InsightsSchema, json, problems } from '../schemas';

const date = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({ description, example: '2026-10-17' });

export function registerInsightRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  const insights = defineRoute('project.read', {
    method: 'get',
    path: `${API}/projects/{slug}/insights`,
    tags: ['insights'],
    summary: "How healthy the project's visual tests are on a branch: auto-pass rate, review load and noise",
    description:
      'Daily numbers of the finalized builds of a branch over a range of UTC days (they outlive retention): ' +
      'how many checks passed by themselves, how many a person or agent had to decide and how fast, why ' +
      'rejections were made (not_loaded, late_asset, animation and dynamic_data are noise from the test, ' +
      'real_bug a regression), what agent suggestions became, and run time. Plus the screens to fix in the ' +
      'tests (`noisyScreens`, with the main reason and what to do), the slowest screens to compare and the ' +
      'reviewers. A build counts on the day it was created, its reviews with it. Default: the last 30 days ' +
      `of the main branch; at most ${MAX_RANGE_DAYS} days.`,
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        from: date('First day (UTC), inclusive; default 29 days before `to`'),
        to: date('Last day (UTC), inclusive; default today'),
        branch: branchSchema.optional().openapi({ description: "Default the project's main branch" }),
      }),
    },
    responses: { 200: json(InsightsSchema, 'The insights'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(insights, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    const report = await getInsights(s.deps, project, rangeOf(project, c.req.valid('query')));
    return c.json(report, 200);
  });

  const digestView = async (projectId: string) => ({
    ...(await getDigestSettings(s.deps, projectId)),
    timeZone: serverTimeZone(),
  });
  const getDigest = defineRoute('project.admin', {
    method: 'get',
    path: `${API}/projects/{slug}/insights/digest`,
    tags: ['insights'],
    summary: 'The weekly digest setting: on or off, and when (server time)',
    request: { params: z.object({ slug: z.string() }) },
    responses: { 200: json(DigestSettingsSchema, 'The setting'), ...problems(401, 403, 404) },
  });
  app.openapi(getDigest, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    return c.json(await digestView(project.id), 200);
  });

  const putDigest = defineRoute('project.admin', {
    method: 'put',
    path: `${API}/projects/{slug}/insights/digest`,
    tags: ['insights'],
    summary: 'Turns the weekly digest on or off and sets its weekday and hour (server time)',
    description:
      'Once a week, at `hour` on `weekday` (0 Sunday … 6 Saturday) in the time zone of the server (TZ, ' +
      'answered as `timeZone`), last week on the main branch goes to the webhooks that subscribe to ' +
      '`insights.weekly` (Slack format: a compact message) and by mail to members who asked for it.',
    request: {
      params: z.object({ slug: z.string() }),
      body: { content: { 'application/json': { schema: digestSettingsSchema } }, required: true },
    },
    responses: { 200: json(DigestSettingsSchema, 'The setting'), ...problems(401, 403, 404, 422) },
  });
  app.openapi(putDigest, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    await updateDigestSettings(s.deps, project.id, c.req.valid('json'));
    return c.json(await digestView(project.id), 200);
  });

  const sendNow = defineRoute('project.admin', {
    method: 'post',
    path: `${API}/projects/{slug}/insights/digest/send`,
    tags: ['insights'],
    summary: 'Sends the weekly digest now, whatever the schedule',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(
        z.object({
          webhooks: z.number().int().openapi({ description: 'Webhooks it was queued for' }),
          mails: z.number().int().openapi({ description: 'Mails queued (0 without SMTP)' }),
        }),
        'Queued',
      ),
      ...problems(401, 403, 404),
    },
  });
  app.openapi(sendNow, async (c) => {
    const project = await getProjectBySlug(s.deps, c.req.valid('param').slug);
    const sent = await sendDigestNow(s.deps, project, { publicUrl: s.config.publicUrl, mailer: s.mailer ?? null });
    return c.json({ webhooks: sent?.webhooks ?? 0, mails: sent?.mails ?? 0 }, 200);
  });
}
