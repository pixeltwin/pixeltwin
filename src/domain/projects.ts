import { isUniqueViolation } from '../db/database';
import type { Project } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { createProjectSchema, parseInput, updateProjectSchema } from './schemas';
import { slugCandidate, slugFromName } from './slug';

type DbDeps = Pick<Deps, 'db'>;

/** Every column but the internal build counter, which never leaves the domain. */
const PROJECT_COLUMNS = [
  'id',
  'slug',
  'name',
  'mainBranch',
  'colorThreshold',
  'tolerancePercent',
  'retentionDays',
  'autoApproveNew',
  'agentReview',
  'agentMaxDiffPercent',
  'visibleToAll',
  'createdAt',
  'updatedAt',
] as const;

type ProjectRow = Omit<Project, 'autoApproveNew' | 'visibleToAll'> & { autoApproveNew: number; visibleToAll: number };

function toProject(row: ProjectRow): Project {
  return { ...row, autoApproveNew: Number(row.autoApproveNew) === 1, visibleToAll: Number(row.visibleToAll) === 1 };
}

/** Also what a user who may not see the project gets, so slugs do not leak. */
export function projectNotFound(slug: string): AppError {
  return new AppError('project_not_found', 404, `Project "${slug}" not found.`);
}

/**
 * Creates a project. Without a slug, one is made from the name; when that is taken, the next free
 * `-2`, `-3`… is used. A slug given explicitly must be free (409 project_slug_taken).
 */
export async function createProject(deps: DbDeps, input: unknown): Promise<Project> {
  const { slug, ...data } = parseInput(createProjectSchema, input);
  const base = slug ?? slugFromName(data.name);
  for (let n = 1; ; n++) {
    const now = Date.now();
    const project: Project = {
      id: newId('prj'),
      slug: slugCandidate(base, n),
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await deps.db
        .insertInto('projects')
        .values({
          ...project,
          autoApproveNew: project.autoApproveNew ? 1 : 0,
          visibleToAll: project.visibleToAll ? 1 : 0,
        })
        .execute();
      return project;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (slug || n >= 100) {
        throw new AppError('project_slug_taken', 409, `A project with slug "${project.slug}" already exists.`);
      }
    }
  }
}

export async function getProjectBySlug(deps: DbDeps, slug: string): Promise<Project> {
  const project = await deps.db
    .selectFrom('projects')
    .select(PROJECT_COLUMNS)
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (!project) throw projectNotFound(slug);
  return toProject(project);
}

export async function getProjectById(deps: DbDeps, id: string): Promise<Project> {
  const project = await deps.db.selectFrom('projects').select(PROJECT_COLUMNS).where('id', '=', id).executeTakeFirst();
  if (!project) throw new AppError('project_not_found', 404, `Project ${id} not found.`);
  return toProject(project);
}

export async function listProjects(deps: DbDeps): Promise<Project[]> {
  return (await deps.db.selectFrom('projects').select(PROJECT_COLUMNS).orderBy('slug').execute()).map(toProject);
}

export async function updateProject(deps: DbDeps, slug: string, input: unknown): Promise<Project> {
  const changes = parseInput(updateProjectSchema, input);
  const project = await getProjectBySlug(deps, slug);
  const updated: Project = { ...project, ...changes, updatedAt: Date.now() };
  const { autoApproveNew, visibleToAll, ...columns } = changes;
  await deps.db
    .updateTable('projects')
    .set({
      ...columns,
      ...(autoApproveNew === undefined ? {} : { autoApproveNew: autoApproveNew ? 1 : 0 }),
      ...(visibleToAll === undefined ? {} : { visibleToAll: visibleToAll ? 1 : 0 }),
      updatedAt: updated.updatedAt,
    })
    .where('id', '=', project.id)
    .execute();
  return updated;
}

/** Deletes the project with its builds, checks, baselines and tokens. Images are left to GC. */
export async function deleteProject(deps: DbDeps, slug: string): Promise<void> {
  const project = await getProjectBySlug(deps, slug);
  await deps.db.deleteFrom('projects').where('id', '=', project.id).execute();
}
