import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

export type IdPrefix =
  | 'prj'
  | 'bld'
  | 'chk'
  | 'bln'
  | 'usr'
  | 'tok'
  | 'ses'
  | 'req'
  | 'rev'
  | 'are'
  | 'whk'
  | 'dlv'
  | 'lnk'
  | 'acr'
  | 'mal'
  | 'imk';

/** Returns a prefixed ULID, e.g. `bld_01JA2…`. IDs created later sort after earlier ones. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nextUlid()}`;
}
