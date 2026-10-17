import { type ApiOptions, apiRequest, type CodeHost, CodeHostError, upsertByMarker } from './http';

// GitLab adapter: commit statuses and merge request notes over the v4 REST API, on gitlab.com or a
// self-hosted instance. The project is addressed by its URL-encoded path (`group%2Fsub%2Fproject`).

export const GITLAB_URL = 'https://gitlab.com';

export interface GitLabAuth {
  /** The instance, e.g. `https://gitlab.com` or `https://gitlab.example.com`. */
  baseUrl: string;
  /** A project (or personal) access token with the `api` scope and at least the Developer role. */
  token: string;
}

const STATES = { pending: 'pending', success: 'success', failure: 'failed' } as const;

export function gitlabHost(auth: GitLabAuth, options: ApiOptions = {}): CodeHost {
  const target = {
    host: 'GitLab',
    base: `${auth.baseUrl.replace(/\/+$/, '')}/api/v4`,
    token: auth.token,
    headers: { accept: 'application/json', 'private-token': auth.token },
  };
  const call = <T>(method: string, path: string, body?: unknown) => apiRequest<T>(target, method, path, body, options);
  const project = (path: string) => `/projects/${encodeURIComponent(path)}`;
  return {
    name: 'GitLab',
    async postStatus(repository, sha, status) {
      try {
        await call('POST', `${project(repository)}/statuses/${encodeURIComponent(sha)}`, {
          state: STATES[status.state],
          name: status.context,
          description: status.description,
          target_url: status.targetUrl,
        });
      } catch (err) {
        // GitLab refuses to set the state a status already has ("Cannot transition status via
        // :enqueue from :pending"): it is already what we wanted.
        if (
          err instanceof CodeHostError &&
          err.status === 400 &&
          /cannot transition status/i.test(err.hostMessage ?? '')
        ) {
          return;
        }
        throw err;
      }
    },
    upsertComment(repository, number, marker, body, knownId) {
      const notes = `${project(repository)}/merge_requests/${number}/notes`;
      return upsertByMarker({
        knownId,
        marker,
        edit: (id) => call('PUT', `${notes}/${encodeURIComponent(id)}`, { body }),
        page: async (n) =>
          (await call<Array<{ id: number; body?: string }>>('GET', `${notes}?per_page=100&page=${n}&sort=asc`)).data,
        create: async () => String((await call<{ id: number }>('POST', notes, { body })).data.id),
      });
    },
  };
}
