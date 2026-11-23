import { createClient, type SupabaseClient, type User as SupabaseUser } from '@supabase/supabase-js';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

interface LocalCredentials {
  username: string;
  salt: string;
  passwordHash: string;
}

const SUPABASE_CONFIG_KEY = 'allocat_supabase_config_v1';
const LOCAL_CREDENTIALS_KEY = 'allocat_local_credentials_v1';
const LOCAL_SESSION_KEY = 'allocat_local_session_v1';
const LOCAL_UID_KEY = 'allocat_local_uid_v1';
const LOCAL_AUTH_EVENT = 'allocat-local-auth-change';
const SUPABASE_CONFIG_EVENT = 'allocat-supabase-config-change';
const PASSWORD_HASH_ITERATIONS = 120_000;

let activeClient: SupabaseClient | null = null;
let activeConfigSignature = '';

function getEnvironmentConfig(): SupabaseConfig {
  return {
    url: import.meta.env.VITE_SUPABASE_URL?.trim() || '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || ''
  };
}

export function getSupabaseConfig(): SupabaseConfig {
  const saved = localStorage.getItem(SUPABASE_CONFIG_KEY);
  if (!saved) return getEnvironmentConfig();
  const parsed: unknown = JSON.parse(saved);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as SupabaseConfig).url !== 'string' ||
    typeof (parsed as SupabaseConfig).anonKey !== 'string'
  ) {
    throw new Error('Saved Supabase settings are invalid. Re-enter the project URL and anon key.');
  }
  return {
    url: (parsed as SupabaseConfig).url,
    anonKey: (parsed as SupabaseConfig).anonKey
  };
}

export function isSupabaseConfigured(): boolean {
  try {
    const config = getSupabaseConfig();
    return Boolean(config.url.trim() && config.anonKey.trim());
  } catch {
    return false;
  }
}

function getSupabaseClient(): SupabaseClient | null {
  const config = getSupabaseConfig();
  const url = config.url.trim();
  const anonKey = config.anonKey.trim();
  const signature = `${url}\n${anonKey}`;
  if (signature !== activeConfigSignature) {
    activeConfigSignature = signature;
    activeClient =
      url && anonKey
        ? createClient(url, anonKey, {
            auth: {
              autoRefreshToken: true,
              persistSession: true,
              detectSessionInUrl: false
            }
          })
        : null;
  }
  return activeClient;
}

function isPrivilegedSupabaseKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const encodedPayload = key.split('.')[1];
  if (!encodedPayload) return false;
  try {
    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      role?: unknown;
    };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export function configureSupabase(config: SupabaseConfig): void {
  const url = config.url.trim();
  const anonKey = config.anonKey.trim();
  if ((url && !anonKey) || (!url && anonKey)) {
    throw new Error('Enter both the Supabase project URL and anon/publishable key.');
  }
  if (isPrivilegedSupabaseKey(anonKey)) {
    throw new Error('Service-role and secret keys are not allowed in browser settings. Use the public anon/publishable key.');
  }
  if (url) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Enter a valid Supabase project URL.');
    }
    if (
      parsedUrl.protocol !== 'https:' &&
      !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname))
    ) {
      throw new Error('The Supabase project URL must use HTTPS.');
    }
  }

  if (url && anonKey) {
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify({ url, anonKey }));
  } else {
    localStorage.removeItem(SUPABASE_CONFIG_KEY);
  }
  activeConfigSignature = '';
  getSupabaseClient();
  window.dispatchEvent(new Event(SUPABASE_CONFIG_EVENT));
}

export function subscribeToSupabaseConfigChange(callback: () => void): () => void {
  window.addEventListener(SUPABASE_CONFIG_EVENT, callback);
  return () => window.removeEventListener(SUPABASE_CONFIG_EVENT, callback);
}

export function subscribeToLocalAuthChange(callback: () => void): () => void {
  window.addEventListener(LOCAL_AUTH_EVENT, callback);
  return () => window.removeEventListener(LOCAL_AUTH_EVENT, callback);
}

