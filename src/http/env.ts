import type { Config } from '../config';
import type { Principal } from '../domain/auth/policy';
import type { SetupState } from '../domain/auth/setup';
import type { Deps } from '../domain/deps';
import type { Logger } from '../log';
import type { Notifier } from '../notify/notifier';
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
  /** Queues and sends GitHub/GitLab updates and webhooks; the same object is `deps.events`. */
  notifier: Notifier;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    principal: Principal | null;
    authVia: 'cookie' | 'token' | null;
    /** Raw session cookie value when the request was authenticated by cookie. */
    sessionToken: string | null;
  };
}
