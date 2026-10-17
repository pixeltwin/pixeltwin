// GitHub and GitLab REST API doubles on free ports: they record commit statuses and pull request
// comments (merge request notes), check the token, and can be told to fail the next requests.

export const FAKE_TOKEN = 'ghp_faketoken1234';

export interface RecordedStatus {
  repo: string;
  sha: string;
  state: string;
  description: string;
  context: string;
  target_url: string;
}

export interface RecordedComment {
  id: number;
  repo: string;
  pr: number;
  body: string;
}

export interface FakeGitHub {
  url: string;
  statuses: RecordedStatus[];
  comments: Map<number, RecordedComment>;
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  /** The next `times` requests answer `status` (with `headers`) instead. */
  failNext(status: number, times?: number, headers?: Record<string, string>): void;
  /** The next requests wait this long before answering (to test timeouts). */
  delay(ms: number): void;
  stop(): void;
}

export function startFakeGitHub(token = FAKE_TOKEN): FakeGitHub {
  const statuses: RecordedStatus[] = [];
  const comments = new Map<number, RecordedComment>();
  const requests: FakeGitHub['requests'] = [];
  let failures: Array<{ status: number; headers: Record<string, string> }> = [];
  let wait = 0;
  let nextId = 1000;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const authorization = req.headers.get('authorization');
      requests.push({ method: req.method, path: url.pathname + url.search, authorization });
      if (wait) await Bun.sleep(wait);
      const failure = failures.shift();
      if (failure)
        return Response.json({ message: 'Server Error' }, { status: failure.status, headers: failure.headers });
      if (authorization !== `Bearer ${token}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });

      let m = /^\/repos\/([^/]+)\/([^/]+)\/statuses\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        const body = (await req.json()) as Omit<RecordedStatus, 'repo' | 'sha'>;
        statuses.push({ repo: `${m[1]}/${m[2]}`, sha: m[3] as string, ...body });
        return Response.json({ id: statuses.length }, { status: 201 });
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const repo = `${m[1]}/${m[2]}`;
        const pr = Number(m[3]);
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        const all = [...comments.values()].filter((c) => c.repo === repo && c.pr === pr);
        return Response.json(all.slice((page - 1) * perPage, page * perPage).map((c) => ({ id: c.id, body: c.body })));
      }
      if (m && req.method === 'POST') {
        const { body } = (await req.json()) as { body: string };
        const comment = { id: nextId++, repo: `${m[1]}/${m[2]}`, pr: Number(m[3]), body };
        comments.set(comment.id, comment);
        return Response.json({ id: comment.id, body }, { status: 201 });
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(url.pathname);
      if (m && req.method === 'PATCH') {
        const comment = comments.get(Number(m[3]));
        if (!comment) return Response.json({ message: 'Not Found' }, { status: 404 });
        comment.body = ((await req.json()) as { body: string }).body;
        return Response.json({ id: comment.id, body: comment.body });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    statuses,
    comments,
    requests,
    failNext(status, times = 1, headers = {}) {
      for (let i = 0; i < times; i++) failures.push({ status, headers });
    },
    delay(ms) {
      wait = ms;
    },
    stop() {
      failures = [];
      server.stop(true);
    },
  };
}

export const FAKE_GITLAB_TOKEN = 'glpat-faketoken5678';

export interface FakeGitLab {
  url: string;
  /** `repo` is the decoded project path. */
  statuses: Array<{ repo: string; sha: string; state: string; name: string; description: string; target_url: string }>;
  notes: Map<number, RecordedComment>;
  requests: Array<{ method: string; path: string; token: string | null }>;
  failNext(status: number, times?: number): void;
  stop(): void;
}

export function startFakeGitLab(token = FAKE_GITLAB_TOKEN): FakeGitLab {
  const statuses: FakeGitLab['statuses'] = [];
  const notes = new Map<number, RecordedComment>();
  const requests: FakeGitLab['requests'] = [];
  let failures: number[] = [];
  let nextId = 500;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const sent = req.headers.get('private-token');
      requests.push({ method: req.method, path: url.pathname + url.search, token: sent });
      const failure = failures.shift();
      if (failure) return Response.json({ message: 'Server Error' }, { status: failure });
      if (sent !== token) return Response.json({ message: '401 Unauthorized' }, { status: 401 });
      let m = /^\/api\/v4\/projects\/([^/]+)\/statuses\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        const body = (await req.json()) as { state: string; name: string; description: string; target_url: string };
        const repo = decodeURIComponent(m[1] as string);
        const last = statuses.findLast((st) => st.repo === repo && st.sha === m?.[2] && st.name === body.name);
        // Like GitLab: setting the state a status already has is refused.
        if (last?.state === body.state) {
          return Response.json(
            { message: `Cannot transition status via :enqueue from :${body.state}` },
            { status: 400 },
          );
        }
        statuses.push({ repo, sha: m[2] as string, ...body });
        return Response.json({ id: statuses.length }, { status: 201 });
      }
      m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const repo = decodeURIComponent(m[1] as string);
        const all = [...notes.values()].filter((n) => n.repo === repo && n.pr === Number(m?.[2]));
        const perPage = Number(url.searchParams.get('per_page') ?? 20);
        const page = Number(url.searchParams.get('page') ?? 1);
        return Response.json(all.slice((page - 1) * perPage, page * perPage).map((n) => ({ id: n.id, body: n.body })));
      }
      if (m && req.method === 'POST') {
        const { body } = (await req.json()) as { body: string };
        const note = { id: nextId++, repo: decodeURIComponent(m[1] as string), pr: Number(m[2]), body };
        notes.set(note.id, note);
        return Response.json({ id: note.id, body }, { status: 201 });
      }
      m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes\/(\d+)$/.exec(url.pathname);
      if (m && req.method === 'PUT') {
        const note = notes.get(Number(m[3]));
        if (!note) return Response.json({ message: '404 Not found' }, { status: 404 });
        note.body = ((await req.json()) as { body: string }).body;
        return Response.json({ id: note.id, body: note.body });
      }
      return Response.json({ message: '404 Not Found' }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    statuses,
    notes,
    requests,
    failNext(status, times = 1) {
      for (let i = 0; i < times; i++) failures.push(status);
    },
    stop() {
      failures = [];
      server.stop(true);
    },
  };
}

export interface ReceivedHook {
  headers: Record<string, string>;
  body: string;
}

/** A webhook receiver on a free port: records every request; answers `status()`. */
export function startReceiver(status: () => number = () => 200): {
  url: string;
  received: ReceivedHook[];
  stop(): void;
} {
  const received: ReceivedHook[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
      return new Response('ok', { status: status() });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/hook`, received, stop: () => server.stop(true) };
}
