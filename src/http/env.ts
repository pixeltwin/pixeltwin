import type { Config } from '../config';
import type { Principal, RoutePermission } from '../domain/auth/policy';
import type { SetupState } from '../domain/auth/setup';
import type { Deps } from '../domain/deps';
import type { Logger } from '../log';
import type { Mailer } from '../mail/smtp';
import type { LoginLimiter } from './rate-limit';

export const API = '/api/v1';
export const SESSION_COOKIE = 'pt_session';

/** Everything route handlers need besides the request. */
export interface Services {
  deps: Deps;
  config: Pick<Config, 'publicUrl' | 'maxImageBytes' | 'diffQueueMax' | 'diffWorkers'>;
  logger: Logger;
  setup: SetupState;
  loginLimiter: LoginLimiter;
  /** Sends invites, reset links and sign-up mails when SMTP_URL is set. */
  mailer?: Mailer | null;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    principal: Principal | null;
    authVia: 'cookie' | 'token' | null;
    /** Raw session cookie value when the request was authenticated by cookie. */
    sessionToken: string | null;
    /** The permission the route declared (API routes); project checks default to it. */
    permission: RoutePermission | null;
    /** Set once the caller's access to the project was checked (see access.ts). */
    projectChecked: boolean;
    /** For route middleware that needs the database (access.ts). */
    deps: Deps;
  };
}