export function requireSupabase(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase is not configured. Enter its project URL and anon key in Admin Panel.');
  }
  return client;
}

function createLocalUser(username: string): AuthUser {
  let uid = localStorage.getItem(LOCAL_UID_KEY);
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem(LOCAL_UID_KEY, uid);
  }
  return { uid, email: null, displayName: username, photoURL: null };
}

export function toAuthUser(user: SupabaseUser, username: string): AuthUser {
  return {
    uid: user.id,
    email: null,
    displayName: username,
    photoURL: null
  };
}

async function ensureAnonymousSupabaseUser(username: string): Promise<AuthUser> {
  const client = requireSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session?.user.is_anonymous) {
    return toAuthUser(sessionData.session.user, username);
  }
  if (sessionData.session) {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  }
  const { data, error } = await client.auth.signInAnonymously({
    options: { data: { local_username: username } }
  });
  if (error) throw error;
  if (!data.user) throw new Error('Supabase did not return an anonymous user.');
  return toAuthUser(data.user, username);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: Uint8Array.from(salt.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16)),
      iterations: PASSWORD_HASH_ITERATIONS,
      hash: 'SHA-256'
    },
    passwordKey,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function readLocalCredentials(): LocalCredentials | null {
  const raw = localStorage.getItem(LOCAL_CREDENTIALS_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as LocalCredentials).username !== 'string' ||
    typeof (parsed as LocalCredentials).salt !== 'string' ||
    typeof (parsed as LocalCredentials).passwordHash !== 'string'
  ) {
    throw new Error('Stored local login settings are invalid. Clear this browser’s site data to reset them.');
  }
  return parsed as LocalCredentials;
}

async function ensureLocalCredentials(): Promise<LocalCredentials> {
  const saved = readLocalCredentials();
  if (saved) return saved;

  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const credentials: LocalCredentials = {
    username: 'admin',
    salt,
    passwordHash: await hashPassword('admin', salt)
  };
  localStorage.setItem(LOCAL_CREDENTIALS_KEY, JSON.stringify(credentials));
  return credentials;
}

async function resolveLocalUser(username: string): Promise<AuthUser> {
  if (isSupabaseConfigured()) {
    try {
      return await ensureAnonymousSupabaseUser(username);
    } catch {
      return createLocalUser(username);
    }
  }
  return createLocalUser(username);
}

export async function restoreLocalAuth(): Promise<AuthUser | null> {
  const username = localStorage.getItem(LOCAL_SESSION_KEY);
  return username ? resolveLocalUser(username) : null;
}

export async function signInWithLocalCredentials(
  username: string,
  password: string
): Promise<AuthUser> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) {
    throw new Error('Enter your username and password.');
  }
  const credentials = await ensureLocalCredentials();
  const candidateHash = await hashPassword(password, credentials.salt);
  if (
    normalizedUsername.toLowerCase() !== credentials.username.toLowerCase() ||
    candidateHash !== credentials.passwordHash
  ) {
    throw new Error('The username or password is incorrect.');
  }

  localStorage.setItem(LOCAL_SESSION_KEY, credentials.username);
  const user = await resolveLocalUser(credentials.username);
  window.dispatchEvent(new Event(LOCAL_AUTH_EVENT));
  return user;
}

export function signOutUser(): void {
  localStorage.removeItem(LOCAL_SESSION_KEY);
  window.dispatchEvent(new Event(LOCAL_AUTH_EVENT));
}

export async function testSupabaseConnection(): Promise<void> {
  const username = localStorage.getItem(LOCAL_SESSION_KEY) || 'admin';
  await ensureAnonymousSupabaseUser(username);
  window.dispatchEvent(new Event(LOCAL_AUTH_EVENT));
  const { data, error } = await requireSupabase().rpc('test_connection');
  if (error) throw error;
  if (data !== true) {
    throw new Error('Supabase responded, but the connection check did not succeed.');
  }
}
