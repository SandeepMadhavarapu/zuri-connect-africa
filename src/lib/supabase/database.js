import { getSupabaseBrowserClient } from './client.js';

/** Typed table accessor — always used via domain services, not components. */
export function fromTable(table) {
  return getSupabaseBrowserClient().from(table);
}
