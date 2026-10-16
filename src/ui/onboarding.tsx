import type { Child } from 'hono/jsx';
import type { Project } from '../db/schema';
import type { Ui } from './context';
import { NewTokenDialog } from './token-forms';

/** One copyable block of a snippet tab: what it is and its code. */
interface SnippetBlock {
  label: string;
  code: string;
}

/**
 * Copy-ready snippets for this server and project (UI spec §4.5). The SDK tabs come in four short
 * blocks (install, config, a test, run) so the way in looks as small as it is.
 */
export function snippets(publicUrl: string, slug: string): Record<SnippetTab, SnippetBlock[]> {
  const base = publicUrl.replace(/\/+$/, '');
  const api = `${base}/api/v1`;
  const env = `PIXELTWIN_URL=${base} PIXELTWIN_PROJECT=${slug} PIXELTWIN_TOKEN=pt_…`;
  return {
    playwright: [
      { label: 'Install', code: 'npm install -D @pixeltwin/playwright' },
      {
        label: 'playwright.config.ts: one line',
        code: `export default defineConfig({
  globalSetup: '@pixeltwin/playwright/setup',
  // …your config as before
});`,
      },
      {
        label: 'A test: one call per screenshot',
        code: `import { test } from '@pixeltwin/playwright';

test('home', async ({ page, pixeltwin }) => {
  await page.goto('/');
  await pixeltwin.check(page, 'home');
});`,
      },
      { label: 'Run', code: `${env} npx playwright test` },
    ],
    wdio: [
      { label: 'Install', code: 'npm install -D @pixeltwin/wdio' },
      {
        label: 'wdio.conf.ts: one service',
        code: `import { PixeltwinService } from '@pixeltwin/wdio';

export const config = {
  services: [[PixeltwinService, {}]],
  // …your config as before
};`,
      },
      {
        label: 'A test: one call per screenshot',
        code: `import '@pixeltwin/wdio';

it('home', async () => {
  await browser.url('/');
  await browser.pixeltwinCheck('home');
});`,
      },
      { label: 'Run', code: `${env} npx wdio run wdio.conf.ts` },
    ],
    curl: [
      {
        label: 'Any language: three requests',
        code: `export PIXELTWIN_TOKEN=pt_…   # a project token with read and write
BUILD=$(curl -s -X POST ${api}/projects/${slug}/builds \\
  -H "Authorization: Bearer $PIXELTWIN_TOKEN" -H "Content-Type: application/json" \\
  -d '{"branch":"main"}' | jq -r .id)
curl -X POST ${api}/builds/$BUILD/checks -H "Authorization: Bearer $PIXELTWIN_TOKEN" \\
  -F image=@home.png -F 'meta={"name":"home"}'
curl -X POST ${api}/builds/$BUILD/finalize -H "Authorization: Bearer $PIXELTWIN_TOKEN"`,
      },
    ],
    agent: [
      {
        label: 'Ask your coding agent',
        code: `Read ${base}/llms.txt, then send screenshots of our key pages to the pixeltwin
project "${slug}" with the token in $PIXELTWIN_TOKEN. Finalize the build and report
its verdict and the summary of every changed check.`,
      },
    ],
  };
}

const TABS = [
  { key: 'playwright', label: 'Playwright' },
  { key: 'wdio', label: 'WebdriverIO' },
  { key: 'curl', label: 'curl' },
  { key: 'agent', label: 'AI agent' },
] as const;
type SnippetTab = (typeof TABS)[number]['key'];

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: Child }) {
  return (
    <li class={done ? 'step done' : 'step'}>
      <span class="step-mark" aria-hidden="true">
        {done ? '✓' : String(n)}
      </span>
      <div class="step-body">
        <h3>
          {title}
          {done && <span class="visually-hidden"> (done)</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** Shown on a project's home page until its first build arrives. */
export function Onboarding({
  ui,
  project,
  publicUrl,
  hasToken,
  canManage,
}: {
  ui: Ui;
  project: Project;
  publicUrl: string;
  hasToken: boolean;
  canManage: boolean;
}) {
  const code = snippets(publicUrl, project.slug);
  const base = publicUrl.replace(/\/+$/, '');
  return (
    // Live: once the first build arrives the page reloads into the branch list (UI spec §4.4).
    <section
      class="onboarding"
      aria-labelledby="onboarding-title"
      data-live="onboarding"
      data-live-open=""
      data-live-reload=""
    >
      <h2 id="onboarding-title">Send your first screenshots</h2>
      <p class="sub">
        A few minutes: a token, one package and one call per screenshot. This page turns into the project's branches
        once the first build arrives.
      </p>
      <ol class="steps">
        <Step n={1} done={hasToken} title="Create a token">
          {hasToken ? (
            <p class="muted">This project has a token. Keep it in your CI secrets as PIXELTWIN_TOKEN.</p>
          ) : canManage ? (
            <p>
              Tests send screenshots with a project token (scopes read and write).{' '}
              <a
                class="button small"
                href={ui.url(`/ui/p/${project.slug}/settings/tokens/new`)}
                data-dialog-open="new-token"
              >
                Create a token
              </a>
            </p>
          ) : (
            <p class="muted">Tests send screenshots with a project token. Ask an admin for a token.</p>
          )}
          {canManage && !hasToken && <NewTokenDialog ui={ui} slug={project.slug} />}
        </Step>
        <Step n={2} done={false} title="Add pixeltwin to your tests">
          {/* Radio tabs: they switch without JavaScript. */}
          <div class="snippet-tabs">
            {TABS.map((tab, i) => (
              <>
                <input
                  type="radio"
                  name="snippet"
                  id={`snippet-tab-${tab.key}`}
                  class="visually-hidden"
                  checked={i === 0}
                />
                <label for={`snippet-tab-${tab.key}`}>{tab.label}</label>
              </>
            ))}
            {TABS.map((tab) => (
              <div class={`snippet snippet-${tab.key}`}>
                {code[tab.key].map((block, i) => (
                  <div class="snippet-block">
                    <p class="snippet-label">{block.label}</p>
                    <pre id={`snippet-${tab.key}-${i + 1}`}>
                      <code>{block.code}</code>
                    </pre>
                    <button type="button" class="small" data-copy-from={`snippet-${tab.key}-${i + 1}`} hidden>
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p class="hint">
            Agents: <a href={`${base}/llms.txt`}>{`${base}/llms.txt`}</a> explains the workflow; the full contract is at{' '}
            <a href={`${base}/openapi.json`}>/openapi.json</a>.
          </p>
        </Step>
        <Step n={3} done={false} title="Approve the first build">
          <p class="muted">
            The first run has no baselines, so every check is "new". Approve them and they become the baselines that
            later runs are compared with.
          </p>
        </Step>
      </ol>
    </section>
  );
}
