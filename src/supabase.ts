import { createClient, type User as SupabaseUser } from '@supabase/supabase-js';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase =
  isSupabaseConfigured && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      })
    : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before building the app.'
    );
  }
  return supabase;
}

export function toAuthUser(user: SupabaseUser): AuthUser {
  const metadata = user.user_metadata;
  return {
    uid: user.id,
    email: user.email || null,
    displayName:
      (typeof metadata.full_name === 'string' && metadata.full_name) ||
      (typeof metadata.name === 'string' && metadata.name) ||
      user.email ||
      null,
    photoURL:
      (typeof metadata.avatar_url === 'string' && metadata.avatar_url) ||
      (typeof metadata.picture === 'string' && metadata.picture) ||
      null
  };
}

export async function signInWithGoogle(): Promise<void> {
  const client = requireSupabase();
  const redirectUrl = new URL(window.location.href);
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectUrl.toString() }
  });
  if (error) throw error;
}

export async function signOutUser(): Promise<void> {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export async function testSupabaseConnection(): Promise<void> {
  const { data, error } = await requireSupabase().rpc('test_connection');
  if (error) throw error;
  if (data !== true) {
    throw new Error('Supabase responded, but the connection check did not succeed.');
  }
}
