import type { Child } from 'hono/jsx';
import type { Project } from '../db/schema';
import type { Ui } from './context';

/** Copy-ready snippets for this server and project (UI spec §4.5). */
export function snippets(publicUrl: string, slug: string) {
  const base = publicUrl.replace(/\/+$/, '');
  const api = `${base}/api/v1`;
  return {
    playwright: `// Once per run (global setup): open a build.
const api = '${api}';
const auth = { authorization: \`Bearer \${process.env.PIXELTWIN_TOKEN}\` };
const build = await (await fetch(\`\${api}/projects/${slug}/builds\`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ branch: process.env.BRANCH ?? 'main', externalId: process.env.CI_RUN_ID }),
})).json();

// In each test: post a screenshot.
const form = new FormData();
form.set('image', new Blob([await page.screenshot({ fullPage: true })], { type: 'image/png' }));
form.set('meta', JSON.stringify({ name: 'home', variant: { browser: testInfo.project.name } }));
await fetch(\`\${api}/builds/\${build.id}/checks\`, { method: 'POST', headers: auth, body: form });

// After all tests (global teardown): close the build and read the verdict.
await fetch(\`\${api}/builds/\${build.id}/finalize\`, { method: 'POST', headers: auth });`,
    curl: `export PIXELTWIN_TOKEN=pt_…   # a project token with read and write
BUILD=$(curl -s -X POST ${api}/projects/${slug}/builds \\
  -H "Authorization: Bearer $PIXELTWIN_TOKEN" -H "Content-Type: application/json" \\
  -d '{"branch":"main"}' | jq -r .id)
curl -X POST ${api}/builds/$BUILD/checks -H "Authorization: Bearer $PIXELTWIN_TOKEN" \\
  -F image=@home.png -F 'meta={"name":"home"}'
curl -X POST ${api}/builds/$BUILD/finalize -H "Authorization: Bearer $PIXELTWIN_TOKEN"`,
    agent: `Read ${base}/llms.txt, then send screenshots of our key pages to the pixeltwin
project "${slug}" with the token in $PIXELTWIN_TOKEN. Finalize the build and report
its verdict and the summary of every changed check.`,
  };
}

const TABS = [
  { key: 'playwright', label: 'Playwright' },
  { key: 'curl', label: 'curl' },
  { key: 'agent', label: 'AI agent' },
] as const;

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
    <section class="onboarding" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title">Send your first screenshots</h2>
      <p class="sub">Three steps. This page shows the project's branches once the first build arrives.</p>
      <ol class="steps">
        <Step n={1} done={hasToken} title="Create a token">
          {hasToken ? (
            <p class="muted">This project has a token. Keep it in your CI secrets as PIXELTWIN_TOKEN.</p>
          ) : canManage ? (
            <p>
              Tests send screenshots with a project token (scopes read and write).{' '}
              <a class="button small" href={ui.url(`/ui/p/${project.slug}/settings`)}>
                Create a token
              </a>
            </p>
          ) : (
            <p class="muted">Tests send screenshots with a project token. Ask an admin for a token.</p>
          )}
        </Step>
        <Step n={2} done={false} title="Post a check from your tests">
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
                <pre id={`snippet-${tab.key}`}>
                  <code>{code[tab.key]}</code>
                </pre>
                <button type="button" class="small" data-copy-from={`snippet-${tab.key}`} hidden>
                  Copy
                </button>
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
