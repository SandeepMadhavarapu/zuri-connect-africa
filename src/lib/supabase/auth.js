import { getSupabaseBrowserClient } from './client.js';

export async function getSession() {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signOut(scope = 'global') {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.auth.signOut({ scope });
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  const supabase = getSupabaseBrowserClient();
  const { data } = supabase.auth.onAuthStateChange(callback);
  return data.subscription;
}
