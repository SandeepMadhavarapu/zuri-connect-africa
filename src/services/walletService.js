import { fromTable } from '@/lib/supabase/database.js';

export async function getWalletByUserId(userId) {
  const { data, error } = await fromTable('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
