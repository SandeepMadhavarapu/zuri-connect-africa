import { createClient } from '@supabase/supabase-js';
import { env, isSupabaseConfigured } from '@/config/env.js';
import { METRICS, track } from '@/lib/observability/metrics.js';

let singleton;
let loggedDegradedClient = false;
let loggedClientInitFailure = false;

function recordClientInitMs(ms, configured) {
  try {
    track(METRICS.SUPABASE_CLIENT_INIT_MS, Math.round(ms), { configured: configured ? '1' : '0' });
  } catch {
    /* non-fatal */
  }
}

/**
 * Browser Supabase client (anon key). Use only through services / auth layer.
 * When env is missing/unusable, returns a degraded in-memory stub so auth/session
 * flows fail open and the app shell continues to mount.
 */
export function getSupabaseBrowserClient() {
  if (singleton) return singleton;

  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!isSupabaseConfigured) {
    if (!loggedDegradedClient) {
      loggedDegradedClient = true;
      console.warn(
        '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set to valid production values. Auth and database calls may fail until configured.'
      );
    }
    singleton = buildDegradedClient();
    recordClientInitMs(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
      false
    );
    return singleton;
  }

  try {
    singleton = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
      },
      realtime: {
        params: { eventsPerSecond: 10 },
      },
      global: {
        headers: { 'x-client-info': 'zuri-connect-africa-web' },
      },
    });
  } catch (error) {
    if (!loggedClientInitFailure) {
      loggedClientInitFailure = true;
      console.warn('[supabase] client init failed, switching to degraded mode:', error?.message || error);
    }
    singleton = buildDegradedClient();
  }

  recordClientInitMs(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    Boolean(singleton && !singleton._isDegraded)
  );
  return singleton;
}

function buildDegradedQueryBuilder() {
  const result = { data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } };
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    delete: () => chain,
    eq: () => chain,
    neq: () => chain,
    gt: () => chain,
    gte: () => chain,
    lt: () => chain,
    lte: () => chain,
    in: () => chain,
    is: () => chain,
    like: () => chain,
    ilike: () => chain,
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    single: () => chain,
    maybeSingle: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return chain;
}

function buildDegradedClient() {
  return {
    from: () => buildDegradedQueryBuilder(),
    rpc: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      signInWithOtp: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
      verifyOtp: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
      signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => ({
      on: () => ({
        subscribe: () => ({})
      }),
      subscribe: () => ({}),
    }),
    removeChannel: () => {},
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
        download: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
        remove: () => Promise.resolve({ data: null, error: { message: 'supabase_not_configured', code: 'SUPABASE_OFF' } }),
      }),
    },
    _isDegraded: true,
  };
}
