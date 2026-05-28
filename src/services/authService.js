import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { mapSessionUser } from '@/lib/auth/authSession.js';
import { register as registerWithEmail } from '@/api/auth.js';

export function redirectToLogin() {
  window.location.href = '/auth';
}

export async function getCurrentUser() {
  const supabase = getSupabaseBrowserClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user ? mapSessionUser(user) : null;
}

export async function signInWithEmailPassword(email, password) {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return mapSessionUser(data.user);
}

export async function signUpWithEmailPassword(email, password, opts) {
  return registerWithEmail(email, password, opts);
}

export async function signOutEverywhere() {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) throw error;
}
