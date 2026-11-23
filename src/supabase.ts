import { createClient, type SupabaseClient, type User as SupabaseUser } from '@supabase/supabase-js';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: LocalAppRole;
}

export type LocalAppRole = 'admin' | 'editor' | 'viewer';

export interface LocalAppAccount {
  username: string;
  role: LocalAppRole;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

interface StoredLocalAccount extends LocalAppAccount {
  salt: string;
  passwordHash: string;
}

const SUPABASE_CONFIG_KEY = 'allocat_supabase_config_v1';
const LOCAL_CREDENTIALS_KEY = 'allocat_local_credentials_v1';
const LOCAL_ACCOUNTS_KEY = 'allocat_local_accounts_v1';
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

export function isSupabaseConfigLocked(): boolean {
  const config = getEnvironmentConfig();
  return Boolean(config.url && config.anonKey);
}

export function getSupabaseConfig(): SupabaseConfig {
  const environmentConfig = getEnvironmentConfig();
  if (environmentConfig.url && environmentConfig.anonKey) return environmentConfig;

  const saved = localStorage.getItem(SUPABASE_CONFIG_KEY);
  if (!saved) return environmentConfig;
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
  if (isSupabaseConfigLocked()) {
    throw new Error('Supabase settings are managed by this deployment and cannot be changed in Admin Panel.');
  }
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

function createLocalUser(username: string, role: LocalAppRole): AuthUser {
  let uid = localStorage.getItem(LOCAL_UID_KEY);
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem(LOCAL_UID_KEY, uid);
  }
  return { uid, email: null, displayName: username, photoURL: null, role };
}

export function toAuthUser(user: SupabaseUser, username: string, role: LocalAppRole): AuthUser {
  return {
    uid: user.id,
    email: null,
    displayName: username,
    photoURL: null,
    role
  };
}

async function ensureAnonymousSupabaseUser(
  username: string,
  role: LocalAppRole
): Promise<AuthUser> {
  const client = requireSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session?.user.is_anonymous) {
    return toAuthUser(sessionData.session.user, username, role);
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
  return toAuthUser(data.user, username, role);
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

function isLocalRole(value: unknown): value is LocalAppRole {
  return value === 'admin' || value === 'editor' || value === 'viewer';
}

function isStoredLocalAccount(value: unknown): value is StoredLocalAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Partial<StoredLocalAccount>;
  return (
    typeof account.username === 'string' &&
    typeof account.salt === 'string' &&
    typeof account.passwordHash === 'string' &&
    isLocalRole(account.role)
  );
}

function parseLegacyLocalAccount(raw: string): StoredLocalAccount {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored local login settings are invalid. Clear this browser’s site data to reset them.');
  }
  const legacy = parsed as { username?: unknown; salt?: unknown; passwordHash?: unknown };
  if (
    typeof legacy.username !== 'string' ||
    typeof legacy.salt !== 'string' ||
    typeof legacy.passwordHash !== 'string'
  ) {
    throw new Error('Stored local login settings are invalid. Clear this browser’s site data to reset them.');
  }
  return {
    username: legacy.username,
    salt: legacy.salt,
    passwordHash: legacy.passwordHash,
    role: 'admin'
  };
}

async function initializeLocalAccounts(): Promise<StoredLocalAccount[]> {
  const saved = localStorage.getItem(LOCAL_ACCOUNTS_KEY);
  if (saved) {
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every(isStoredLocalAccount)) {
      throw new Error('Stored app accounts are invalid. Clear this browser’s site data to reset them.');
    }
    return parsed;
  }

  const legacy = localStorage.getItem(LOCAL_CREDENTIALS_KEY);
  const accounts: StoredLocalAccount[] = legacy
    ? [parseLegacyLocalAccount(legacy)]
    : [
        {
          username: 'admin',
          salt: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
          passwordHash: '',
          role: 'admin' as const
        }
      ];
  if (!legacy) {
    const defaultAdmin = accounts[0];
    if (!defaultAdmin) throw new Error('Could not initialize the default Admin account.');
    defaultAdmin.passwordHash = await hashPassword('admin', defaultAdmin.salt);
  }
  localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(accounts));
  localStorage.removeItem(LOCAL_CREDENTIALS_KEY);
  return accounts;
}

function getAccount(
  accounts: StoredLocalAccount[],
  username: string
): StoredLocalAccount | undefined {
  return accounts.find((account) => account.username.toLowerCase() === username.toLowerCase());
}

function requireLocalAdmin(accounts: StoredLocalAccount[]): StoredLocalAccount {
  const signedInUsername = localStorage.getItem(LOCAL_SESSION_KEY);
  const signedInAccount = signedInUsername ? getAccount(accounts, signedInUsername) : undefined;
  if (signedInAccount?.role !== 'admin') {
    throw new Error('Only a local app admin can manage app accounts in this browser.');
  }
  return signedInAccount;
}

