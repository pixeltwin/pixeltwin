import type { Project, ProjectRole } from '../../db/schema';
import type { Deps } from '../deps';
import { listProjects } from '../projects';
import { hasPermission, type Principal, projectRoleOf } from './policy';

type DbDeps = Pick<Deps, 'db'>;
type User = Extract<Principal, { kind: 'user' }>;

/** The user's role in one project (see `projectRoleOf`); null for admins, who need none. */
export async function projectRoleFor(deps: DbDeps, user: User, projectId: string): Promise<ProjectRole | null> {
  if (user.role === 'admin') return null;
  const row = await deps.db
    .selectFrom('projects')
    .leftJoin('projectMembers', (join) =>
      join.onRef('projectMembers.projectId', '=', 'projects.id').on('projectMembers.userId', '=', user.id),
    )
    .select(['projects.visibleToAll', 'projectMembers.role'])
    .where('projects.id', '=', projectId)
    .executeTakeFirst();
  if (!row) return null;
  return projectRoleOf(user, { visibleToAll: Number(row.visibleToAll) === 1 }, row.role ?? null);
}

/** The projects the user may open, by slug, each with the user's role there. */
export async function visibleProjects(
  deps: DbDeps,
  user: User,
): Promise<Array<{ project: Project; role: ProjectRole | null }>> {
  const [projects, memberships] = await Promise.all([
    listProjects(deps),
    user.role === 'admin'
      ? Promise.resolve([])
      : deps.db.selectFrom('projectMembers').select(['projectId', 'role']).where('userId', '=', user.id).execute(),
  ]);
  const byProject = new Map(memberships.map((m) => [m.projectId, m.role]));
  return projects
    .map((project) => ({ project, role: projectRoleOf(user, project, byProject.get(project.id) ?? null) }))
    .filter(({ role }) => hasPermission(user, 'project.read', role));
}
