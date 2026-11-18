import {
  Person,
  Client,
  ClientStatus,
  Project,
  ProjectStatus,
  Allocation,
  LeaveEntry,
  LeaveType,
  LeaveTypeMeta,
  EmploymentType,
  DEFAULT_LEAVE_TYPE_CONFIG,
  syncLeaveTypeConfigRegistry
} from '../types';
import {
  AppState,
  getDefaultAppState,
  normalizeAppStatePayload
} from '../data/seedData';
import { ImportMergeMode } from './importExportUtils';

export interface SQLiteAuthCredentials {
  username: string;
  password: string;
}

export interface SQLiteTableStat {
  tableName: string;
  rowCount: number;
  role: 'master' | 'fact' | 'config';
}

export interface SQLiteDatabaseStats {
  engineReady: boolean;
  engineLabel: string;
  storageBackend: 'indexeddb+localstorage' | 'localstorage' | 'memory';
  byteSize: number;
  lastSyncedAt: string;
  tables: SQLiteTableStat[];
  errorMessage?: string;
}

interface SqlJsDatabase {
  run: (sql: string, params?: unknown[]) => void;
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  export: () => Uint8Array;
  close: () => void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

declare global {
  interface Window {
    initSqlJs?: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  }
}

const SQLITE_IDB_NAME = 'allocat_sqlite_idb';
const SQLITE_IDB_STORE = 'databases';
const SQLITE_IDB_KEY = 'workspace.sqlite';
const SQLITE_B64_KEY = 'allocat_sqlite_b64_v1';
const LEGACY_STATE_KEY = 'allocat_app_state_v1';
const LEGACY_V2_KEY = 'staffgrid_app_state_v2';
const LEGACY_AUTH_KEY = 'allocat_auth_credentials_v1';
const SQL_WASM_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/';

export const SQLITE_RELATIONAL_SCHEMA_DDL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planning_years (
  year INTEGER PRIMARY KEY,
  is_selected INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS departments (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_types (
  type_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  badge_class TEXT NOT NULL,
  icon_name TEXT NOT NULL,
  default_impact INTEGER NOT NULL DEFAULT 50
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL REFERENCES departments(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  employment_type TEXT NOT NULL DEFAULT 'Internal' CHECK (employment_type IN ('Internal', 'External', 'B2B')),
  email TEXT NOT NULL DEFAULT '',
  max_capacity_percent INTEGER NOT NULL DEFAULT 100,
  avatar_color TEXT NOT NULL,
  initials TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lead', 'completed'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'planned', 'completed')),
  color TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  year INTEGER NOT NULL,
  jan INTEGER NOT NULL DEFAULT 0,
  feb INTEGER NOT NULL DEFAULT 0,
  mar INTEGER NOT NULL DEFAULT 0,
  apr INTEGER NOT NULL DEFAULT 0,
  may INTEGER NOT NULL DEFAULT 0,
  jun INTEGER NOT NULL DEFAULT 0,
  jul INTEGER NOT NULL DEFAULT 0,
  aug INTEGER NOT NULL DEFAULT 0,
  sep INTEGER NOT NULL DEFAULT 0,
  oct INTEGER NOT NULL DEFAULT 0,
  nov INTEGER NOT NULL DEFAULT 0,
  dec INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE(person_id, project_id, year)
);

CREATE TABLE IF NOT EXISTS leaves (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  start_month INTEGER NOT NULL CHECK (start_month BETWEEN 0 AND 11),
  end_month INTEGER NOT NULL CHECK (end_month BETWEEN 0 AND 11),
  impact_percent INTEGER NOT NULL DEFAULT 100,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_allocations_year_person ON allocations(year, person_id);
CREATE INDEX IF NOT EXISTS idx_allocations_year_project ON allocations(year, project_id);
CREATE INDEX IF NOT EXISTS idx_leaves_year_person ON leaves(year, person_id);

CREATE VIEW IF NOT EXISTS v_allocation_months AS
SELECT
  a.id AS allocation_id,
  a.year,
  p.id AS person_id,
  p.full_name AS person_name,
  p.department,
  p.employment_type,
  c.name AS client_name,
  pr.id AS project_id,
  pr.code AS project_code,
  pr.name AS project_name,
  a.jan, a.feb, a.mar, a.apr, a.may, a.jun,
  a.jul, a.aug, a.sep, a.oct, a.nov, a.dec,
  ROUND((a.jan + a.feb + a.mar + a.apr + a.may + a.jun + a.jul + a.aug + a.sep + a.oct + a.nov + a.dec) / 12.0, 1) AS annual_avg_pct
FROM allocations a
JOIN people p ON p.id = a.person_id
JOIN projects pr ON pr.id = a.project_id
JOIN clients c ON c.id = pr.client_id;

CREATE VIEW IF NOT EXISTS v_person_annual_summary AS
SELECT
  py.year,
  p.id AS person_id,
  p.full_name,
  p.department,
  p.employment_type,
  p.max_capacity_percent,
  COALESCE(ROUND(SUM(a.jan + a.feb + a.mar + a.apr + a.may + a.jun + a.jul + a.aug + a.sep + a.oct + a.nov + a.dec) / 12.0, 1), 0) AS avg_allocated_pct
FROM planning_years py
CROSS JOIN people p
LEFT JOIN allocations a ON a.person_id = p.id AND a.year = py.year
GROUP BY py.year, p.id;`;

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
let activeDb: SqlJsDatabase | null = null;
let lastSyncedAt: string = new Date().toISOString();
let lastByteSize = 0;
let storageBackend: SQLiteDatabaseStats['storageBackend'] = 'memory';
let lastEngineError: string | undefined;

function getSqlWasmBasePaths(): string[] {
  if (typeof window === 'undefined') return ['./sql-wasm/'];
  const pathname = window.location.pathname || '/';
  const paths = ['./sql-wasm/'];
  if (pathname.startsWith('/AlloCat')) {
    paths.unshift('/AlloCat/sql-wasm/');
  }
  paths.push(SQL_WASM_CDN_URL);
  return Array.from(new Set(paths));
}

function loadClassicScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-allocat-sqljs="${url}"]`);
    if (existing) {
      if (typeof window.initSqlJs === 'function') {
        resolve();
      } else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), {
          once: true
        });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.setAttribute('data-allocat-sqljs', url);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(script);
  });
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise) return sqlJsPromise;

  sqlJsPromise = (async () => {
    const basePaths = getSqlWasmBasePaths();
    let lastError: unknown = null;

    for (const base of basePaths) {
      try {
        if (typeof window.initSqlJs !== 'function') {
          await loadClassicScript(`${base}sql-wasm.js`);
        }
        if (typeof window.initSqlJs === 'function') {
          const SQL = await window.initSqlJs({
            locateFile: (file: string) => `${base}${file}`
          });
          lastEngineError = undefined;
          return SQL;
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Unable to initialize SQLite WebAssembly runtime.');
  })();

  try {
    return await sqlJsPromise;
  } catch (err) {
    sqlJsPromise = null;
    lastEngineError = err instanceof Error ? err.message : 'SQLite WASM load error';
    throw err;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function openSQLiteIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(SQLITE_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SQLITE_IDB_STORE)) {
        db.createObjectStore(SQLITE_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
  });
}

async function readBinaryFromIdb(): Promise<Uint8Array | null> {
  try {
    const idb = await openSQLiteIdb();
    return await new Promise<Uint8Array | null>((resolve) => {
      const tx = idb.transaction(SQLITE_IDB_STORE, 'readonly');
      const store = tx.objectStore(SQLITE_IDB_STORE);
      const req = store.get(SQLITE_IDB_KEY);
      req.onsuccess = () => {
        const res = req.result;
        if (res instanceof Uint8Array) resolve(res);
        else if (res instanceof ArrayBuffer) resolve(new Uint8Array(res));
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeBinaryToIdb(bytes: Uint8Array): Promise<boolean> {
  try {
    const idb = await openSQLiteIdb();
    return await new Promise<boolean>((resolve) => {
      const tx = idb.transaction(SQLITE_IDB_STORE, 'readwrite');
      const store = tx.objectStore(SQLITE_IDB_STORE);
      store.put(bytes, SQLITE_IDB_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

function readBinaryFromLocalStorage(): Uint8Array | null {
  try {
    const b64 = localStorage.getItem(SQLITE_B64_KEY);
    if (!b64) return null;
    const bytes = base64ToUint8(b64);
    return isSQLiteBinaryHeader(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function writeBinaryToLocalStorage(bytes: Uint8Array): boolean {
  try {
    localStorage.setItem(SQLITE_B64_KEY, uint8ToBase64(bytes));
    return true;
  } catch {
    return false;
  }
}

function readAndNormalizeLegacyState(): { state: AppState; migratedFrom?: string } {
  try {
    const rawV1 = localStorage.getItem(LEGACY_STATE_KEY);
    const rawV2 = localStorage.getItem(LEGACY_V2_KEY);
    const raw = rawV1 || rawV2;
    if (raw) {
      const parsed = JSON.parse(raw);
      const normalized = normalizeAppStatePayload(parsed);
      if (normalized) {
        return {
          state: normalized,
          migratedFrom: rawV1 ? LEGACY_STATE_KEY : LEGACY_V2_KEY
        };
      }
    }
  } catch {
    // Fall back cleanly to default state
  }
  return { state: getDefaultAppState() };
}

function readLegacyAuthCredentials(): SQLiteAuthCredentials {
  try {
    const raw = localStorage.getItem(LEGACY_AUTH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.username === 'string' &&
        parsed.username.trim().length > 0 &&
        typeof parsed?.password === 'string' &&
        parsed.password.length > 0
      ) {
        return {
          username: parsed.username.trim(),
          password: parsed.password
        };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { username: 'admin', password: 'admin' };
}

function cleanupLegacyLocalStorageKeys(): void {
  try {
    localStorage.removeItem(LEGACY_STATE_KEY);
    localStorage.removeItem(LEGACY_V2_KEY);
    localStorage.removeItem(LEGACY_AUTH_KEY);
  } catch {
    // Ignore storage cleanup errors
  }
}

export function isSQLiteBinaryHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const header = 'SQLite format 3';
  for (let i = 0; i < header.length; i++) {
    if (bytes[i] !== header.charCodeAt(i)) return false;
  }
  return true;
}

function ensureSchema(db: SqlJsDatabase): void {
  db.run(SQLITE_RELATIONAL_SCHEMA_DDL);
}

function normalizeMonthsArray(raw: unknown[]): number[] {
  const out = Array(12).fill(0);
  for (let i = 0; i < 12; i++) {
    const val = Number(raw[i] ?? 0);
    out[i] = Number.isFinite(val) ? Math.max(0, Math.round(val)) : 0;
  }
  return out;
}

function writeAuthUserIntoDb(db: SqlJsDatabase, creds: SQLiteAuthCredentials): void {
  const now = new Date().toISOString();
  db.run('BEGIN TRANSACTION;');
  try {
    db.run('DELETE FROM auth_users;');
    db.run(
      'INSERT INTO auth_users (username, password, role, updated_at) VALUES (?, ?, ?, ?);',
      [creds.username.trim() || 'admin', creds.password || 'admin', 'admin', now]
    );
    db.run('COMMIT;');
  } catch (err) {
    db.run('ROLLBACK;');
    throw err;
  }
}

function readAuthUserFromDb(db: SqlJsDatabase): SQLiteAuthCredentials | null {
  if (!tableExists(db, 'auth_users')) return null;
  const rows = queryRows(db, 'SELECT username, password FROM auth_users LIMIT 1;');
  if (rows.length === 0) return null;
  const username = String(rows[0].username || '').trim();
  const password = String(rows[0].password || '');
  if (!username || !password) return null;
  return { username, password };
}

function writeStateIntoDb(
  db: SqlJsDatabase,
  state: AppState,
  migratedFrom?: string
): void {
  ensureSchema(db);
  const now = new Date().toISOString();

  db.run('PRAGMA foreign_keys = OFF;');
  db.run('BEGIN TRANSACTION;');
  try {
    db.run('DELETE FROM leaves;');
    db.run('DELETE FROM allocations;');
    db.run('DELETE FROM projects;');
    db.run('DELETE FROM clients;');
    db.run('DELETE FROM people;');
    db.run('DELETE FROM leave_types;');
    db.run('DELETE FROM departments;');
    db.run('DELETE FROM planning_years;');
    db.run('DELETE FROM workspace_meta;');

    db.run(
      'INSERT INTO workspace_meta (key, value, updated_at) VALUES (?, ?, ?);',
      ['schema_version', '2', now]
    );
    db.run(
      'INSERT INTO workspace_meta (key, value, updated_at) VALUES (?, ?, ?);',
      ['engine', 'sql.js-wasm', now]
    );
    if (migratedFrom) {
      db.run(
        'INSERT INTO workspace_meta (key, value, updated_at) VALUES (?, ?, ?);',
        ['migrated_from', migratedFrom, now]
      );
    }

    const years =
      state.availableYears && state.availableYears.length > 0
        ? Array.from(new Set(state.availableYears)).sort((a, b) => a - b)
        : [2025, 2026, 2027];
    const selectedYear = years.includes(state.selectedYear) ? state.selectedYear : years[0];
    for (const yr of years) {
      db.run('INSERT OR REPLACE INTO planning_years (year, is_selected) VALUES (?, ?);', [
        yr,
        yr === selectedYear ? 1 : 0
      ]);
    }

    const deptSet = new Set<string>(state.departments || []);
    for (const p of state.people) {
      if (p.department) deptSet.add(p.department);
    }
    let deptOrder = 0;
    for (const dept of deptSet) {
      db.run('INSERT OR REPLACE INTO departments (name, sort_order) VALUES (?, ?);', [
        dept,
        deptOrder++
      ]);
    }

    const leaveTypesMap =
      state.leaveTypes && Object.keys(state.leaveTypes).length > 0
        ? state.leaveTypes
        : DEFAULT_LEAVE_TYPE_CONFIG;
    for (const [key, meta] of Object.entries(leaveTypesMap)) {
      db.run(
        'INSERT OR REPLACE INTO leave_types (type_key, label, badge_class, icon_name, default_impact) VALUES (?, ?, ?, ?, ?);',
        [
          key,
          meta.label,
          meta.badgeClass,
          meta.iconName || 'CalendarOff',
          meta.defaultImpact ?? 50
        ]
      );
    }

    const personIds = new Set<string>();
    for (const p of state.people) {
      personIds.add(p.id);
      const emp: EmploymentType =
        p.employmentType === 'External' || p.employmentType === 'B2B'
          ? p.employmentType
          : 'Internal';
      db.run(
        `INSERT OR REPLACE INTO people (
          id, first_name, last_name, full_name, role, department,
          employment_type, email, max_capacity_percent, avatar_color, initials, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          p.id,
          p.firstName || p.name.split(' ')[0] || 'Team',
          p.lastName || '',
          p.name,
          p.role || 'Specialist',
          p.department || 'Engineering',
          emp,
          p.email || '',
          p.maxCapacityPercent ?? 100,
          p.avatarColor || '#2563EB',
          p.initials || 'TM',
          p.notes || ''
        ]
      );
    }

    const clientIds = new Set<string>();
    for (const c of state.clients) {
      clientIds.add(c.id);
      const status: ClientStatus =
        c.status === 'lead' || c.status === 'completed' ? c.status : 'active';
      db.run(
        'INSERT OR REPLACE INTO clients (id, name, industry, color, status) VALUES (?, ?, ?, ?, ?);',
        [c.id, c.name, c.industry || '', c.color || '#2563EB', status]
      );
    }

    const projectIds = new Set<string>();
    for (const proj of state.projects) {
      if (!clientIds.has(proj.clientId)) continue;
      projectIds.add(proj.id);
      const status: ProjectStatus =
        proj.status === 'planned' || proj.status === 'completed' ? proj.status : 'active';
      db.run(
        `INSERT OR REPLACE INTO projects (
          id, client_id, name, code, status, color, billable, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          proj.id,
          proj.clientId,
          proj.name,
          proj.code || 'PRJ',
          status,
          proj.color || '#2563EB',
          proj.billable ? 1 : 0,
          proj.notes || ''
        ]
      );
    }

    for (const alloc of state.allocations) {
      if (!personIds.has(alloc.personId) || !projectIds.has(alloc.projectId)) continue;
      const m = normalizeMonthsArray(alloc.monthlyPercentage || []);
      db.run(
        `INSERT OR REPLACE INTO allocations (
          id, person_id, project_id, year,
          jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          alloc.id,
          alloc.personId,
          alloc.projectId,
          alloc.year,
          m[0],
          m[1],
          m[2],
          m[3],
          m[4],
          m[5],
          m[6],
          m[7],
          m[8],
          m[9],
          m[10],
          m[11],
          alloc.notes || ''
        ]
      );
    }

    for (const leave of state.leaves) {
      if (!personIds.has(leave.personId)) continue;
      const startMonth = Math.max(0, Math.min(11, Number(leave.startMonth ?? 0)));
      const endMonth = Math.max(startMonth, Math.min(11, Number(leave.endMonth ?? startMonth)));
      db.run(
        `INSERT OR REPLACE INTO leaves (
          id, person_id, leave_type, title, year, start_month, end_month, impact_percent, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          leave.id,
          leave.personId,
          leave.type || 'vacation',
          leave.title || 'Time Off',
          leave.year,
          startMonth,
          endMonth,
          leave.impactPercent ?? 100,
          leave.notes || ''
        ]
      );
    }

    db.run('COMMIT;');
  } catch (err) {
    db.run('ROLLBACK;');
    throw err;
  } finally {
    db.run('PRAGMA foreign_keys = ON;');
  }
}

function queryRows(db: SqlJsDatabase, sql: string): Record<string, unknown>[] {
  try {
    const res = db.exec(sql);
    if (!res || res.length === 0) return [];
    const { columns, values } = res[0];
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  } catch {
    return [];
  }
}

function tableExists(db: SqlJsDatabase, tableName: string): boolean {
  const rows = queryRows(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}';`
  );
  return rows.length > 0;
}

function readAppStateFromDb(db: SqlJsDatabase): AppState | null {
  if (!tableExists(db, 'people') || !tableExists(db, 'clients') || !tableExists(db, 'projects')) {
    return null;
  }

  const yearRows = tableExists(db, 'planning_years')
    ? queryRows(db, 'SELECT year, is_selected FROM planning_years ORDER BY year ASC;')
    : [];
  const availableYears =
    yearRows.length > 0
      ? yearRows.map((r) => Number(r.year)).filter((y) => Number.isFinite(y))
      : [2025, 2026, 2027];
  const selectedYearRow = yearRows.find((r) => Number(r.is_selected) === 1);
  const selectedYear = selectedYearRow
    ? Number(selectedYearRow.year)
    : availableYears[0] || 2026;

  const deptRows = tableExists(db, 'departments')
    ? queryRows(db, 'SELECT name FROM departments ORDER BY sort_order ASC, name ASC;')
    : [];

  const leaveTypeRows = tableExists(db, 'leave_types')
    ? queryRows(
        db,
        'SELECT type_key, label, badge_class, icon_name, default_impact FROM leave_types;'
      )
    : [];
  const leaveTypes: Record<LeaveType, LeaveTypeMeta> =
    leaveTypeRows.length > 0 ? {} : { ...DEFAULT_LEAVE_TYPE_CONFIG };
  for (const r of leaveTypeRows) {
    const key = String(r.type_key || '').trim();
    if (!key) continue;
    leaveTypes[key] = {
      label: String(r.label || key),
      badgeClass: String(r.badge_class || DEFAULT_LEAVE_TYPE_CONFIG.vacation.badgeClass),
      iconName: String(r.icon_name || 'CalendarOff'),
      defaultImpact: Number(r.default_impact ?? 50)
    };
  }
  syncLeaveTypeConfigRegistry(leaveTypes);

  const peopleRows = queryRows(db, 'SELECT * FROM people;');
  const people: Person[] = peopleRows.map((r) => {
    const fullName =
      String(r.full_name || r.name || `${r.first_name || ''} ${r.last_name || ''}`).trim() ||
      'Team Member';
    const parts = fullName.split(/\s+/);
    const firstName = String(r.first_name || parts[0] || 'Team');
    const lastName = String(
      r.last_name !== undefined && r.last_name !== null ? r.last_name : parts.slice(1).join(' ')
    );
    const empRaw = String(r.employment_type || 'Internal');
    const employmentType: EmploymentType =
      empRaw === 'External' || empRaw === 'B2B' ? empRaw : 'Internal';
    return {
      id: String(r.id),
      firstName,
      lastName,
      name: fullName,
      role: String(r.role || 'Specialist'),
      department: String(r.department || 'Engineering'),
      employmentType,
      email: String(r.email || ''),
      maxCapacityPercent: Number(r.max_capacity_percent ?? 100),
      avatarColor: String(r.avatar_color || '#2563EB'),
      initials: String(r.initials || fullName.slice(0, 2).toUpperCase()),
      notes: String(r.notes || '')
    };
  });

  const deptSet = new Set<string>(deptRows.map((d) => String(d.name)).filter(Boolean));
  for (const p of people) {
    if (p.department) deptSet.add(p.department);
  }
  const departments = deptSet.size > 0 ? Array.from(deptSet) : ['Engineering', 'Design', 'Product'];

  const clientRows = queryRows(db, 'SELECT * FROM clients;');
  const clients: Client[] = clientRows.map((r) => {
    const st = String(r.status || 'active');
    return {
      id: String(r.id),
      name: String(r.name || 'Client'),
      industry: String(r.industry || ''),
      color: String(r.color || '#2563EB'),
      status: st === 'lead' || st === 'completed' ? st : 'active'
    };
  });

  const projectRows = queryRows(db, 'SELECT * FROM projects;');
  const projects: Project[] = projectRows.map((r) => {
    const st = String(r.status || 'active');
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      name: String(r.name || 'Project'),
      code: String(r.code || 'PRJ'),
      status: st === 'planned' || st === 'completed' ? st : 'active',
      color: String(r.color || '#2563EB'),
      billable: Number(r.billable ?? 1) !== 0,
      notes: String(r.notes || '')
    };
  });

  const allocRows = tableExists(db, 'allocations')
    ? queryRows(db, 'SELECT * FROM allocations;')
    : [];
  const allocations: Allocation[] = allocRows.map((r) => ({
    id: String(r.id),
    personId: String(r.person_id),
    projectId: String(r.project_id),
    year: Number(r.year || selectedYear),
    monthlyPercentage: [
      Number(r.jan ?? 0),
      Number(r.feb ?? 0),
      Number(r.mar ?? 0),
      Number(r.apr ?? 0),
      Number(r.may ?? 0),
      Number(r.jun ?? 0),
      Number(r.jul ?? 0),
      Number(r.aug ?? 0),
      Number(r.sep ?? 0),
      Number(r.oct ?? 0),
      Number(r.nov ?? 0),
      Number(r.dec ?? 0)
    ],
    notes: String(r.notes || '')
  }));

  const leaveRows = tableExists(db, 'leaves') ? queryRows(db, 'SELECT * FROM leaves;') : [];
  const leaves: LeaveEntry[] = leaveRows.map((r) => ({
    id: String(r.id),
    personId: String(r.person_id),
    type: String(r.leave_type || 'vacation'),
    title: String(r.title || 'Time Off'),
    year: Number(r.year || selectedYear),
    startMonth: Number(r.start_month ?? 0),
    endMonth: Number(r.end_month ?? r.start_month ?? 0),
    impactPercent: Number(r.impact_percent ?? 100),
    notes: String(r.notes || '')
  }));

  return {
    people,
    clients,
    projects,
    allocations,
    leaves,
    availableYears,
    selectedYear,
    departments,
    leaveTypes
  };
}

function buildStatsFromState(state: AppState, db?: SqlJsDatabase | null): SQLiteDatabaseStats {
  const countTable = (name: string, fallback: number): number => {
    if (!db) return fallback;
    try {
      const res = db.exec(`SELECT COUNT(*) FROM ${name};`);
      return Number(res[0]?.values?.[0]?.[0] ?? fallback);
    } catch {
      return fallback;
    }
  };

  return {
    engineReady: Boolean(db),
    engineLabel: db ? 'SQLite 3 (sql.js WASM)' : 'SQLite WASM Standby',
    storageBackend,
    byteSize: lastByteSize,
    lastSyncedAt,
    errorMessage: lastEngineError,
    tables: [
      { tableName: 'people', rowCount: countTable('people', state.people.length), role: 'master' },
      { tableName: 'clients', rowCount: countTable('clients', state.clients.length), role: 'master' },
      { tableName: 'projects', rowCount: countTable('projects', state.projects.length), role: 'master' },
      {
        tableName: 'allocations',
        rowCount: countTable('allocations', state.allocations.length),
        role: 'fact'
      },
      { tableName: 'leaves', rowCount: countTable('leaves', state.leaves.length), role: 'fact' },
      {
        tableName: 'departments',
        rowCount: countTable('departments', state.departments.length),
        role: 'config'
      },
      {
        tableName: 'leave_types',
        rowCount: countTable(
          'leave_types',
          Object.keys(state.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG).length
        ),
        role: 'config'
      },
      {
        tableName: 'planning_years',
        rowCount: countTable('planning_years', state.availableYears.length),
        role: 'config'
      },
      { tableName: 'auth_users', rowCount: countTable('auth_users', 1), role: 'config' },
      { tableName: 'workspace_meta', rowCount: countTable('workspace_meta', 2), role: 'config' }
    ]
  };
}

async function persistActiveDb(db: SqlJsDatabase): Promise<void> {
  const bytes = db.export();
  lastByteSize = bytes.byteLength;
  lastSyncedAt = new Date().toISOString();
  const idbSaved = await writeBinaryToIdb(bytes);
  const lsSaved = writeBinaryToLocalStorage(bytes);
  if (idbSaved) storageBackend = 'indexeddb+localstorage';
  else if (lsSaved) storageBackend = 'localstorage';
  else storageBackend = 'memory';
}

export async function initSQLiteWorkspace(): Promise<{
  state: AppState;
  authCredentials: SQLiteAuthCredentials;
  stats: SQLiteDatabaseStats;
}> {
  const legacyAuth = readLegacyAuthCredentials();
  const { state: legacyOrDefaultState, migratedFrom } = readAndNormalizeLegacyState();

  try {
    const SQL = await getSqlJs();

    // 1. Check for embedded SQLite binary snapshot (e.g., Portable Single-File HTML)
    let embeddedBytes: Uint8Array | null = null;
    if (typeof window !== 'undefined' && window.__ALLOCAT_EMBEDDED_SQLITE__) {
      try {
        const candidate = base64ToUint8(window.__ALLOCAT_EMBEDDED_SQLITE__);
        if (isSQLiteBinaryHeader(candidate)) {
          embeddedBytes = candidate;
        }
      } catch {
        embeddedBytes = null;
      }
    }

    const idbBytes = await readBinaryFromIdb();
    const lsBytes = readBinaryFromLocalStorage();
    const existingBytes = embeddedBytes || idbBytes || lsBytes;

    if (existingBytes && isSQLiteBinaryHeader(existingBytes)) {
      try {
        const db = new SQL.Database(existingBytes);
        ensureSchema(db);
        const hydrated = readAppStateFromDb(db);
        let authCreds = readAuthUserFromDb(db);

        if (!authCreds) {
          authCreds = legacyAuth;
          writeAuthUserIntoDb(db, authCreds);
          await persistActiveDb(db);
        }

        if (hydrated && hydrated.people.length + hydrated.clients.length + hydrated.projects.length > 0) {
          activeDb = db;
          lastByteSize = existingBytes.byteLength;
          storageBackend = idbBytes ? 'indexeddb+localstorage' : 'localstorage';
          if (embeddedBytes && !idbBytes) {
            await persistActiveDb(db);
          }
          cleanupLegacyLocalStorageKeys();
          return {
            state: hydrated,
            authCredentials: authCreds,
            stats: buildStatsFromState(hydrated, db)
          };
        }
        db.close();
      } catch {
        // Corrupted binary: rebuild cleanly from migrated/default state
      }
    }

    // 2. Fresh database creation (migrating any legacy localStorage JSON into SQLite tables)
    const freshDb = new SQL.Database();
    writeStateIntoDb(freshDb, legacyOrDefaultState, migratedFrom);
    writeAuthUserIntoDb(freshDb, legacyAuth);
    activeDb = freshDb;
    await persistActiveDb(freshDb);
    cleanupLegacyLocalStorageKeys();

    return {
      state: legacyOrDefaultState,
      authCredentials: legacyAuth,
      stats: buildStatsFromState(legacyOrDefaultState, freshDb)
    };
  } catch {
    return {
      state: legacyOrDefaultState,
      authCredentials: legacyAuth,
      stats: buildStatsFromState(legacyOrDefaultState, null)
    };
  }
}

export async function syncAppStateToSQLite(state: AppState): Promise<SQLiteDatabaseStats> {
  try {
    syncLeaveTypeConfigRegistry(state.leaveTypes);
    const SQL = await getSqlJs();
    if (!activeDb) {
      activeDb = new SQL.Database();
    }
    writeStateIntoDb(activeDb, state);
    await persistActiveDb(activeDb);
    return buildStatsFromState(state, activeDb);
  } catch {
    return buildStatsFromState(state, activeDb);
  }
}

export async function saveAuthCredentialsToSQLite(creds: SQLiteAuthCredentials): Promise<void> {
  try {
    const SQL = await getSqlJs();
    if (!activeDb) {
      activeDb = new SQL.Database();
      ensureSchema(activeDb);
    }
    writeAuthUserIntoDb(activeDb, creds);
    await persistActiveDb(activeDb);
    cleanupLegacyLocalStorageKeys();
  } catch {
    // Ignore errors if WASM unavailable
  }
}

export async function resetSQLiteWorkspace(): Promise<{
  state: AppState;
  stats: SQLiteDatabaseStats;
}> {
  const defaults = getDefaultAppState();
  const stats = await syncAppStateToSQLite(defaults);
  cleanupLegacyLocalStorageKeys();
  return { state: defaults, stats };
}

export function getSQLiteDatabaseStats(state: AppState): SQLiteDatabaseStats {
  return buildStatsFromState(state, activeDb);
}

export async function exportSQLiteBinaryFile(state: AppState): Promise<Uint8Array> {
  const SQL = await getSqlJs();
  if (!activeDb) {
    activeDb = new SQL.Database();
  }
  writeStateIntoDb(activeDb, state);
  await persistActiveDb(activeDb);
  return activeDb.export();
}

export async function exportSQLiteBase64Snapshot(state: AppState): Promise<string> {
  const bytes = await exportSQLiteBinaryFile(state);
  return uint8ToBase64(bytes);
}

function sqlLiteral(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '0';
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

export function exportSQLDumpScript(state: AppState): string {
  const lines: string[] = [];
  const exportedAt = new Date().toISOString();

  lines.push('-- ============================================================');
  lines.push(`-- AlloCat SQLite Relational Database Dump (${exportedAt})`);
  lines.push('-- Engine: SQLite 3 (Normalized 10-Table Schema + Views)');
  lines.push('-- ============================================================');
  lines.push('');
  lines.push('PRAGMA foreign_keys = OFF;');
  lines.push('BEGIN TRANSACTION;');
  lines.push('');
  lines.push(SQLITE_RELATIONAL_SCHEMA_DDL);
  lines.push('');
  lines.push('-- Clear existing workspace tables before loading snapshot');
  lines.push('DELETE FROM leaves;');
  lines.push('DELETE FROM allocations;');
  lines.push('DELETE FROM projects;');
  lines.push('DELETE FROM clients;');
  lines.push('DELETE FROM people;');
  lines.push('DELETE FROM leave_types;');
  lines.push('DELETE FROM departments;');
  lines.push('DELETE FROM planning_years;');
  lines.push('DELETE FROM workspace_meta;');
  lines.push('');

  lines.push(
    `INSERT OR REPLACE INTO workspace_meta (key, value, updated_at) VALUES (${sqlLiteral('schema_version')}, ${sqlLiteral('2')}, ${sqlLiteral(exportedAt)});`
  );
  lines.push(
    `INSERT OR REPLACE INTO workspace_meta (key, value, updated_at) VALUES (${sqlLiteral('exported_at')}, ${sqlLiteral(exportedAt)}, ${sqlLiteral(exportedAt)});`
  );
  lines.push('');

  const years =
    state.availableYears && state.availableYears.length > 0
      ? Array.from(new Set(state.availableYears)).sort((a, b) => a - b)
      : [2025, 2026, 2027];
  for (const yr of years) {
    lines.push(
      `INSERT OR REPLACE INTO planning_years (year, is_selected) VALUES (${yr}, ${
        yr === state.selectedYear ? 1 : 0
      });`
    );
  }
  lines.push('');

  const depts = new Set<string>(state.departments || []);
  for (const p of state.people) {
    if (p.department) depts.add(p.department);
  }
  let order = 0;
  for (const dept of depts) {
    lines.push(
      `INSERT OR REPLACE INTO departments (name, sort_order) VALUES (${sqlLiteral(dept)}, ${order++});`
    );
  }
  lines.push('');

  const leaveTypesMap =
    state.leaveTypes && Object.keys(state.leaveTypes).length > 0
      ? state.leaveTypes
      : DEFAULT_LEAVE_TYPE_CONFIG;
  for (const [key, meta] of Object.entries(leaveTypesMap)) {
    lines.push(
      `INSERT OR REPLACE INTO leave_types (type_key, label, badge_class, icon_name, default_impact) VALUES (${sqlLiteral(
        key
      )}, ${sqlLiteral(meta.label)}, ${sqlLiteral(meta.badgeClass)}, ${sqlLiteral(
        meta.iconName || 'CalendarOff'
      )}, ${meta.defaultImpact ?? 50});`
    );
  }
  lines.push('');

  const personIds = new Set<string>();
  for (const p of state.people) {
    personIds.add(p.id);
    const emp =
      p.employmentType === 'External' || p.employmentType === 'B2B'
        ? p.employmentType
        : 'Internal';
    lines.push(
      `INSERT OR REPLACE INTO people (id, first_name, last_name, full_name, role, department, employment_type, email, max_capacity_percent, avatar_color, initials, notes) VALUES (${sqlLiteral(
        p.id
      )}, ${sqlLiteral(p.firstName || '')}, ${sqlLiteral(p.lastName || '')}, ${sqlLiteral(
        p.name
      )}, ${sqlLiteral(p.role)}, ${sqlLiteral(p.department)}, ${sqlLiteral(emp)}, ${sqlLiteral(
        p.email || ''
      )}, ${p.maxCapacityPercent ?? 100}, ${sqlLiteral(p.avatarColor || '#2563EB')}, ${sqlLiteral(
        p.initials || 'TM'
      )}, ${sqlLiteral(p.notes || '')});`
    );
  }
  lines.push('');

  const clientIds = new Set<string>();
  for (const c of state.clients) {
    clientIds.add(c.id);
    lines.push(
      `INSERT OR REPLACE INTO clients (id, name, industry, color, status) VALUES (${sqlLiteral(
        c.id
      )}, ${sqlLiteral(c.name)}, ${sqlLiteral(c.industry || '')}, ${sqlLiteral(
        c.color || '#2563EB'
      )}, ${sqlLiteral(c.status || 'active')});`
    );
  }
  lines.push('');

  const projectIds = new Set<string>();
  for (const pr of state.projects) {
    if (!clientIds.has(pr.clientId)) continue;
    projectIds.add(pr.id);
    lines.push(
      `INSERT OR REPLACE INTO projects (id, client_id, name, code, status, color, billable, notes) VALUES (${sqlLiteral(
        pr.id
      )}, ${sqlLiteral(pr.clientId)}, ${sqlLiteral(pr.name)}, ${sqlLiteral(
        pr.code
      )}, ${sqlLiteral(pr.status || 'active')}, ${sqlLiteral(pr.color || '#2563EB')}, ${
        pr.billable ? 1 : 0
      }, ${sqlLiteral(pr.notes || '')});`
    );
  }
  lines.push('');

  for (const a of state.allocations) {
    if (!personIds.has(a.personId) || !projectIds.has(a.projectId)) continue;
    const m = normalizeMonthsArray(a.monthlyPercentage || []);
    lines.push(
      `INSERT OR REPLACE INTO allocations (id, person_id, project_id, year, jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec, notes) VALUES (${sqlLiteral(
        a.id
      )}, ${sqlLiteral(a.personId)}, ${sqlLiteral(a.projectId)}, ${a.year}, ${m.join(
        ', '
      )}, ${sqlLiteral(a.notes || '')});`
    );
  }
  lines.push('');

  for (const l of state.leaves) {
    if (!personIds.has(l.personId)) continue;
    lines.push(
      `INSERT OR REPLACE INTO leaves (id, person_id, leave_type, title, year, start_month, end_month, impact_percent, notes) VALUES (${sqlLiteral(
        l.id
      )}, ${sqlLiteral(l.personId)}, ${sqlLiteral(l.type)}, ${sqlLiteral(l.title)}, ${
        l.year
      }, ${l.startMonth}, ${l.endMonth}, ${l.impactPercent}, ${sqlLiteral(l.notes || '')});`
    );
  }
  lines.push('');
  lines.push('COMMIT;');
  lines.push('PRAGMA foreign_keys = ON;');
  lines.push('');

  return lines.join('\n');
}

function mergeImportedState(
  imported: AppState,
  currentState: AppState,
  mergeMode: ImportMergeMode
): { nextState: AppState; summaryMessage: string } {
  if (mergeMode === 'replace') {
    const nextState: AppState = {
      ...imported,
      leaveTypes:
        imported.leaveTypes && Object.keys(imported.leaveTypes).length > 0
          ? imported.leaveTypes
          : { ...DEFAULT_LEAVE_TYPE_CONFIG }
    };
    syncLeaveTypeConfigRegistry(nextState.leaveTypes);
    return {
      nextState,
      summaryMessage: `Replaced workspace from SQLite (${nextState.people.length} people, ${nextState.clients.length} clients, ${nextState.projects.length} projects, ${nextState.allocations.length} allocations, ${nextState.leaves.length} leaves).`
    };
  }

  const departments = Array.from(
    new Set([...currentState.departments, ...imported.departments])
  );
  const availableYears = Array.from(
    new Set([...currentState.availableYears, ...imported.availableYears])
  ).sort((a, b) => a - b);

  const leaveTypes: Record<LeaveType, LeaveTypeMeta> = {
    ...(currentState.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG),
    ...(imported.leaveTypes || {})
  };
  syncLeaveTypeConfigRegistry(leaveTypes);

  const peopleMap = new Map<string, Person>();
  for (const p of currentState.people) peopleMap.set(p.id, p);
  for (const p of imported.people) peopleMap.set(p.id, p);

  const clientsMap = new Map<string, Client>();
  for (const c of currentState.clients) clientsMap.set(c.id, c);
  for (const c of imported.clients) clientsMap.set(c.id, c);

  const projectsMap = new Map<string, Project>();
  for (const pr of currentState.projects) projectsMap.set(pr.id, pr);
  for (const pr of imported.projects) projectsMap.set(pr.id, pr);

  const allocationsMap = new Map<string, Allocation>();
  for (const a of currentState.allocations) {
    allocationsMap.set(`${a.personId}::${a.projectId}::${a.year}`, a);
  }
  for (const a of imported.allocations) {
    allocationsMap.set(`${a.personId}::${a.projectId}::${a.year}`, a);
  }

  const leavesMap = new Map<string, LeaveEntry>();
  for (const l of currentState.leaves) leavesMap.set(l.id, l);
  for (const l of imported.leaves) leavesMap.set(l.id, l);

  const nextState: AppState = {
    people: Array.from(peopleMap.values()),
    clients: Array.from(clientsMap.values()),
    projects: Array.from(projectsMap.values()),
    allocations: Array.from(allocationsMap.values()),
    leaves: Array.from(leavesMap.values()),
    availableYears,
    selectedYear: availableYears.includes(currentState.selectedYear)
      ? currentState.selectedYear
      : imported.selectedYear,
    departments,
    leaveTypes
  };

  return {
    nextState,
    summaryMessage: `Merged SQLite database (${imported.people.length} people, ${imported.clients.length} clients, ${imported.projects.length} projects, ${imported.allocations.length} allocations, ${imported.leaves.length} leaves processed).`
  };
}

export async function importSQLiteBinaryFile(
  bytes: Uint8Array,
  currentState: AppState,
  mergeMode: ImportMergeMode
): Promise<{ nextState: AppState; summaryMessage: string }> {
  if (!isSQLiteBinaryHeader(bytes)) {
    throw new Error('Selected file is not a valid SQLite 3 database binary (.sqlite / .db).');
  }

  const SQL = await getSqlJs();
  const tempDb = new SQL.Database(bytes);
  try {
    const imported = readAppStateFromDb(tempDb);
    if (!imported) {
      throw new Error(
        'The SQLite database does not contain AlloCat relational tables (people, clients, projects).'
      );
    }
    const merged = mergeImportedState(imported, currentState, mergeMode);
    await syncAppStateToSQLite(merged.nextState);
    return merged;
  } finally {
    tempDb.close();
  }
}

export async function importSQLDumpScript(
  sqlText: string,
  currentState: AppState,
  mergeMode: ImportMergeMode
): Promise<{ nextState: AppState; summaryMessage: string }> {
  const cleaned = sqlText.trim();
  if (!cleaned) {
    throw new Error('SQL script file is empty.');
  }

  const SQL = await getSqlJs();
  const tempDb = new SQL.Database();
  try {
    ensureSchema(tempDb);
    tempDb.run(cleaned);
    const imported = readAppStateFromDb(tempDb);
    if (!imported) {
      throw new Error('SQL script executed, but no AlloCat workspace tables were populated.');
    }
    const merged = mergeImportedState(imported, currentState, mergeMode);
    await syncAppStateToSQLite(merged.nextState);
    return merged;
  } finally {
    tempDb.close();
  }
}

export async function runReadOnlySQLQuery(
  sql: string
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('Enter a SELECT or PRAGMA query to execute.');
  }
  if (!/^(select|pragma|with|explain)\b/i.test(trimmed)) {
    throw new Error('Only read-only SELECT, WITH, or PRAGMA queries are allowed in the inspector.');
  }
  if (!activeDb) {
    throw new Error('SQLite database engine is not initialized yet.');
  }
  const results = activeDb.exec(trimmed);
  if (!results || results.length === 0) {
    return { columns: [], rows: [] };
  }
  return {
    columns: results[0].columns,
    rows: results[0].values
  };
}
