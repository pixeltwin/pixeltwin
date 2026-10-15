import { isUniqueViolation } from '../db/database';
import type { Project } from '../db/schema';
import { AppError } from '../errors';
import { newId } from '../ids';
import type { Deps } from './deps';
import { createProjectSchema, parseInput, updateProjectSchema } from './schemas';

type DbDeps = Pick<Deps, 'db'>;

export async function createProject(deps: DbDeps, input: unknown): Promise<Project> {
  const data = parseInput(createProjectSchema, input);
  const now = Date.now();
  const project: Project = { id: newId('prj'), ...data, createdAt: now, updatedAt: now };
  try {
    await deps.db.insertInto('projects').values(project).execute();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('project_slug_taken', 409, `A project with slug "${data.slug}" already exists.`);
    }
    throw err;
  }
  return project;
}

export async function getProjectBySlug(deps: DbDeps, slug: string): Promise<Project> {
  const project = await deps.db.selectFrom('projects').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!project) throw new AppError('project_not_found', 404, `Project "${slug}" not found.`);
  return project;
}

export async function getProjectById(deps: DbDeps, id: string): Promise<Project> {
  const project = await deps.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
  if (!project) throw new AppError('project_not_found', 404, `Project ${id} not found.`);
  return project;
}

export function listProjects(deps: DbDeps): Promise<Project[]> {
  return deps.db.selectFrom('projects').selectAll().orderBy('slug').execute();
}

export async function updateProject(deps: DbDeps, slug: string, input: unknown): Promise<Project> {
  const changes = parseInput(updateProjectSchema, input);
  const project = await getProjectBySlug(deps, slug);
  const updated: Project = { ...project, ...changes, updatedAt: Date.now() };
  await deps.db
    .updateTable('projects')
    .set({ ...changes, updatedAt: updated.updatedAt })
    .where('id', '=', project.id)
    .execute();
  return updated;
}

/** Deletes the project with its builds, checks, baselines and tokens. Images are left to GC. */
export async function deleteProject(deps: DbDeps, slug: string): Promise<void> {
  const project = await getProjectBySlug(deps, slug);
  await deps.db.deleteFrom('projects').where('id', '=', project.id).execute();
}
