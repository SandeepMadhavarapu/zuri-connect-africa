import { getSupabaseBrowserClient } from './client.js';

export function getBucket(bucketId) {
  return getSupabaseBrowserClient().storage.from(bucketId);
}
