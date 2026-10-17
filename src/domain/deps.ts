import type { Db } from '../db/database';
import type { ActorKind, ProjectRole, RejectReason } from '../db/schema';
import type { DiffRunner } from '../diff/types';
import type { Storage } from '../storage/storage';
import type { SecretBox } from './secrets';

export interface ImageLimits {
  maxImageBytes: number;
  maxImagePixels: number;
}

/**
 * What happened that someone outside pixeltwin may want to hear about (GitHub, webhooks). Called
 * after the change committed; an implementation queues what to send and never throws.
 */
export interface DomainEvents {
  /** The build was closed (the last part of a parallel build closed it). */
  buildFinalized(buildId: string): Promise<void>;
  /** Reviews, areas or a promotion may have changed these builds' verdicts or counts. */
  buildsChanged(buildIds: string[]): Promise<void>;
  /**
   * A person or token approved, rejected or undid the review of a check (not auto-approve, and
   * not an agent's suggestion, which leaves the check as it was). `actorName` is a token's name
   * at the time; `reason` is why (for an accepted suggestion, the agent's reason).
   */
  checkReviewed(event: {
    checkId: string;
    action: 'approved' | 'rejected' | 'reset';
    actor: string;
    actorKind: ActorKind;
    actorName: string | null;
    reason: string | null;
    /** A rejection's category (`REJECT_REASONS`); null without one. */
    reasonCode?: RejectReason | null;
  }): Promise<void>;
  /**
   * A user became a member of a project: added by a maintainer or admin (`member`), by accepting
   * an invite (`invite`; `by` is who invited) or by an admin approving their sign-up (`access_request`).
   */
  memberAdded?(event: MemberAdded): Promise<void>;
}

export interface MemberAdded {
  projectId: string;
  userId: string;
  role: ProjectRole;
  via: 'member' | 'invite' | 'access_request';
  /** The user who added or invited them, or approved the request; null when unknown. */
  by: string | null;
}

/** Everything domain functions need. Built once in main.ts; built per test in test/helpers. */
export interface Deps {
  db: Db;
  storage: Storage;
  runDiff: DiffRunner;
  limits: ImageLimits;
  /** Diff jobs waiting for a worker; the upload route refuses new work while it is too long. */
  diffBacklog?: () => number;
  /** Seals the secrets integrations keep (SECRET_KEY); without it they are stored as they are. */
  secrets?: SecretBox;
  /** Told about finalized builds, verdict changes and reviews; queues GitHub updates and webhooks. */
  events?: DomainEvents;
}