function validateNewAccount(username: string, password: string): string {
  const normalizedUsername = username.trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(normalizedUsername)) {
    throw new Error('Usernames must be 3–32 characters and use only letters, numbers, dots, underscores, or hyphens.');
  }
  if (password.length < 8) {
    throw new Error('Passwords must be at least 8 characters long.');
  }
  return normalizedUsername;
}

function ensureAdminRemains(accounts: StoredLocalAccount[], changedAccount: StoredLocalAccount): void {
  if (
    changedAccount.role === 'admin' &&
    accounts.filter((account) => account.role === 'admin').length <= 1
  ) {
    throw new Error('At least one Admin account must remain in this browser.');
  }
}

export async function listLocalAppAccounts(): Promise<LocalAppAccount[]> {
  const accounts = await initializeLocalAccounts();
  requireLocalAdmin(accounts);
  return accounts.map(({ username, role }) => ({ username, role }));
}

export async function createLocalAppAccount(
  username: string,
  password: string,
  role: LocalAppRole
): Promise<LocalAppAccount[]> {
  const accounts = await initializeLocalAccounts();
  requireLocalAdmin(accounts);
  const normalizedUsername = validateNewAccount(username, password);
  if (getAccount(accounts, normalizedUsername)) {
    throw new Error('An account with that username already exists.');
  }
  if (!isLocalRole(role)) throw new Error('Select a valid app role.');
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  accounts.push({
    username: normalizedUsername,
    salt,
    passwordHash: await hashPassword(password, salt),
    role
  });
  localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(accounts));
  return accounts.map(({ username: accountName, role: accountRole }) => ({
    username: accountName,
    role: accountRole
  }));
}

export async function updateLocalAppAccount(
  username: string,
  changes: { role?: LocalAppRole; password?: string }
): Promise<LocalAppAccount[]> {
  const accounts = await initializeLocalAccounts();
  requireLocalAdmin(accounts);
  const account = getAccount(accounts, username);
  if (!account) throw new Error('The selected app account no longer exists.');
  if (changes.role !== undefined) {
    if (!isLocalRole(changes.role)) throw new Error('Select a valid app role.');
    if (account.role === 'admin' && changes.role !== 'admin') {
      ensureAdminRemains(accounts, account);
    }
    account.role = changes.role;
  }
  if (changes.password !== undefined) {
    if (changes.password.length < 8) {
      throw new Error('Passwords must be at least 8 characters long.');
    }
    account.salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    account.passwordHash = await hashPassword(changes.password, account.salt);
  }
  localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(accounts));
  if (
    changes.role !== undefined &&
    localStorage.getItem(LOCAL_SESSION_KEY)?.toLowerCase() === account.username.toLowerCase()
  ) {
    window.dispatchEvent(new Event(LOCAL_AUTH_EVENT));
  }
  return accounts.map(({ username: accountName, role }) => ({ username: accountName, role }));
}

export async function deleteLocalAppAccount(username: string): Promise<LocalAppAccount[]> {
  const accounts = await initializeLocalAccounts();
  requireLocalAdmin(accounts);
  const account = getAccount(accounts, username);
  if (!account) throw new Error('The selected app account no longer exists.');
  if (account.role === 'admin') ensureAdminRemains(accounts, account);
  const remainingAccounts = accounts.filter(
    (candidate) => candidate.username.toLowerCase() !== account.username.toLowerCase()
  );
  localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(remainingAccounts));
  if (localStorage.getItem(LOCAL_SESSION_KEY)?.toLowerCase() === account.username.toLowerCase()) {
    signOutUser();
  }
  return remainingAccounts.map(({ username: accountName, role }) => ({
    username: accountName,
    role
  }));
}

async function resolveLocalUser(username: string, role: LocalAppRole): Promise<AuthUser> {
  if (isSupabaseConfigured()) {
    try {
      return await ensureAnonymousSupabaseUser(username, role);
    } catch {
      return createLocalUser(username, role);
    }
  }
  return createLocalUser(username, role);
}

export async function restoreLocalAuth(): Promise<AuthUser | null> {
  const username = localStorage.getItem(LOCAL_SESSION_KEY);
  if (!username) {
    await initializeLocalAccounts();
    return null;
  }
  const accounts = await initializeLocalAccounts();
  const account = getAccount(accounts, username);
  if (!account) {
    localStorage.removeItem(LOCAL_SESSION_KEY);
    return null;
  }
  return resolveLocalUser(account.username, account.role);
}

export async function signInWithLocalCredentials(
  username: string,
  password: string
): Promise<AuthUser> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) {
    throw new Error('Enter your username and password.');
  }
  const accounts = await initializeLocalAccounts();
  const account = getAccount(accounts, normalizedUsername);
  if (!account || (await hashPassword(password, account.salt)) !== account.passwordHash) {
    throw new Error('The username or password is incorrect.');
  }

  localStorage.setItem(LOCAL_SESSION_KEY, account.username);
  const user = await resolveLocalUser(account.username, account.role);
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
