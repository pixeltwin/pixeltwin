import type { Server } from 'node:http';
export function startSite(port?: number, change?: boolean): Promise<Server>;
