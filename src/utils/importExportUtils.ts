import {
  Person,
  Client,
  ClientStatus,
  Project,
  ProjectStatus,
  Allocation,
  AllocationStatus,
  LeaveEntry,
  LeaveType,
  LeaveTypeMeta,
  EmploymentType,
  ViewMode,
  MONTH_NAMES,
  MONTH_FULL_NAMES,
  DEFAULT_LEAVE_TYPE_CONFIG,
  LEAVE_BADGE_THEMES,
  getLeaveTypeMeta,
  syncLeaveTypeConfigRegistry,
  normalizeAllocationStatus,
  normalizeAllocationStatuses
} from '../types';
import { AppState } from '../data/seedData';
import {
  getPersonCapacitySummary,
  getPersonMonthlySummaryStatuses,
  getProjectStaffingSummary,
  getPersonBenchSummary
} from './allocationMath';

export type SQLiteTableName =
  | 'people'
  | 'clients'
  | 'projects'
  | 'allocations'
  | 'leaves'
  | 'departments'
  | 'leave_types'
  | 'planning_years';

export type SQLiteTableScope =
  | 'table_people'
  | 'table_clients'
  | 'table_projects'
  | 'table_allocations'
  | 'table_leaves'
  | 'table_departments'
  | 'table_leave_types'
  | 'table_planning_years';

export type ExportScope = ViewMode | 'admin' | 'all' | SQLiteTableScope;
export type ImportMergeMode = 'merge' | 'replace';

export interface SQLiteTableSchemaDescriptor {
  tableName: SQLiteTableName;
  scope: SQLiteTableScope;
  label: string;
  shortLabel: string;
  role: 'master' | 'fact' | 'config';
  primaryKey: string;
  foreignKeys: string[];
  columns: string[];
  description: string;
}

export const SQLITE_TABLE_SCHEMAS: SQLiteTableSchemaDescriptor[] = [
  {
    tableName: 'people',
    scope: 'table_people',
    label: 'people (Team Roster)',
    shortLabel: 'people',
    role: 'master',
    primaryKey: 'id',
    foreignKeys: ['department -> departments(name)'],
    columns: [
      'id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'email',
      'max_capacity_percent',
      'avatar_color',
      'initials',
      'is_active',
      'notes'
    ],
    description:
      'Normalized team roster table with primary key id, employment contract type, department FK, and base capacity %.'
  },
  {
    tableName: 'clients',
    scope: 'table_clients',
    label: 'clients (Accounts)',
    shortLabel: 'clients',
    role: 'master',
    primaryKey: 'id',
    foreignKeys: [],
    columns: ['id', 'name', 'industry', 'color', 'status'],
    description:
      'Client company directory table with primary key id, industry classification, brand color, and lifecycle status.'
  },
  {
    tableName: 'projects',
    scope: 'table_projects',
    label: 'projects (Deliverables)',
    shortLabel: 'projects',
    role: 'master',
    primaryKey: 'id',
    foreignKeys: ['client_id -> clients(id)'],
    columns: ['id', 'client_id', 'name', 'code', 'status', 'color', 'billable', 'notes'],
    description:
      'Deliverable projects linked by foreign key client_id to clients(id), with code, billable flag (1/0), and scope notes.'
  },
  {
    tableName: 'allocations',
    scope: 'table_allocations',
    label: 'allocations (Monthly Matrix)',
    shortLabel: 'allocations',
    role: 'fact',
    primaryKey: 'id',
    foreignKeys: ['person_id -> people(id)', 'project_id -> projects(id)'],
    columns: [
      'id',
      'person_id',
      'project_id',
      'year',
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
      'jan_status',
      'feb_status',
      'mar_status',
      'apr_status',
      'may_status',
      'jun_status',
      'jul_status',
      'aug_status',
      'sep_status',
      'oct_status',
      'nov_status',
      'dec_status',
      'notes'
    ],
    description:
      'Monthly resource assignment fact table uniquely keyed by (person_id, project_id, year) with integer percentages jan..dec and statuses jan_status..dec_status (unknown, planned, confirmed).'
  },
  {
    tableName: 'leaves',
    scope: 'table_leaves',
    label: 'leaves (Scheduled Time Off)',
    shortLabel: 'leaves',
    role: 'fact',
    primaryKey: 'id',
    foreignKeys: ['person_id -> people(id)'],
    columns: [
      'id',
      'person_id',
      'leave_type',
      'title',
      'year',
      'start_month',
      'end_month',
      'impact_percent',
      'notes'
    ],
    description:
      'Scheduled time-off periods linked to people(id) using 0-based month indices (0=Jan..11=Dec) and impact_percent.'
  },
  {
    tableName: 'departments',
    scope: 'table_departments',
    label: 'departments (Org Units)',
    shortLabel: 'departments',
    role: 'config',
    primaryKey: 'name',
    foreignKeys: [],
    columns: ['name', 'sort_order'],
    description: 'Reference directory of organizational departments referenced by people(department).'
  },
  {
    tableName: 'leave_types',
    scope: 'table_leave_types',
    label: 'leave_types (Categories)',
    shortLabel: 'leave_types',
    role: 'config',
    primaryKey: 'type_key',
    foreignKeys: [],
    columns: ['type_key', 'label', 'badge_class', 'icon_name', 'default_impact'],
    description: 'Configured leave & absence category definitions with badge styling, icons, and default impact %.'
  },
  {
    tableName: 'planning_years',
    scope: 'table_planning_years',
    label: 'planning_years (Fiscal Horizon)',
    shortLabel: 'planning_years',
    role: 'config',
    primaryKey: 'year',
    foreignKeys: [],
    columns: ['year', 'is_selected'],
    description: 'Active multi-year planning horizon table with 1/0 is_selected flag.'
  }
];

export function isTableScope(scope: ExportScope): scope is SQLiteTableScope {
  return scope.startsWith('table_');
}

export function tableScopeToTableName(scope: SQLiteTableScope): SQLiteTableName {
  return scope.replace(/^table_/, '') as SQLiteTableName;
}

export function getTableSchemaDescriptor(
  tableOrScope: SQLiteTableName | SQLiteTableScope
): SQLiteTableSchemaDescriptor {
  const tableName = tableOrScope.startsWith('table_')
    ? tableScopeToTableName(tableOrScope as SQLiteTableScope)
    : (tableOrScope as SQLiteTableName);
  return (
    SQLITE_TABLE_SCHEMAS.find((s) => s.tableName === tableName) || SQLITE_TABLE_SCHEMAS[0]
  );
}

const AVATAR_COLORS = [
  '#2563EB',
  '#7C3AED',
  '#059669',
  '#D97706',
  '#0284C7',
  '#DB2777',
  '#4F46E5',
  '#0891B2'
];

const DB_MONTH_COLUMNS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
] as const;

const DB_STATUS_COLUMNS = [
  'jan_status',
  'feb_status',
  'mar_status',
  'apr_status',
  'may_status',
  'jun_status',
  'jul_status',
  'aug_status',
  'sep_status',
  'oct_status',
  'nov_status',
  'dec_status'
] as const;

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (!parts[0]) return 'TM';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function splitPersonName(person: {
  firstName?: string;
  lastName?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  name?: string;
}): { firstName: string; lastName: string; fullName: string } {
  const rawFull = (person.full_name || person.name || '').trim();
  const parts = rawFull ? rawFull.split(/\s+/) : [];
  const firstName = (person.firstName ?? person.first_name ?? '').trim() || parts[0] || '';
  const rawLast = person.lastName ?? person.last_name;
  const lastName =
    rawLast !== undefined && rawLast.trim() !== ''
      ? rawLast.trim()
      : parts.length > 1
      ? parts.slice(1).join(' ')
      : '';
  const fullName = `${firstName} ${lastName}`.trim() || rawFull;
  return { firstName, lastName, fullName };
}

export function escapeCsvCell(val: string | number | boolean | undefined | null): string {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(rows: (string | number | boolean | undefined | null)[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

export function parseCsvToRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  const text = csvText.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.some((cell) => cell !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField.trim());
        if (currentRow.some((cell) => cell !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some((cell) => cell !== '')) {
    rows.push(currentRow);
  }

  return rows;
}

function parsePercentValue(raw: string | number | undefined | null, fallback = 0): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : fallback;
  }
  if (!raw) return fallback;
  const cleaned = String(raw).replace(/%/g, '').replace(/[^\d.-]/g, '').trim();
  if (!cleaned) return fallback;
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : fallback;
}

function parseBoolFlag(raw: string | number | boolean | undefined | null, fallback = true): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = String(raw).trim().toLowerCase();
  if (['0', 'no', 'false', 'n'].includes(n)) return false;
  if (['1', 'yes', 'true', 'y'].includes(n)) return true;
  return fallback;
}

function parseMonthToken(
  token: string | number | undefined | null,
  preferZeroIndexedNumeric: boolean = false
): number | null {
  if (token === undefined || token === null) return null;
  if (typeof token === 'number') {
    if (!Number.isFinite(token)) return null;
    if (token >= 0 && token <= 11) return Math.round(token);
    if (token >= 1 && token <= 12) return Math.round(token) - 1;
    return null;
  }
  const t = String(token).trim().toLowerCase();
  if (!t) return null;

  const shortIdx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === t.slice(0, 3));
  if (shortIdx >= 0) return shortIdx;

  const fullIdx = MONTH_FULL_NAMES.findIndex((m) => m.toLowerCase() === t);
  if (fullIdx >= 0) return fullIdx;

  if (/^m\d+$/i.test(t)) {
    const num = parseInt(t.slice(1), 10);
    if (num >= 1 && num <= 12) return num - 1;
  }

  const num = parseInt(t, 10);
  if (!isNaN(num)) {
    if (preferZeroIndexedNumeric) {
      if (num >= 0 && num <= 11) return num;
      if (num === 12) return 11;
    } else {
      if (num === 0) return 0;
      if (num >= 1 && num <= 12) return num - 1;
    }
  }
  return null;
}

function parseEmploymentType(
  raw: string | undefined | null,
  fallback: EmploymentType = 'Internal'
): EmploymentType {
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'external' || normalized === 'ext' || normalized === 'contractor') {
    return 'External';
  }
  if (normalized === 'b2b' || normalized === 'b2b contract') {
    return 'B2B';
  }
  if (normalized === 'internal' || normalized === 'int' || normalized === 'fte') {
    return 'Internal';
  }
  return fallback;
}

function parseClientStatus(
  raw: string | undefined | null,
  fallback: ClientStatus = 'active'
): ClientStatus {
  if (!raw) return fallback;
  const n = String(raw).trim().toLowerCase();
  if (n === 'lead' || n === 'prospect') return 'lead';
  if (n === 'completed' || n === 'inactive' || n === 'archived') return 'completed';
  if (n === 'active') return 'active';
  return fallback;
}

function parseProjectStatus(
  raw: string | undefined | null,
  fallback: ProjectStatus = 'active'
): ProjectStatus {
  if (!raw) return fallback;
  const n = String(raw).trim().toLowerCase();
  if (n === 'planned') return 'planned';
  if (n === 'completed' || n === 'archived') return 'completed';
  if (n === 'active') return 'active';
  return fallback;
}

function resolveBadgeClassFromTheme(
  rawBadgeOrTheme: string | undefined | null,
  fallback?: string
): string {
  if (!rawBadgeOrTheme) return fallback || LEAVE_BADGE_THEMES.blue.badgeClass;
  const trimmed = String(rawBadgeOrTheme).trim();
  if (trimmed.includes('bg-') && trimmed.includes('text-')) {
    return trimmed;
  }
  const key = trimmed.toLowerCase();
  if (LEAVE_BADGE_THEMES[key]) {
    return LEAVE_BADGE_THEMES[key].badgeClass;
  }
  for (const theme of Object.values(LEAVE_BADGE_THEMES)) {
    if (theme.name.toLowerCase() === key) {
      return theme.badgeClass;
    }
  }
  return fallback || LEAVE_BADGE_THEMES.blue.badgeClass;
}

export function triggerFileDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function triggerBinaryDownload(bytes: Uint8Array, filename: string, mimeType: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ============================================================================
// 1. NORMALIZED SQLITE TABLE CSV GENERATORS (1:1 WITH SQLITE SCHEMA)
// ============================================================================

export function generateTableCSV(state: AppState, tableName: SQLiteTableName): string {
  const schema = getTableSchemaDescriptor(tableName);
  const rows: (string | number | boolean | undefined | null)[][] = [schema.columns];

  switch (tableName) {
    case 'people': {
      for (const p of state.people) {
        const { firstName, lastName, fullName } = splitPersonName(p);
        rows.push([
          p.id,
          firstName,
          lastName,
          fullName,
          p.role || 'Specialist',
          p.department || 'Engineering',
          p.employmentType || 'Internal',
          p.email || '',
          p.maxCapacityPercent ?? 100,
          p.avatarColor || '#2563EB',
          p.initials || getInitials(fullName),
          p.notes || ''
        ]);
      }
      break;
    }

    case 'clients': {
      for (const c of state.clients) {
        rows.push([
          c.id,
          c.name,
          c.industry || '',
          c.color || '#2563EB',
          c.status || 'active'
        ]);
      }
      break;
    }

    case 'projects': {
      for (const pr of state.projects) {
        rows.push([
          pr.id,
          pr.clientId,
          pr.name,
          pr.code || 'PRJ',
          pr.status || 'active',
          pr.color || '#2563EB',
          pr.billable ? 1 : 0,
          pr.notes || ''
        ]);
      }
      break;
    }

    case 'allocations': {
      for (const a of state.allocations) {
        const m = Array.from({ length: 12 }, (_, idx) =>
          Math.max(0, Math.round(Number(a.monthlyPercentage?.[idx] ?? 0)))
        );
        const s = normalizeAllocationStatuses(a.monthlyStatus, 'unknown');
        rows.push([a.id, a.personId, a.projectId, a.year, ...m, ...s, a.notes || '']);
      }
      break;
    }

    case 'leaves': {
      for (const l of state.leaves) {
        const startM = Math.max(0, Math.min(11, Math.min(l.startMonth, l.endMonth)));
        const endM = Math.max(startM, Math.min(11, Math.max(l.startMonth, l.endMonth)));
        rows.push([
          l.id,
          l.personId,
          l.type || 'vacation',
          l.title || 'Time Off',
          l.year,
          startM,
          endM,
          l.impactPercent ?? 100,
          l.notes || ''
        ]);
      }
      break;
    }

    case 'departments': {
      const depts =
        state.departments && state.departments.length > 0
          ? state.departments
          : Array.from(new Set(state.people.map((p) => p.department).filter(Boolean)));
      depts.forEach((dept, idx) => {
        rows.push([dept, idx]);
      });
      break;
    }

    case 'leave_types': {
      const leaveTypesMap =
        state.leaveTypes && Object.keys(state.leaveTypes).length > 0
          ? state.leaveTypes
          : DEFAULT_LEAVE_TYPE_CONFIG;
      for (const [typeKey, meta] of Object.entries(leaveTypesMap)) {
        rows.push([
          typeKey,
          meta.label,
          meta.badgeClass,
          meta.iconName || 'CalendarOff',
          meta.defaultImpact ?? 50
        ]);
      }
      break;
    }

    case 'planning_years': {
      const years =
        state.availableYears && state.availableYears.length > 0
          ? Array.from(new Set(state.availableYears)).sort((a, b) => a - b)
          : [state.selectedYear];
      for (const yr of years) {
        rows.push([yr, yr === state.selectedYear ? 1 : 0]);
      }
      break;
    }
  }

  return rowsToCsv(rows);
}

// ============================================================================
// 2. RELATIONAL-ALIGNED VIEW & FULL WORKSPACE CSV GENERATORS
// ============================================================================

export function generatePeopleViewCSV(state: AppState, peopleSubset?: Person[]): string {
  const { clients, projects, allocations, leaves, selectedYear } = state;
  const targetPeople = peopleSubset ?? state.people;

  const headers = [
    'table_name',
    'id',
    'year',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'email',
    'max_capacity_percent',
    'client_id',
    'client_name',
    'project_id',
    'project_name',
    'code',
    'annual_avg_pct',
    ...DB_MONTH_COLUMNS,
    ...DB_STATUS_COLUMNS,
    'notes'
  ];

  const rows: (string | number)[][] = [headers];

  for (const person of targetPeople) {
    const { firstName, lastName, fullName } = splitPersonName(person);
    const summary = getPersonCapacitySummary(
      person.id,
      selectedYear,
      allocations,
      person.maxCapacityPercent,
      leaves
    );
    const summaryStatuses = getPersonMonthlySummaryStatuses(
      person.id,
      selectedYear,
      allocations
    );

    rows.push([
      'person_summary',
      person.id,
      selectedYear,
      person.id,
      firstName,
      lastName,
      fullName,
      person.role,
      person.department,
      person.employmentType || 'Internal',
      person.email,
      person.maxCapacityPercent ?? 100,
      '',
      '',
      '',
      '',
      '',
      summary.annualAverage,
      ...summary.totals,
      ...summaryStatuses,
      person.notes || ''
    ]);

    const personAllocs = allocations.filter(
      (a) => a.personId === person.id && a.year === selectedYear
    );

    for (const alloc of personAllocs) {
      const project = projects.find((p) => p.id === alloc.projectId);
      if (!project) continue;
      const client = clients.find((c) => c.id === project.clientId);
      const months = Array.from({ length: 12 }, (_, i) =>
        Math.max(0, Math.round(Number(alloc.monthlyPercentage?.[i] ?? 0)))
      );
      const statuses = normalizeAllocationStatuses(alloc.monthlyStatus, 'unknown');
      const avg = Math.round(months.reduce((s, n) => s + n, 0) / 12);

      rows.push([
        'allocations',
        alloc.id,
        alloc.year,
        person.id,
        firstName,
        lastName,
        fullName,
        person.role,
        person.department,
        person.employmentType || 'Internal',
        person.email,
        person.maxCapacityPercent ?? 100,
        client?.id || project.clientId,
        client?.name || 'Internal',
        project.id,
        project.name,
        project.code,
        avg,
        ...months,
        ...statuses,
        alloc.notes || ''
      ]);
    }
  }

  return rowsToCsv(rows);
}

export function generateClientsViewCSV(state: AppState, projectsSubset?: Project[]): string {
  const { people, clients, allocations, selectedYear } = state;
  const targetProjects = projectsSubset ?? state.projects;

  const headers = [
    'table_name',
    'id',
    'year',
    'client_id',
    'client_name',
    'industry',
    'project_id',
    'project_name',
    'code',
    'project_status',
    'billable',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'annual_avg_pct',
    ...DB_MONTH_COLUMNS,
    ...DB_STATUS_COLUMNS,
    'notes'
  ];

  const rows: (string | number)[][] = [headers];

  for (const client of clients) {
    const clientProjects = targetProjects.filter((p) => p.clientId === client.id);
    for (const project of clientProjects) {
      const summary = getProjectStaffingSummary(project.id, selectedYear, allocations);

      rows.push([
        'project_summary',
        project.id,
        selectedYear,
        client.id,
        client.name,
        client.industry,
        project.id,
        project.name,
        project.code,
        project.status,
        project.billable ? 1 : 0,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        Math.round(summary.avgMonthlyFTE * 100),
        ...summary.totals,
        ...DB_STATUS_COLUMNS.map(() => ''),
        project.notes || ''
      ]);

      const projectAllocs = allocations.filter(
        (a) => a.projectId === project.id && a.year === selectedYear
      );

      for (const alloc of projectAllocs) {
        const person = people.find((p) => p.id === alloc.personId);
        if (!person) continue;
        const { firstName, lastName, fullName } = splitPersonName(person);
        const months = Array.from({ length: 12 }, (_, i) =>
          Math.max(0, Math.round(Number(alloc.monthlyPercentage?.[i] ?? 0)))
        );
        const statuses = normalizeAllocationStatuses(alloc.monthlyStatus, 'unknown');
        const avg = Math.round(months.reduce((s, n) => s + n, 0) / 12);

        rows.push([
          'allocations',
          alloc.id,
          alloc.year,
          client.id,
          client.name,
          client.industry,
          project.id,
          project.name,
          project.code,
          project.status,
          project.billable ? 1 : 0,
          person.id,
          firstName,
          lastName,
          fullName,
          person.role,
          person.department,
          person.employmentType || 'Internal',
          avg,
          ...months,
          ...statuses,
          alloc.notes || ''
        ]);
      }
    }
  }

  return rowsToCsv(rows);
}

export function generateAvailabilityViewCSV(state: AppState, peopleSubset?: Person[]): string {
  const {
    allocations,
    leaves,
    selectedYear,
    leaveTypes = DEFAULT_LEAVE_TYPE_CONFIG
  } = state;
  const targetPeople = peopleSubset ?? state.people;

  const headers = [
    'table_name',
    'id',
    'year',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'max_capacity_percent',
    'leave_type',
    'label',
    'badge_class',
    'icon_name',
    'default_impact',
    'title',
    'start_month',
    'end_month',
    'impact_percent',
    ...DB_MONTH_COLUMNS,
    'notes'
  ];

  const rows: (string | number)[][] = [headers];

  for (const [typeKey, meta] of Object.entries(leaveTypes)) {
    rows.push([
      'leave_types',
      typeKey,
      selectedYear,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      typeKey,
      meta.label,
      meta.badgeClass,
      meta.iconName || 'CalendarOff',
      meta.defaultImpact ?? 50,
      meta.label,
      '',
      '',
      meta.defaultImpact ?? 50,
      ...DB_MONTH_COLUMNS.map(() => ''),
      ''
    ]);
  }

  for (const person of targetPeople) {
    const { firstName, lastName, fullName } = splitPersonName(person);
    const summary = getPersonCapacitySummary(
      person.id,
      selectedYear,
      allocations,
      person.maxCapacityPercent,
      leaves
    );
    const personLeaves = leaves.filter(
      (l) => l.personId === person.id && l.year === selectedYear
    );

    rows.push([
      'effective_capacity',
      person.id,
      selectedYear,
      person.id,
      firstName,
      lastName,
      fullName,
      person.role,
      person.department,
      person.employmentType || 'Internal',
      person.maxCapacityPercent ?? 100,
      '',
      '',
      '',
      '',
      '',
      `${personLeaves.length} scheduled leave(s)`,
      '',
      '',
      '',
      ...summary.effectiveCapacities,
      person.notes || ''
    ]);

    for (const leave of personLeaves) {
      const startM = Math.max(0, Math.min(11, Math.min(leave.startMonth, leave.endMonth)));
      const endM = Math.max(startM, Math.min(11, Math.max(leave.startMonth, leave.endMonth)));
      const meta = getLeaveTypeMeta(leave.type, leaveTypes);
      const monthCells = DB_MONTH_COLUMNS.map((_, idx) =>
        idx >= startM && idx <= endM ? leave.impactPercent : 0
      );

      rows.push([
        'leaves',
        leave.id,
        leave.year,
        person.id,
        firstName,
        lastName,
        fullName,
        person.role,
        person.department,
        person.employmentType || 'Internal',
        person.maxCapacityPercent ?? 100,
        leave.type,
        meta.label,
        meta.badgeClass,
        meta.iconName || 'CalendarOff',
        meta.defaultImpact ?? 50,
        leave.title,
        startM,
        endM,
        leave.impactPercent,
        ...monthCells,
        leave.notes || ''
      ]);
    }
  }

  return rowsToCsv(rows);
}

export function generateBenchViewCSV(state: AppState, peopleSubset?: Person[]): string {
  const { allocations, leaves, selectedYear } = state;
  const targetPeople = peopleSubset ?? state.people;

  const headers = [
    'table_name',
    'id',
    'year',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'email',
    'max_capacity_percent',
    'avg_bench_pct',
    'free_months_count',
    ...DB_MONTH_COLUMNS,
    'notes'
  ];

  const rows: (string | number)[][] = [headers];

  for (const person of targetPeople) {
    const { firstName, lastName, fullName } = splitPersonName(person);
    const bench = getPersonBenchSummary(person, selectedYear, allocations, leaves);

    rows.push([
      'bench_availability',
      person.id,
      selectedYear,
      person.id,
      firstName,
      lastName,
      fullName,
      person.role,
      person.department,
      person.employmentType || 'Internal',
      person.email,
      person.maxCapacityPercent ?? 100,
      bench.annualAverageBenchPct,
      bench.totalBenchMonthsCount,
      ...bench.monthlyBenchPct,
      person.notes || ''
    ]);
  }

  return rowsToCsv(rows);
}

export function generateAdminDirectoriesCSV(state: AppState): string {
  const {
    people,
    clients,
    projects,
    leaves,
    departments,
    availableYears,
    selectedYear,
    leaveTypes = DEFAULT_LEAVE_TYPE_CONFIG
  } = state;

  const headers = [
    'table_name',
    'id',
    'year',
    'is_selected',
    'sort_order',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'email',
    'max_capacity_percent',
    'avatar_color',
    'initials',
    'client_id',
    'client_name',
    'industry',
    'client_status',
    'project_id',
    'project_name',
    'code',
    'project_status',
    'billable',
    'color',
    'leave_type',
    'label',
    'badge_class',
    'icon_name',
    'default_impact',
    'title',
    'start_month',
    'end_month',
    'impact_percent',
    'notes'
  ];

  const emptyRow = () => Array<string | number>(headers.length).fill('');
  const colIdx = (name: string) => headers.indexOf(name);
  const rows: (string | number)[][] = [headers];

  const years =
    availableYears && availableYears.length > 0
      ? Array.from(new Set(availableYears)).sort((a, b) => a - b)
      : [selectedYear];
  for (const yr of years) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'planning_years';
    row[colIdx('year')] = yr;
    row[colIdx('is_selected')] = yr === selectedYear ? 1 : 0;
    rows.push(row);
  }

  departments.forEach((dept, idx) => {
    const row = emptyRow();
    row[colIdx('table_name')] = 'departments';
    row[colIdx('department')] = dept;
    row[colIdx('sort_order')] = idx;
    rows.push(row);
  });

  for (const [typeKey, meta] of Object.entries(leaveTypes)) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'leave_types';
    row[colIdx('id')] = typeKey;
    row[colIdx('leave_type')] = typeKey;
    row[colIdx('label')] = meta.label;
    row[colIdx('badge_class')] = meta.badgeClass;
    row[colIdx('icon_name')] = meta.iconName || 'CalendarOff';
    row[colIdx('default_impact')] = meta.defaultImpact ?? 50;
    rows.push(row);
  }

  for (const client of clients) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'clients';
    row[colIdx('id')] = client.id;
    row[colIdx('client_id')] = client.id;
    row[colIdx('client_name')] = client.name;
    row[colIdx('industry')] = client.industry;
    row[colIdx('client_status')] = client.status;
    row[colIdx('color')] = client.color;
    rows.push(row);
  }

  for (const project of projects) {
    const client = clients.find((c) => c.id === project.clientId);
    const row = emptyRow();
    row[colIdx('table_name')] = 'projects';
    row[colIdx('id')] = project.id;
    row[colIdx('client_id')] = project.clientId;
    row[colIdx('client_name')] = client?.name || 'Internal';
    row[colIdx('project_id')] = project.id;
    row[colIdx('project_name')] = project.name;
    row[colIdx('code')] = project.code;
    row[colIdx('project_status')] = project.status;
    row[colIdx('billable')] = project.billable ? 1 : 0;
    row[colIdx('color')] = project.color;
    row[colIdx('notes')] = project.notes || '';
    rows.push(row);
  }

  for (const person of people) {
    const { firstName, lastName, fullName } = splitPersonName(person);
    const row = emptyRow();
    row[colIdx('table_name')] = 'people';
    row[colIdx('id')] = person.id;
    row[colIdx('person_id')] = person.id;
    row[colIdx('first_name')] = firstName;
    row[colIdx('last_name')] = lastName;
    row[colIdx('full_name')] = fullName;
    row[colIdx('role')] = person.role;
    row[colIdx('department')] = person.department;
    row[colIdx('employment_type')] = person.employmentType || 'Internal';
    row[colIdx('email')] = person.email;
    row[colIdx('max_capacity_percent')] = person.maxCapacityPercent ?? 100;
    row[colIdx('avatar_color')] = person.avatarColor;
    row[colIdx('initials')] = person.initials;
    row[colIdx('notes')] = person.notes || '';
    rows.push(row);
  }

  for (const leave of leaves) {
    const person = people.find((p) => p.id === leave.personId);
    if (!person) continue;
    const { firstName, lastName, fullName } = splitPersonName(person);
    const startM = Math.max(0, Math.min(11, Math.min(leave.startMonth, leave.endMonth)));
    const endM = Math.max(startM, Math.min(11, Math.max(leave.startMonth, leave.endMonth)));
    const row = emptyRow();
    row[colIdx('table_name')] = 'leaves';
    row[colIdx('id')] = leave.id;
    row[colIdx('year')] = leave.year;
    row[colIdx('person_id')] = person.id;
    row[colIdx('first_name')] = firstName;
    row[colIdx('last_name')] = lastName;
    row[colIdx('full_name')] = fullName;
    row[colIdx('leave_type')] = leave.type;
    row[colIdx('title')] = leave.title;
    row[colIdx('start_month')] = startM;
    row[colIdx('end_month')] = endM;
    row[colIdx('impact_percent')] = leave.impactPercent;
    row[colIdx('notes')] = leave.notes || '';
    rows.push(row);
  }

  return rowsToCsv(rows);
}

export function generateAllViewsCSV(state: AppState): string {
  const {
    people,
    clients,
    projects,
    allocations,
    leaves,
    departments,
    availableYears,
    selectedYear,
    leaveTypes = DEFAULT_LEAVE_TYPE_CONFIG
  } = state;

  const headers = [
    'table_name',
    'id',
    'year',
    'is_selected',
    'sort_order',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'email',
    'max_capacity_percent',
    'avatar_color',
    'initials',
    'client_id',
    'client_name',
    'industry',
    'client_status',
    'project_id',
    'project_name',
    'code',
    'project_status',
    'billable',
    'color',
    'leave_type',
    'label',
    'badge_class',
    'icon_name',
    'default_impact',
    'title',
    'start_month',
    'end_month',
    'impact_percent',
    ...DB_MONTH_COLUMNS,
    ...DB_STATUS_COLUMNS,
    'notes'
  ];

  const emptyRow = () => Array<string | number>(headers.length).fill('');
  const colIdx = (name: string) => headers.indexOf(name);
  const rows: (string | number)[][] = [headers];

  // 1. planning_years
  const years =
    availableYears && availableYears.length > 0
      ? Array.from(new Set(availableYears)).sort((a, b) => a - b)
      : [selectedYear];
  for (const yr of years) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'planning_years';
    row[colIdx('year')] = yr;
    row[colIdx('is_selected')] = yr === selectedYear ? 1 : 0;
    rows.push(row);
  }

  // 2. departments
  departments.forEach((dept, idx) => {
    const row = emptyRow();
    row[colIdx('table_name')] = 'departments';
    row[colIdx('department')] = dept;
    row[colIdx('sort_order')] = idx;
    rows.push(row);
  });

  // 3. leave_types
  for (const [typeKey, meta] of Object.entries(leaveTypes)) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'leave_types';
    row[colIdx('id')] = typeKey;
    row[colIdx('leave_type')] = typeKey;
    row[colIdx('label')] = meta.label;
    row[colIdx('badge_class')] = meta.badgeClass;
    row[colIdx('icon_name')] = meta.iconName || 'CalendarOff';
    row[colIdx('default_impact')] = meta.defaultImpact ?? 50;
    rows.push(row);
  }

  // 4. clients
  for (const client of clients) {
    const row = emptyRow();
    row[colIdx('table_name')] = 'clients';
    row[colIdx('id')] = client.id;
    row[colIdx('client_id')] = client.id;
    row[colIdx('client_name')] = client.name;
    row[colIdx('industry')] = client.industry;
    row[colIdx('client_status')] = client.status;
    row[colIdx('color')] = client.color;
    rows.push(row);
  }

  // 5. projects
  for (const project of projects) {
    const client = clients.find((c) => c.id === project.clientId);
    const row = emptyRow();
    row[colIdx('table_name')] = 'projects';
    row[colIdx('id')] = project.id;
    row[colIdx('client_id')] = project.clientId;
    row[colIdx('client_name')] = client?.name || 'Internal';
    row[colIdx('project_id')] = project.id;
    row[colIdx('project_name')] = project.name;
    row[colIdx('code')] = project.code;
    row[colIdx('project_status')] = project.status;
    row[colIdx('billable')] = project.billable ? 1 : 0;
    row[colIdx('color')] = project.color;
    row[colIdx('notes')] = project.notes || '';
    rows.push(row);
  }

  // 6. people
  for (const person of people) {
    const { firstName, lastName, fullName } = splitPersonName(person);
    const row = emptyRow();
    row[colIdx('table_name')] = 'people';
    row[colIdx('id')] = person.id;
    row[colIdx('person_id')] = person.id;
    row[colIdx('first_name')] = firstName;
    row[colIdx('last_name')] = lastName;
    row[colIdx('full_name')] = fullName;
    row[colIdx('role')] = person.role;
    row[colIdx('department')] = person.department;
    row[colIdx('employment_type')] = person.employmentType || 'Internal';
    row[colIdx('email')] = person.email;
    row[colIdx('max_capacity_percent')] = person.maxCapacityPercent ?? 100;
    row[colIdx('avatar_color')] = person.avatarColor;
    row[colIdx('initials')] = person.initials;
    row[colIdx('notes')] = person.notes || '';
    rows.push(row);
  }

  // 7. allocations
  for (const alloc of allocations) {
    const person = people.find((p) => p.id === alloc.personId);
    const project = projects.find((p) => p.id === alloc.projectId);
    if (!person || !project) continue;
    const { firstName, lastName, fullName } = splitPersonName(person);
    const client = clients.find((c) => c.id === project.clientId);
    const row = emptyRow();
    row[colIdx('table_name')] = 'allocations';
    row[colIdx('id')] = alloc.id;
    row[colIdx('year')] = alloc.year;
    row[colIdx('person_id')] = person.id;
    row[colIdx('first_name')] = firstName;
    row[colIdx('last_name')] = lastName;
    row[colIdx('full_name')] = fullName;
    row[colIdx('client_id')] = client?.id || project.clientId;
    row[colIdx('client_name')] = client?.name || 'Internal';
    row[colIdx('project_id')] = project.id;
    row[colIdx('project_name')] = project.name;
    row[colIdx('code')] = project.code;
    const statuses = normalizeAllocationStatuses(alloc.monthlyStatus, 'unknown');
    DB_MONTH_COLUMNS.forEach((mCol, idx) => {
      row[colIdx(mCol)] = Math.max(0, Math.round(Number(alloc.monthlyPercentage?.[idx] ?? 0)));
    });
    DB_STATUS_COLUMNS.forEach((sCol, idx) => {
      row[colIdx(sCol)] = statuses[idx];
    });
    row[colIdx('notes')] = alloc.notes || '';
    rows.push(row);
  }

  // 8. leaves
  for (const leave of leaves) {
    const person = people.find((p) => p.id === leave.personId);
    if (!person) continue;
    const { firstName, lastName, fullName } = splitPersonName(person);
    const startM = Math.max(0, Math.min(11, Math.min(leave.startMonth, leave.endMonth)));
    const endM = Math.max(startM, Math.min(11, Math.max(leave.startMonth, leave.endMonth)));
    const row = emptyRow();
    row[colIdx('table_name')] = 'leaves';
    row[colIdx('id')] = leave.id;
    row[colIdx('year')] = leave.year;
    row[colIdx('person_id')] = person.id;
    row[colIdx('first_name')] = firstName;
    row[colIdx('last_name')] = lastName;
    row[colIdx('full_name')] = fullName;
    row[colIdx('leave_type')] = leave.type;
    row[colIdx('title')] = leave.title;
    row[colIdx('start_month')] = startM;
    row[colIdx('end_month')] = endM;
    row[colIdx('impact_percent')] = leave.impactPercent;
    row[colIdx('notes')] = leave.notes || '';
    rows.push(row);
  }

  return rowsToCsv(rows);
}

export function generateViewCSV(state: AppState, scope: ExportScope): string {
  if (isTableScope(scope)) {
    return generateTableCSV(state, tableScopeToTableName(scope));
  }
  switch (scope) {
    case 'people':
      return generatePeopleViewCSV(state);
    case 'clients':
      return generateClientsViewCSV(state);
    case 'availability':
      return generateAvailabilityViewCSV(state);
    case 'bench':
      return generateBenchViewCSV(state);
    case 'admin':
      return generateAdminDirectoriesCSV(state);
    case 'all':
    default:
      return generateAllViewsCSV(state);
  }
}

// ============================================================================
// 3. RELATIONAL JSON GENERATORS (SCHEMA V2 - SQLITE ALIGNED)
// ============================================================================

function toSQLitePersonRecord(p: Person) {
  const { firstName, lastName, fullName } = splitPersonName(p);
  return {
    id: p.id,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    role: p.role,
    department: p.department,
    employment_type: p.employmentType || 'Internal',
    email: p.email,
    max_capacity_percent: p.maxCapacityPercent ?? 100,
    avatar_color: p.avatarColor,
    initials: p.initials,
    is_active: p.isActive !== false ? 1 : 0,
    notes: p.notes || ''
  };
}

function toSQLiteClientRecord(c: Client) {
  return {
    id: c.id,
    name: c.name,
    industry: c.industry,
    color: c.color,
    status: c.status
  };
}

function toSQLiteProjectRecord(pr: Project) {
  return {
    id: pr.id,
    client_id: pr.clientId,
    name: pr.name,
    code: pr.code,
    status: pr.status,
    color: pr.color,
    billable: pr.billable ? 1 : 0,
    notes: pr.notes || ''
  };
}

function toSQLiteAllocationRecord(a: Allocation) {
  const m = Array.from({ length: 12 }, (_, idx) =>
    Math.max(0, Math.round(Number(a.monthlyPercentage?.[idx] ?? 0)))
  );
  const s = normalizeAllocationStatuses(a.monthlyStatus, 'unknown');
  return {
    id: a.id,
    person_id: a.personId,
    project_id: a.projectId,
    year: a.year,
    jan: m[0],
    feb: m[1],
    mar: m[2],
    apr: m[3],
    may: m[4],
    jun: m[5],
    jul: m[6],
    aug: m[7],
    sep: m[8],
    oct: m[9],
    nov: m[10],
    dec: m[11],
    jan_status: s[0],
    feb_status: s[1],
    mar_status: s[2],
    apr_status: s[3],
    may_status: s[4],
    jun_status: s[5],
    jul_status: s[6],
    aug_status: s[7],
    sep_status: s[8],
    oct_status: s[9],
    nov_status: s[10],
    dec_status: s[11],
    notes: a.notes || ''
  };
}

function toSQLiteLeaveRecord(l: LeaveEntry) {
  const startM = Math.max(0, Math.min(11, Math.min(l.startMonth, l.endMonth)));
  const endM = Math.max(startM, Math.min(11, Math.max(l.startMonth, l.endMonth)));
  return {
    id: l.id,
    person_id: l.personId,
    leave_type: l.type,
    title: l.title,
    year: l.year,
    start_month: startM,
    end_month: endM,
    impact_percent: l.impactPercent,
    notes: l.notes || ''
  };
}

export function generateViewJSON(state: AppState, scope: ExportScope): string {
  const {
    people,
    clients,
    projects,
    allocations,
    leaves,
    availableYears,
    selectedYear,
    departments,
    leaveTypes = DEFAULT_LEAVE_TYPE_CONFIG
  } = state;

  const baseEnvelope = {
    schemaVersion: 2,
    storageEngine: 'sqlite-relational',
    exportedAt: new Date().toISOString(),
    exportScope: scope
  };

  if (isTableScope(scope)) {
    const tableName = tableScopeToTableName(scope);
    switch (tableName) {
      case 'people':
        return JSON.stringify(
          { ...baseEnvelope, tableName, people: people.map(toSQLitePersonRecord) },
          null,
          2
        );
      case 'clients':
        return JSON.stringify(
          { ...baseEnvelope, tableName, clients: clients.map(toSQLiteClientRecord) },
          null,
          2
        );
      case 'projects':
        return JSON.stringify(
          { ...baseEnvelope, tableName, projects: projects.map(toSQLiteProjectRecord) },
          null,
          2
        );
      case 'allocations':
        return JSON.stringify(
          {
            ...baseEnvelope,
            tableName,
            allocations: allocations.map(toSQLiteAllocationRecord)
          },
          null,
          2
        );
      case 'leaves':
        return JSON.stringify(
          { ...baseEnvelope, tableName, leaves: leaves.map(toSQLiteLeaveRecord) },
          null,
          2
        );
      case 'departments':
        return JSON.stringify(
          {
            ...baseEnvelope,
            tableName,
            departments: departments.map((name, sort_order) => ({ name, sort_order }))
          },
          null,
          2
        );
      case 'leave_types':
        return JSON.stringify(
          {
            ...baseEnvelope,
            tableName,
            leave_types: Object.entries(leaveTypes).map(([type_key, meta]) => ({
              type_key,
              label: meta.label,
              badge_class: meta.badgeClass,
              icon_name: meta.iconName || 'CalendarOff',
              default_impact: meta.defaultImpact ?? 50
            }))
          },
          null,
          2
        );
      case 'planning_years':
        return JSON.stringify(
          {
            ...baseEnvelope,
            tableName,
            planning_years: availableYears.map((year) => ({
              year,
              is_selected: year === selectedYear ? 1 : 0
            }))
          },
          null,
          2
        );
    }
  }

  if (scope === 'all') {
    return JSON.stringify(
      {
        ...baseEnvelope,
        selectedYear,
        availableYears,
        planning_years: availableYears.map((year) => ({
          year,
          is_selected: year === selectedYear ? 1 : 0
        })),
        departments: departments.map((name, sort_order) => ({ name, sort_order })),
        leave_types: Object.entries(leaveTypes).map(([type_key, meta]) => ({
          type_key,
          label: meta.label,
          badge_class: meta.badgeClass,
          icon_name: meta.iconName || 'CalendarOff',
          default_impact: meta.defaultImpact ?? 50
        })),
        clients: clients.map(toSQLiteClientRecord),
        projects: projects.map(toSQLiteProjectRecord),
        people: people.map(toSQLitePersonRecord),
        allocations: allocations.map(toSQLiteAllocationRecord),
        leaves: leaves.map(toSQLiteLeaveRecord)
      },
      null,
      2
    );
  }

  if (scope === 'admin') {
    return JSON.stringify(
      {
        ...baseEnvelope,
        selectedYear,
        planning_years: availableYears.map((year) => ({
          year,
          is_selected: year === selectedYear ? 1 : 0
        })),
        departments: departments.map((name, sort_order) => ({ name, sort_order })),
        leave_types: Object.entries(leaveTypes).map(([type_key, meta]) => ({
          type_key,
          label: meta.label,
          badge_class: meta.badgeClass,
          icon_name: meta.iconName || 'CalendarOff',
          default_impact: meta.defaultImpact ?? 50
        })),
        clients: clients.map(toSQLiteClientRecord),
        projects: projects.map(toSQLiteProjectRecord),
        people: people.map(toSQLitePersonRecord),
        leaves: leaves.map(toSQLiteLeaveRecord)
      },
      null,
      2
    );
  }

  if (scope === 'people') {
    const person_summaries = people.map((person) => {
      const { firstName, lastName, fullName } = splitPersonName(person);
      const summary = getPersonCapacitySummary(
        person.id,
        selectedYear,
        allocations,
        person.maxCapacityPercent,
        leaves
      );
      const summaryStatuses = getPersonMonthlySummaryStatuses(
        person.id,
        selectedYear,
        allocations
      );
      return {
        person_id: person.id,
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
        year: selectedYear,
        annual_avg_pct: summary.annualAverage,
        jan: summary.totals[0],
        feb: summary.totals[1],
        mar: summary.totals[2],
        apr: summary.totals[3],
        may: summary.totals[4],
        jun: summary.totals[5],
        jul: summary.totals[6],
        aug: summary.totals[7],
        sep: summary.totals[8],
        oct: summary.totals[9],
        nov: summary.totals[10],
        dec: summary.totals[11],
        jan_status: summaryStatuses[0],
        feb_status: summaryStatuses[1],
        mar_status: summaryStatuses[2],
        apr_status: summaryStatuses[3],
        may_status: summaryStatuses[4],
        jun_status: summaryStatuses[5],
        jul_status: summaryStatuses[6],
        aug_status: summaryStatuses[7],
        sep_status: summaryStatuses[8],
        oct_status: summaryStatuses[9],
        nov_status: summaryStatuses[10],
        dec_status: summaryStatuses[11]
      };
    });

    return JSON.stringify(
      {
        ...baseEnvelope,
        selectedYear,
        departments: departments.map((name, sort_order) => ({ name, sort_order })),
        people: people.map(toSQLitePersonRecord),
        clients: clients.map(toSQLiteClientRecord),
        projects: projects.map(toSQLiteProjectRecord),
        allocations: allocations
          .filter((a) => a.year === selectedYear)
          .map(toSQLiteAllocationRecord),
        person_summaries
      },
      null,
      2
    );
  }

  if (scope === 'clients') {
    return JSON.stringify(
      {
        ...baseEnvelope,
        selectedYear,
        clients: clients.map(toSQLiteClientRecord),
        projects: projects.map(toSQLiteProjectRecord),
        people: people.map(toSQLitePersonRecord),
        allocations: allocations
          .filter((a) => a.year === selectedYear)
          .map(toSQLiteAllocationRecord)
      },
      null,
      2
    );
  }

  if (scope === 'availability') {
    return JSON.stringify(
      {
        ...baseEnvelope,
        selectedYear,
        leave_types: Object.entries(leaveTypes).map(([type_key, meta]) => ({
          type_key,
          label: meta.label,
          badge_class: meta.badgeClass,
          icon_name: meta.iconName || 'CalendarOff',
          default_impact: meta.defaultImpact ?? 50
        })),
        people: people.map(toSQLitePersonRecord),
        leaves: leaves.filter((l) => l.year === selectedYear).map(toSQLiteLeaveRecord)
      },
      null,
      2
    );
  }

  const benchSummaries = people.map((person) => {
    const b = getPersonBenchSummary(person, selectedYear, allocations, leaves);
    const { firstName, lastName, fullName } = splitPersonName(person);
    return {
      person_id: person.id,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      role: person.role,
      department: person.department,
      employment_type: person.employmentType || 'Internal',
      email: person.email,
      max_capacity_percent: person.maxCapacityPercent,
      notes: person.notes || '',
      annual_average_bench_pct: b.annualAverageBenchPct,
      total_bench_months_count: b.totalBenchMonthsCount,
      monthly_bench_pct: b.monthlyBenchPct
    };
  });

  return JSON.stringify(
    {
      ...baseEnvelope,
      selectedYear,
      people: people.map(toSQLitePersonRecord),
      benchSummaries
    },
    null,
    2
  );
}

// ============================================================================
// 4. PRE-BUILT SQLITE-ALIGNED CSV & JSON TEMPLATES
// ============================================================================

export function generateTemplateCSV(
  scope: ExportScope,
  selectedYear: number,
  includeExampleRows: boolean = true
): string {
  if (isTableScope(scope)) {
    const tableName = tableScopeToTableName(scope);
    const schema = getTableSchemaDescriptor(tableName);
    const headers = schema.columns;

    if (!includeExampleRows) {
      return rowsToCsv([headers, Array(headers.length).fill('')]);
    }

    switch (tableName) {
      case 'people':
        return rowsToCsv([
          headers,
          [
            'p-101',
            'Jane',
            'Doe',
            'Jane Doe',
            'Senior Frontend Engineer',
            'Engineering',
            'Internal',
            'jane.doe@company.internal',
            100,
            '#2563EB',
            'JD',
            1,
            'React & TypeScript Lead'
          ],
          [
            'p-102',
            'Alex',
            'Rivera',
            'Alex Rivera',
            'Product Designer',
            'Design',
            'B2B',
            'alex.rivera@company.internal',
            100,
            '#7C3AED',
            'AR',
            1,
            'Design Systems & Prototyping'
          ]
        ]);

      case 'clients':
        return rowsToCsv([
          headers,
          ['c-101', 'Acme FinTech', 'Financial Services', '#2563EB', 'active'],
          ['c-102', 'Globex Retail', 'E-Commerce', '#059669', 'lead']
        ]);

      case 'projects':
        return rowsToCsv([
          headers,
          [
            'proj-101',
            'c-101',
            'NextGen Payments Portal',
            'NGP-01',
            'active',
            '#2563EB',
            1,
            'Core Portal Delivery'
          ],
          [
            'proj-102',
            'c-102',
            'Omnichannel Checkout',
            'OMC-01',
            'planned',
            '#059669',
            1,
            'Q3 Commerce Architecture'
          ]
        ]);

      case 'allocations':
        return rowsToCsv([
          headers,
          [
            'a-101',
            'p-101',
            'proj-101',
            selectedYear,
            50,
            50,
            50,
            75,
            75,
            75,
            50,
            50,
            50,
            50,
            50,
            50,
            'confirmed',
            'confirmed',
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'planned',
            'planned',
            'unknown',
            'unknown',
            'unknown',
            'unknown',
            'Frontend Architecture Lead'
          ],
          [
            'a-102',
            'p-102',
            'proj-102',
            selectedYear,
            0,
            0,
            100,
            100,
            100,
            100,
            100,
            100,
            50,
            50,
            0,
            0,
            'unknown',
            'unknown',
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'planned',
            'planned',
            'unknown',
            'unknown',
            'unknown',
            'unknown',
            'UX Design Lead'
          ]
        ]);

      case 'leaves':
        return rowsToCsv([
          headers,
          [
            'leave-101',
            'p-101',
            'vacation',
            'Summer Family Vacation',
            selectedYear,
            6,
            7,
            50,
            '0-based months: 6=Jul, 7=Aug'
          ],
          [
            'leave-102',
            'p-102',
            'training',
            'Design Leadership Summit',
            selectedYear,
            9,
            9,
            25,
            '0-based month: 9=Oct'
          ]
        ]);

      case 'departments':
        return rowsToCsv([
          headers,
          ['Engineering', 0],
          ['Design', 1],
          ['Platform Security', 2]
        ]);

      case 'leave_types':
        return rowsToCsv([
          headers,
          [
            'training',
            'Training & Conference',
            LEAVE_BADGE_THEMES.emerald.badgeClass,
            'BookOpen',
            50
          ],
          [
            'parental_ext',
            'Extended Parental Leave',
            LEAVE_BADGE_THEMES.purple.badgeClass,
            'Baby',
            100
          ]
        ]);

      case 'planning_years':
        return rowsToCsv([
          headers,
          [selectedYear, 1],
          [selectedYear + 1, 0]
        ]);
    }
  }

  if (scope === 'people') {
    const headers = [
      'table_name',
      'id',
      'year',
      'person_id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'email',
      'max_capacity_percent',
      'client_id',
      'client_name',
      'project_id',
      'project_name',
      'code',
      'annual_avg_pct',
      ...DB_MONTH_COLUMNS,
      ...DB_STATUS_COLUMNS,
      'notes'
    ];
    const exampleRows: (string | number)[][] = includeExampleRows
      ? [
          [
            'person_summary',
            'p-101',
            selectedYear,
            'p-101',
            'Jane',
            'Doe',
            'Jane Doe',
            'Senior Frontend Engineer',
            'Engineering',
            'Internal',
            'jane.doe@company.internal',
            100,
            '',
            '',
            '',
            '',
            '',
            63,
            75,
            75,
            50,
            50,
            75,
            75,
            75,
            75,
            75,
            75,
            25,
            25,
            'confirmed',
            'confirmed',
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'mixed',
            'mixed',
            'unknown',
            'unknown',
            'unknown',
            'unknown',
            'React & TypeScript Lead'
          ],
          [
            'allocations',
            'a-101',
            selectedYear,
            'p-101',
            'Jane',
            'Doe',
            'Jane Doe',
            'Senior Frontend Engineer',
            'Engineering',
            'Internal',
            'jane.doe@company.internal',
            100,
            'c-101',
            'Acme FinTech',
            'proj-101',
            'NextGen Payments Portal',
            'NGP-01',
            42,
            50,
            50,
            50,
            50,
            50,
            50,
            50,
            50,
            50,
            50,
            0,
            0,
            'confirmed',
            'confirmed',
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'planned',
            'planned',
            'unknown',
            'unknown',
            'unknown',
            'unknown',
            'Frontend Architecture Lead'
          ],
          [
            'allocations',
            'a-102',
            selectedYear,
            'p-101',
            'Jane',
            'Doe',
            'Jane Doe',
            'Senior Frontend Engineer',
            'Engineering',
            'Internal',
            'jane.doe@company.internal',
            100,
            'c-102',
            'Internal',
            'proj-102',
            'Design System v3',
            'DS-03',
            21,
            25,
            25,
            0,
            0,
            25,
            25,
            25,
            25,
            25,
            25,
            25,
            25,
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'planned',
            'planned',
            'confirmed',
            'confirmed',
            'unknown',
            'unknown',
            'unknown',
            'unknown',
            'Component Library'
          ]
        ]
      : [Array(headers.length).fill('')];

    return rowsToCsv([headers, ...exampleRows]);
  }

  if (scope === 'clients') {
    const headers = [
      'table_name',
      'id',
      'year',
      'client_id',
      'client_name',
      'industry',
      'project_id',
      'project_name',
      'code',
      'project_status',
      'billable',
      'person_id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'annual_avg_pct',
      ...DB_MONTH_COLUMNS,
      ...DB_STATUS_COLUMNS,
      'notes'
    ];
    const exampleRows: (string | number)[][] = includeExampleRows
      ? [
          [
            'project_summary',
            'proj-102',
            selectedYear,
            'c-102',
            'Globex Retail',
            'E-Commerce',
            'proj-102',
            'Omnichannel Checkout',
            'OMC-01',
            'active',
            1,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            75,
            0,
            0,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            0,
            ...DB_STATUS_COLUMNS.map(() => ''),
            'Q2-Q4 Rollout'
          ],
          [
            'allocations',
            'a-102',
            selectedYear,
            'c-102',
            'Globex Retail',
            'E-Commerce',
            'proj-102',
            'Omnichannel Checkout',
            'OMC-01',
            'active',
            1,
            'p-102',
            'Alex',
            'Rivera',
            'Alex Rivera',
            'Product Designer',
            'Design',
            'B2B',
            75,
            0,
            0,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            100,
            0,
            'unknown',
            'unknown',
            'confirmed',
            'confirmed',
            'confirmed',
            'confirmed',
            'planned',
            'planned',
            'planned',
            'planned',
            'planned',
            'unknown',
            'UX Lead'
          ]
        ]
      : [Array(headers.length).fill('')];

    return rowsToCsv([headers, ...exampleRows]);
  }

  if (scope === 'availability') {
    const headers = [
      'table_name',
      'id',
      'year',
      'person_id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'max_capacity_percent',
      'leave_type',
      'label',
      'badge_class',
      'icon_name',
      'default_impact',
      'title',
      'start_month',
      'end_month',
      'impact_percent',
      ...DB_MONTH_COLUMNS,
      'notes'
    ];
    const exampleRows: (string | number)[][] = includeExampleRows
      ? [
          [
            'leave_types',
            'training',
            selectedYear,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            'training',
            'Training & Conference',
            LEAVE_BADGE_THEMES.emerald.badgeClass,
            'BookOpen',
            50,
            'Training & Conference',
            '',
            '',
            50,
            ...DB_MONTH_COLUMNS.map(() => ''),
            'Custom time off category'
          ],
          [
            'leaves',
            'leave-101',
            selectedYear,
            'p-101',
            'Jane',
            'Doe',
            'Jane Doe',
            'Senior Frontend Engineer',
            'Engineering',
            'Internal',
            100,
            'vacation',
            'Annual Vacation / PTO',
            LEAVE_BADGE_THEMES.blue.badgeClass,
            'Palmtree',
            50,
            'Summer Family Vacation',
            6,
            7,
            50,
            0,
            0,
            0,
            0,
            0,
            0,
            50,
            50,
            0,
            0,
            0,
            0,
            '0-based months: 6=Jul, 7=Aug'
          ],
          [
            'leaves',
            'leave-102',
            selectedYear,
            'p-103',
            'Sam',
            'Taylor',
            'Sam Taylor',
            'Backend Architect',
            'Engineering',
            'B2B',
            100,
            'training',
            'Training & Conference',
            LEAVE_BADGE_THEMES.emerald.badgeClass,
            'BookOpen',
            50,
            'Cloud Architecture Summit',
            9,
            9,
            50,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            50,
            0,
            0,
            '0-based month: 9=Oct'
          ]
        ]
      : [Array(headers.length).fill('')];

    return rowsToCsv([headers, ...exampleRows]);
  }

  if (scope === 'bench') {
    const headers = [
      'table_name',
      'id',
      'year',
      'person_id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'email',
      'max_capacity_percent',
      'avg_bench_pct',
      'free_months_count',
      ...DB_MONTH_COLUMNS,
      'notes'
    ];
    const exampleRows: (string | number)[][] = includeExampleRows
      ? [
          [
            'bench_availability',
            'p-104',
            selectedYear,
            'p-104',
            'Chris',
            'Morgan',
            'Chris Morgan',
            'DevOps Engineer',
            'Cloud & Infra',
            'External',
            'chris.morgan@company.internal',
            100,
            50,
            6,
            0,
            0,
            0,
            0,
            0,
            0,
            100,
            100,
            100,
            100,
            100,
            100,
            'Kubernetes, Terraform, AWS Certified — ready for Q3 assignment'
          ]
        ]
      : [Array(headers.length).fill('')];

    return rowsToCsv([headers, ...exampleRows]);
  }

  if (scope === 'admin') {
    const headers = [
      'table_name',
      'id',
      'year',
      'is_selected',
      'sort_order',
      'person_id',
      'first_name',
      'last_name',
      'full_name',
      'role',
      'department',
      'employment_type',
      'email',
      'max_capacity_percent',
      'avatar_color',
      'initials',
      'client_id',
      'client_name',
      'industry',
      'client_status',
      'project_id',
      'project_name',
      'code',
      'project_status',
      'billable',
      'color',
      'leave_type',
      'label',
      'badge_class',
      'icon_name',
      'default_impact',
      'title',
      'start_month',
      'end_month',
      'impact_percent',
      'notes'
    ];
    const emptyRow = () => Array<string | number>(headers.length).fill('');
    const colIdx = (name: string) => headers.indexOf(name);

    if (!includeExampleRows) {
      return rowsToCsv([headers, emptyRow()]);
    }

    const rYear = emptyRow();
    rYear[colIdx('table_name')] = 'planning_years';
    rYear[colIdx('year')] = selectedYear;
    rYear[colIdx('is_selected')] = 1;

    const rDept = emptyRow();
    rDept[colIdx('table_name')] = 'departments';
    rDept[colIdx('department')] = 'Platform Security';
    rDept[colIdx('sort_order')] = 0;

    const rLeaveType = emptyRow();
    rLeaveType[colIdx('table_name')] = 'leave_types';
    rLeaveType[colIdx('id')] = 'training';
    rLeaveType[colIdx('leave_type')] = 'training';
    rLeaveType[colIdx('label')] = 'Training & Conference';
    rLeaveType[colIdx('badge_class')] = LEAVE_BADGE_THEMES.emerald.badgeClass;
    rLeaveType[colIdx('icon_name')] = 'BookOpen';
    rLeaveType[colIdx('default_impact')] = 50;

    const rClient = emptyRow();
    rClient[colIdx('table_name')] = 'clients';
    rClient[colIdx('id')] = 'c-105';
    rClient[colIdx('client_id')] = 'c-105';
    rClient[colIdx('client_name')] = 'Nova Cyber Systems';
    rClient[colIdx('industry')] = 'Cybersecurity';
    rClient[colIdx('client_status')] = 'active';
    rClient[colIdx('color')] = '#4F46E5';

    const rProject = emptyRow();
    rProject[colIdx('table_name')] = 'projects';
    rProject[colIdx('id')] = 'proj-105';
    rProject[colIdx('client_id')] = 'c-105';
    rProject[colIdx('client_name')] = 'Nova Cyber Systems';
    rProject[colIdx('project_id')] = 'proj-105';
    rProject[colIdx('project_name')] = 'Zero-Trust IAM Audit';
    rProject[colIdx('code')] = 'NV-IAM';
    rProject[colIdx('project_status')] = 'active';
    rProject[colIdx('billable')] = 1;
    rProject[colIdx('color')] = '#4F46E5';
    rProject[colIdx('notes')] = 'Q3 Enterprise Security Rollout';

    const rPerson = emptyRow();
    rPerson[colIdx('table_name')] = 'people';
    rPerson[colIdx('id')] = 'p-105';
    rPerson[colIdx('person_id')] = 'p-105';
    rPerson[colIdx('first_name')] = 'Elena';
    rPerson[colIdx('last_name')] = 'Rostova';
    rPerson[colIdx('full_name')] = 'Elena Rostova';
    rPerson[colIdx('role')] = 'Staff Product Designer';
    rPerson[colIdx('department')] = 'Design';
    rPerson[colIdx('employment_type')] = 'Internal';
    rPerson[colIdx('email')] = 'elena.r@company.internal';
    rPerson[colIdx('max_capacity_percent')] = 100;
    rPerson[colIdx('avatar_color')] = '#7C3AED';
    rPerson[colIdx('initials')] = 'ER';
    rPerson[colIdx('notes')] = 'Design Systems Lead';

    return rowsToCsv([headers, rYear, rDept, rLeaveType, rClient, rProject, rPerson]);
  }

  // scope === 'all' (Full SQLite Multi-Table Master Template)
  const headers = [
    'table_name',
    'id',
    'year',
    'is_selected',
    'sort_order',
    'person_id',
    'first_name',
    'last_name',
    'full_name',
    'role',
    'department',
    'employment_type',
    'email',
    'max_capacity_percent',
    'avatar_color',
    'initials',
    'client_id',
    'client_name',
    'industry',
    'client_status',
    'project_id',
    'project_name',
    'code',
    'project_status',
    'billable',
    'color',
    'leave_type',
    'label',
    'badge_class',
    'icon_name',
    'default_impact',
    'title',
    'start_month',
    'end_month',
    'impact_percent',
    ...DB_MONTH_COLUMNS,
    ...DB_STATUS_COLUMNS,
    'notes'
  ];
  const emptyRow = () => Array<string | number>(headers.length).fill('');
  const colIdx = (name: string) => headers.indexOf(name);

  if (!includeExampleRows) {
    return rowsToCsv([headers, emptyRow()]);
  }

  const rYear = emptyRow();
  rYear[colIdx('table_name')] = 'planning_years';
  rYear[colIdx('year')] = selectedYear;
  rYear[colIdx('is_selected')] = 1;

  const rDept = emptyRow();
  rDept[colIdx('table_name')] = 'departments';
  rDept[colIdx('department')] = 'Engineering';
  rDept[colIdx('sort_order')] = 0;

  const rLeaveType = emptyRow();
  rLeaveType[colIdx('table_name')] = 'leave_types';
  rLeaveType[colIdx('id')] = 'training';
  rLeaveType[colIdx('leave_type')] = 'training';
  rLeaveType[colIdx('label')] = 'Training & Conference';
  rLeaveType[colIdx('badge_class')] = LEAVE_BADGE_THEMES.emerald.badgeClass;
  rLeaveType[colIdx('icon_name')] = 'BookOpen';
  rLeaveType[colIdx('default_impact')] = 50;

  const rClient = emptyRow();
  rClient[colIdx('table_name')] = 'clients';
  rClient[colIdx('id')] = 'c-101';
  rClient[colIdx('client_id')] = 'c-101';
  rClient[colIdx('client_name')] = 'Acme FinTech';
  rClient[colIdx('industry')] = 'Financial Services';
  rClient[colIdx('client_status')] = 'active';
  rClient[colIdx('color')] = '#2563EB';

  const rProject = emptyRow();
  rProject[colIdx('table_name')] = 'projects';
  rProject[colIdx('id')] = 'proj-101';
  rProject[colIdx('client_id')] = 'c-101';
  rProject[colIdx('client_name')] = 'Acme FinTech';
  rProject[colIdx('project_id')] = 'proj-101';
  rProject[colIdx('project_name')] = 'NextGen Payments Portal';
  rProject[colIdx('code')] = 'NGP-01';
  rProject[colIdx('project_status')] = 'active';
  rProject[colIdx('billable')] = 1;
  rProject[colIdx('color')] = '#2563EB';
  rProject[colIdx('notes')] = 'Core Portal Delivery';

  const rPerson = emptyRow();
  rPerson[colIdx('table_name')] = 'people';
  rPerson[colIdx('id')] = 'p-101';
  rPerson[colIdx('person_id')] = 'p-101';
  rPerson[colIdx('first_name')] = 'Jane';
  rPerson[colIdx('last_name')] = 'Doe';
  rPerson[colIdx('full_name')] = 'Jane Doe';
  rPerson[colIdx('role')] = 'Senior Frontend Engineer';
  rPerson[colIdx('department')] = 'Engineering';
  rPerson[colIdx('employment_type')] = 'Internal';
  rPerson[colIdx('email')] = 'jane.doe@company.internal';
  rPerson[colIdx('max_capacity_percent')] = 100;
  rPerson[colIdx('avatar_color')] = '#2563EB';
  rPerson[colIdx('initials')] = 'JD';
  rPerson[colIdx('notes')] = 'React & TypeScript Lead';

  const rAlloc = emptyRow();
  rAlloc[colIdx('table_name')] = 'allocations';
  rAlloc[colIdx('id')] = 'a-101';
  rAlloc[colIdx('year')] = selectedYear;
  rAlloc[colIdx('person_id')] = 'p-101';
  rAlloc[colIdx('full_name')] = 'Jane Doe';
  rAlloc[colIdx('client_id')] = 'c-101';
  rAlloc[colIdx('client_name')] = 'Acme FinTech';
  rAlloc[colIdx('project_id')] = 'proj-101';
  rAlloc[colIdx('project_name')] = 'NextGen Payments Portal';
  rAlloc[colIdx('code')] = 'NGP-01';
  [75, 75, 75, 75, 75, 75, 50, 50, 50, 50, 50, 50].forEach((pct, i) => {
    rAlloc[colIdx(DB_MONTH_COLUMNS[i])] = pct;
  });
  (
    [
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'planned',
      'planned',
      'planned',
      'planned',
      'unknown',
      'unknown'
    ] as AllocationStatus[]
  ).forEach((st, i) => {
    rAlloc[colIdx(DB_STATUS_COLUMNS[i])] = st;
  });
  rAlloc[colIdx('notes')] = 'Tech Lead';

  const rLeave = emptyRow();
  rLeave[colIdx('table_name')] = 'leaves';
  rLeave[colIdx('id')] = 'leave-101';
  rLeave[colIdx('year')] = selectedYear;
  rLeave[colIdx('person_id')] = 'p-101';
  rLeave[colIdx('full_name')] = 'Jane Doe';
  rLeave[colIdx('leave_type')] = 'vacation';
  rLeave[colIdx('title')] = 'Summer PTO';
  rLeave[colIdx('start_month')] = 6;
  rLeave[colIdx('end_month')] = 7;
  rLeave[colIdx('impact_percent')] = 25;
  rLeave[colIdx('notes')] = '0-based months: 6=Jul, 7=Aug';

  return rowsToCsv([
    headers,
    rYear,
    rDept,
    rLeaveType,
    rClient,
    rProject,
    rPerson,
    rAlloc,
    rLeave
  ]);
}

export function generateTemplateJSON(
  scope: ExportScope,
  selectedYear: number
): string {
  const sampleState: AppState = {
    selectedYear,
    availableYears: [selectedYear, selectedYear + 1],
    departments: ['Engineering', 'Design', 'Platform Security'],
    leaveTypes: {
      vacation: DEFAULT_LEAVE_TYPE_CONFIG.vacation,
      training: {
        label: 'Training & Conference',
        badgeClass: LEAVE_BADGE_THEMES.emerald.badgeClass,
        iconName: 'BookOpen',
        defaultImpact: 50
      }
    },
    clients: [
      {
        id: 'c-101',
        name: 'Acme FinTech',
        industry: 'Financial Services',
        color: '#2563EB',
        status: 'active'
      },
      {
        id: 'c-102',
        name: 'Internal',
        industry: 'Platform & Tooling',
        color: '#059669',
        status: 'active'
      }
    ],
    projects: [
      {
        id: 'proj-101',
        clientId: 'c-101',
        name: 'NextGen Payments Portal',
        code: 'NGP-01',
        status: 'active',
        color: '#2563EB',
        billable: true,
        notes: 'Core Portal Delivery'
      },
      {
        id: 'proj-102',
        clientId: 'c-102',
        name: 'Design System v3',
        code: 'DS-03',
        status: 'active',
        color: '#059669',
        billable: false,
        notes: 'Shared UI Component Library'
      }
    ],
    people: [
      {
        id: 'p-101',
        firstName: 'Jane',
        lastName: 'Doe',
        name: 'Jane Doe',
        role: 'Senior Frontend Engineer',
        department: 'Engineering',
        employmentType: 'Internal',
        email: 'jane.doe@company.internal',
        maxCapacityPercent: 100,
        avatarColor: '#2563EB',
        initials: 'JD',
        notes: 'React & TypeScript Lead'
      }
    ],
    allocations: [
      {
        id: 'a-101',
        personId: 'p-101',
        projectId: 'proj-101',
        year: selectedYear,
        monthlyPercentage: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 0, 0],
        monthlyStatus: [
          'confirmed',
          'confirmed',
          'confirmed',
          'confirmed',
          'planned',
          'planned',
          'planned',
          'planned',
          'unknown',
          'unknown',
          'unknown',
          'unknown'
        ],
        notes: 'Frontend Architecture Lead'
      },
      {
        id: 'a-102',
        personId: 'p-101',
        projectId: 'proj-102',
        year: selectedYear,
        monthlyPercentage: [25, 25, 0, 0, 25, 25, 25, 25, 25, 25, 25, 25],
        monthlyStatus: [
          'confirmed',
          'confirmed',
          'planned',
          'planned',
          'planned',
          'planned',
          'confirmed',
          'confirmed',
          'unknown',
          'unknown',
          'unknown',
          'unknown'
        ],
        notes: 'Component Library'
      }
    ],
    leaves: [
      {
        id: 'leave-101',
        personId: 'p-101',
        type: 'vacation',
        title: 'Summer Family Vacation',
        year: selectedYear,
        startMonth: 6,
        endMonth: 7,
        impactPercent: 50,
        notes: '0-based months: 6=Jul, 7=Aug'
      }
    ]
  };

  return generateViewJSON(sampleState, scope);
}

// ============================================================================
// 5. UNIFIED CSV & JSON IMPORTER (SQLITE-ALIGNED + BACKWARD COMPATIBLE)
// ============================================================================

export interface ImportResult {
  nextState: AppState;
  summaryMessage: string;
}

export function importDataFromFileContent(
  fileContent: string,
  fileName: string,
  currentState: AppState,
  targetScope: ExportScope,
  mergeMode: ImportMergeMode = 'merge'
): ImportResult {
  const trimmed = fileContent.trim();
  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    fileName.toLowerCase().endsWith('.json')
  ) {
    return importFromJsonContent(trimmed, currentState, targetScope, mergeMode);
  }
  return importFromCsvContent(trimmed, currentState, targetScope, mergeMode);
}

function enforceReferentialIntegrity(state: AppState): AppState {
  const deptSet = new Set<string>(state.departments.filter(Boolean));
  for (const p of state.people) {
    if (p.department) deptSet.add(p.department);
  }
  const departments =
    deptSet.size > 0 ? Array.from(deptSet) : ['Engineering', 'Design', 'Product'];

  const clientIds = new Set(state.clients.map((c) => c.id));
  const projects = state.projects.filter((pr) => clientIds.has(pr.clientId));
  const personIds = new Set(state.people.map((p) => p.id));
  const projectIds = new Set(projects.map((pr) => pr.id));

  const allocations = state.allocations.filter(
    (a) => personIds.has(a.personId) && projectIds.has(a.projectId)
  );
  const leaves = state.leaves.filter((l) => personIds.has(l.personId));

  const availableYears = Array.from(
    new Set([
      ...state.availableYears,
      state.selectedYear,
      ...allocations.map((a) => a.year),
      ...leaves.map((l) => l.year)
    ])
  )
    .filter((y) => Number.isFinite(y) && y >= 2000 && y <= 2100)
    .sort((a, b) => a - b);

  const selectedYear = availableYears.includes(state.selectedYear)
    ? state.selectedYear
    : availableYears[0] || new Date().getFullYear();

  return {
    ...state,
    departments,
    projects,
    allocations,
    leaves,
    availableYears,
    selectedYear
  };
}

function importFromJsonContent(
  jsonText: string,
  currentState: AppState,
  targetScope: ExportScope,
  mergeMode: ImportMergeMode
): ImportResult {
  const rawParsed = JSON.parse(jsonText);

  // Support importing a raw array if targetScope points to a table
  let parsed: Record<string, unknown> = {};
  if (Array.isArray(rawParsed)) {
    const inferredKey = isTableScope(targetScope)
      ? tableScopeToTableName(targetScope)
      : 'people';
    parsed = { [inferredKey]: rawParsed };
  } else if (rawParsed && typeof rawParsed === 'object') {
    parsed = rawParsed as Record<string, unknown>;
  } else {
    throw new Error('JSON file must contain an object or array of records.');
  }

  const rawPeople = Array.isArray(parsed.people) ? parsed.people : undefined;
  const rawClients = Array.isArray(parsed.clients) ? parsed.clients : undefined;
  const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : undefined;
  const rawAllocations = Array.isArray(parsed.allocations) ? parsed.allocations : undefined;
  const rawLeaves = Array.isArray(parsed.leaves) ? parsed.leaves : undefined;
  const rawDepartments = Array.isArray(parsed.departments) ? parsed.departments : undefined;
  const rawPlanningYears = Array.isArray(parsed.planning_years)
    ? parsed.planning_years
    : undefined;
  const rawAvailableYears = Array.isArray(parsed.availableYears)
    ? (parsed.availableYears as number[])
    : undefined;
  const rawLeaveTypes = parsed.leaveTypes ?? parsed.leave_types;

  let nextPeople =
    mergeMode === 'replace' && rawPeople ? [] : [...currentState.people];
  let nextClients =
    mergeMode === 'replace' && rawClients ? [] : [...currentState.clients];
  let nextProjects =
    mergeMode === 'replace' && rawProjects ? [] : [...currentState.projects];
  let nextAllocations =
    mergeMode === 'replace' && rawAllocations ? [] : [...currentState.allocations];
  let nextLeaves =
    mergeMode === 'replace' && rawLeaves ? [] : [...currentState.leaves];

  const currentLeaveTypes =
    currentState.leaveTypes && Object.keys(currentState.leaveTypes).length > 0
      ? { ...currentState.leaveTypes }
      : { ...DEFAULT_LEAVE_TYPE_CONFIG };

  let nextLeaveTypes: Record<LeaveType, LeaveTypeMeta> =
    mergeMode === 'replace' && rawLeaveTypes ? {} : { ...currentLeaveTypes };

  let peopleCount = 0;
  let clientsCount = 0;
  let projectsCount = 0;
  let allocationsCount = 0;
  let leavesCount = 0;
  let leaveTypesCount = 0;

  if (Array.isArray(rawLeaveTypes)) {
    for (const item of rawLeaveTypes) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const key = String(r.type_key || r.key || '').trim();
      if (!key) continue;
      nextLeaveTypes[key] = {
        label: String(r.label || key),
        badgeClass: resolveBadgeClassFromTheme(
          String(r.badge_class || r.badgeClass || ''),
          DEFAULT_LEAVE_TYPE_CONFIG[key]?.badgeClass || LEAVE_BADGE_THEMES.blue.badgeClass
        ),
        iconName: String(r.icon_name || r.iconName || 'CalendarOff'),
        defaultImpact: Math.max(
          5,
          Math.min(100, Number(r.default_impact ?? r.defaultImpact ?? 50))
        )
      };
      leaveTypesCount++;
    }
  } else if (rawLeaveTypes && typeof rawLeaveTypes === 'object') {
    for (const [k, rawMeta] of Object.entries(rawLeaveTypes as Record<string, unknown>)) {
      if (!k || !rawMeta || typeof rawMeta !== 'object') continue;
      const meta = rawMeta as Partial<LeaveTypeMeta & { badge_class?: string; icon_name?: string; default_impact?: number }>;
      nextLeaveTypes[k] = {
        label: meta.label || k,
        badgeClass: resolveBadgeClassFromTheme(
          meta.badgeClass || meta.badge_class,
          DEFAULT_LEAVE_TYPE_CONFIG[k]?.badgeClass || LEAVE_BADGE_THEMES.blue.badgeClass
        ),
        iconName: meta.iconName || meta.icon_name || 'CalendarOff',
        defaultImpact: Math.max(
          5,
          Math.min(100, Number(meta.defaultImpact ?? meta.default_impact ?? 50))
        )
      };
      leaveTypesCount++;
    }
  }

  if (Object.keys(nextLeaveTypes).length === 0) {
    nextLeaveTypes = { ...currentLeaveTypes };
  }

  if (rawPeople) {
    for (const raw of rawPeople) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const { firstName, lastName, fullName } = splitPersonName({
        firstName: p.firstName ? String(p.firstName) : undefined,
        lastName: p.lastName ? String(p.lastName) : undefined,
        first_name: p.first_name ? String(p.first_name) : undefined,
        last_name: p.last_name ? String(p.last_name) : undefined,
        full_name: p.full_name ? String(p.full_name) : undefined,
        name: p.name ? String(p.name) : undefined
      });
      if (!fullName) continue;
      peopleCount++;
      const incomingId = p.id ? String(p.id) : '';
      const idx = nextPeople.findIndex(
        (existing) =>
          (incomingId && existing.id === incomingId) ||
          existing.name.toLowerCase() === fullName.toLowerCase()
      );
      const empRaw = (p.employment_type ?? p.employmentType) as string | undefined;
      const maxCapRaw = p.max_capacity_percent ?? p.maxCapacityPercent;
      const avatarColorRaw = (p.avatar_color ?? p.avatarColor) as string | undefined;
      const normalizedPerson: Person = {
        id:
          idx >= 0
            ? nextPeople[idx].id
            : incomingId || `p-${Date.now()}-${nextPeople.length + 1}`,
        firstName: firstName || (idx >= 0 ? nextPeople[idx].firstName : 'Team'),
        lastName: lastName || (idx >= 0 ? nextPeople[idx].lastName : ''),
        name: fullName,
        role: String(p.role || (idx >= 0 ? nextPeople[idx].role : 'Specialist')),
        department: String(
          p.department || (idx >= 0 ? nextPeople[idx].department : 'Engineering')
        ),
        employmentType: parseEmploymentType(
          empRaw,
          idx >= 0 ? nextPeople[idx].employmentType || 'Internal' : 'Internal'
        ),
        email: String(
          p.email ||
            (idx >= 0
              ? nextPeople[idx].email
              : `${fullName.toLowerCase().replace(/\s+/g, '.')}@company.internal`)
        ),
        maxCapacityPercent:
          maxCapRaw !== undefined
            ? parsePercentValue(String(maxCapRaw), 100)
            : idx >= 0
            ? nextPeople[idx].maxCapacityPercent
            : 100,
        avatarColor:
          avatarColorRaw ||
          (idx >= 0
            ? nextPeople[idx].avatarColor
            : AVATAR_COLORS[nextPeople.length % AVATAR_COLORS.length]),
        initials: String(
          p.initials || (idx >= 0 ? nextPeople[idx].initials : getInitials(fullName))
        ),
        isActive:
          p.is_active !== undefined || p.isActive !== undefined
            ? ['1', 'true', 'active', 'yes'].includes(
                String(p.is_active ?? p.isActive).trim().toLowerCase()
              )
            : idx >= 0
            ? nextPeople[idx].isActive !== false
            : true,
        notes:
          p.notes !== undefined
            ? String(p.notes || '') || undefined
            : idx >= 0
            ? nextPeople[idx].notes
            : undefined
      };
      if (idx >= 0) nextPeople[idx] = normalizedPerson;
      else nextPeople.push(normalizedPerson);
    }
  }

  if (Array.isArray(parsed.benchSummaries)) {
    for (const rawB of parsed.benchSummaries) {
      if (!rawB || typeof rawB !== 'object') continue;
      const b = rawB as Record<string, unknown>;
      const { firstName, lastName, fullName } = splitPersonName({
        firstName: b.firstName ? String(b.firstName) : undefined,
        lastName: b.lastName ? String(b.lastName) : undefined,
        first_name: b.first_name ? String(b.first_name) : undefined,
        last_name: b.last_name ? String(b.last_name) : undefined,
        full_name: b.full_name ? String(b.full_name) : undefined,
        name: b.name ? String(b.name) : undefined
      });
      if (!fullName) continue;
      peopleCount++;
      const pid = String(b.person_id || b.personId || '');
      const idx = nextPeople.findIndex(
        (existing) =>
          (pid && existing.id === pid) ||
          existing.name.toLowerCase() === fullName.toLowerCase()
      );
      const empRaw = (b.employment_type ?? b.employmentType) as string | undefined;
      const maxCapRaw = b.max_capacity_percent ?? b.maxCapacityPercent;
      if (idx >= 0) {
        nextPeople[idx] = {
          ...nextPeople[idx],
          firstName: firstName || nextPeople[idx].firstName,
          lastName: lastName || nextPeople[idx].lastName,
          name: fullName,
          role: b.role ? String(b.role) : nextPeople[idx].role,
          department: b.department ? String(b.department) : nextPeople[idx].department,
          employmentType: empRaw
            ? parseEmploymentType(empRaw, nextPeople[idx].employmentType || 'Internal')
            : nextPeople[idx].employmentType || 'Internal',
          maxCapacityPercent:
            maxCapRaw !== undefined
              ? parsePercentValue(String(maxCapRaw), nextPeople[idx].maxCapacityPercent)
              : nextPeople[idx].maxCapacityPercent,
          notes:
            b.notes !== undefined
              ? String(b.notes || '') || undefined
              : nextPeople[idx].notes
        };
      } else {
        nextPeople.push({
          id: pid || `p-${Date.now()}-${nextPeople.length + 1}`,
          firstName,
          lastName,
          name: fullName,
          role: String(b.role || 'Specialist'),
          department: String(b.department || 'Engineering'),
          employmentType: parseEmploymentType(empRaw, 'Internal'),
          email: String(
            b.email || `${fullName.toLowerCase().replace(/\s+/g, '.')}@company.internal`
          ),
          maxCapacityPercent:
            maxCapRaw !== undefined ? parsePercentValue(String(maxCapRaw), 100) : 100,
          avatarColor: AVATAR_COLORS[nextPeople.length % AVATAR_COLORS.length],
          initials: getInitials(fullName),
          notes: b.notes ? String(b.notes) : undefined
        });
      }
    }
  }

  if (rawClients) {
    for (const rawC of rawClients) {
      if (!rawC || typeof rawC !== 'object') continue;
      const c = rawC as Record<string, unknown>;
      const name = String(c.name || '').trim();
      if (!name) continue;
      clientsCount++;
      const incomingId = c.id ? String(c.id) : '';
      const idx = nextClients.findIndex(
        (existing) =>
          (incomingId && existing.id === incomingId) ||
          existing.name.toLowerCase() === name.toLowerCase()
      );
      const createdOrUpdated: Client = {
        id:
          idx >= 0
            ? nextClients[idx].id
            : incomingId || `c-${Date.now()}-${nextClients.length + 1}`,
        name,
        industry: String(
          c.industry ?? (idx >= 0 ? nextClients[idx].industry : 'Technology')
        ),
        color: String(
          c.color ||
            (idx >= 0
              ? nextClients[idx].color
              : AVATAR_COLORS[nextClients.length % AVATAR_COLORS.length])
        ),
        status: parseClientStatus(
          c.status ? String(c.status) : undefined,
          idx >= 0 ? nextClients[idx].status : 'active'
        )
      };
      if (idx >= 0) nextClients[idx] = createdOrUpdated;
      else nextClients.push(createdOrUpdated);
    }
  }

  if (rawProjects) {
    for (const rawPr of rawProjects) {
      if (!rawPr || typeof rawPr !== 'object') continue;
      const proj = rawPr as Record<string, unknown>;
      const name = String(proj.name || '').trim();
      if (!name) continue;
      projectsCount++;
      const incomingId = proj.id ? String(proj.id) : '';
      const incomingCode = String(proj.code || '').trim();
      const idx = nextProjects.findIndex(
        (existing) =>
          (incomingId && existing.id === incomingId) ||
          (incomingCode && existing.code.toLowerCase() === incomingCode.toLowerCase()) ||
          existing.name.toLowerCase() === name.toLowerCase()
      );
      const resolvedClientId = String(
        proj.client_id ??
          proj.clientId ??
          (idx >= 0 ? nextProjects[idx].clientId : nextClients[0]?.id || 'c-default')
      );
      const createdOrUpdated: Project = {
        id:
          idx >= 0
            ? nextProjects[idx].id
            : incomingId || `proj-${Date.now()}-${nextProjects.length + 1}`,
        clientId: resolvedClientId,
        name,
        code:
          incomingCode ||
          (idx >= 0 ? nextProjects[idx].code : name.slice(0, 4).toUpperCase()),
        status: parseProjectStatus(
          proj.status ? String(proj.status) : undefined,
          idx >= 0 ? nextProjects[idx].status : 'active'
        ),
        color: String(
          proj.color ||
            (idx >= 0
              ? nextProjects[idx].color
              : AVATAR_COLORS[nextProjects.length % AVATAR_COLORS.length])
        ),
        billable: parseBoolFlag(
          proj.billable as string | number | boolean | undefined,
          idx >= 0 ? nextProjects[idx].billable : true
        ),
        notes:
          proj.notes !== undefined
            ? String(proj.notes || '') || undefined
            : idx >= 0
            ? nextProjects[idx].notes
            : undefined
      };
      if (idx >= 0) nextProjects[idx] = createdOrUpdated;
      else nextProjects.push(createdOrUpdated);
    }
  }

  if (rawAllocations) {
    for (const rawA of rawAllocations) {
      if (!rawA || typeof rawA !== 'object') continue;
      const alloc = rawA as Record<string, unknown>;
      const personId = String(alloc.person_id ?? alloc.personId ?? '').trim();
      const projectId = String(alloc.project_id ?? alloc.projectId ?? '').trim();
      if (!personId || !projectId) continue;

      const monthlyPercentage: number[] = Array.isArray(alloc.monthlyPercentage)
        ? Array.from({ length: 12 }, (_, i) =>
            parsePercentValue(alloc.monthlyPercentage ? (alloc.monthlyPercentage as unknown[])[i] as number : 0, 0)
          )
        : DB_MONTH_COLUMNS.map((mCol) =>
            parsePercentValue(alloc[mCol] as string | number | undefined, 0)
          );

      const year = Number(alloc.year || currentState.selectedYear);
      const incomingId = alloc.id ? String(alloc.id) : '';
      allocationsCount++;

      const idx = nextAllocations.findIndex(
        (existing) =>
          (incomingId && existing.id === incomingId) ||
          (existing.personId === personId &&
            existing.projectId === projectId &&
            existing.year === year)
      );

      const hasJsonStatusArray = Array.isArray(alloc.monthlyStatus);
      const hasJsonStatusCols = DB_STATUS_COLUMNS.some((sCol) => alloc[sCol] !== undefined);
      const existingStatuses =
        idx >= 0
          ? normalizeAllocationStatuses(nextAllocations[idx].monthlyStatus, 'unknown')
          : normalizeAllocationStatuses(undefined, 'unknown');
      const monthlyStatus: AllocationStatus[] = hasJsonStatusArray
        ? normalizeAllocationStatuses(alloc.monthlyStatus as unknown[], 'unknown')
        : hasJsonStatusCols
        ? DB_STATUS_COLUMNS.map((sCol, mIdx) =>
            alloc[sCol] !== undefined
              ? normalizeAllocationStatus(alloc[sCol], existingStatuses[mIdx])
              : existingStatuses[mIdx]
          )
        : existingStatuses;

      const normalizedAlloc: Allocation = {
        id:
          idx >= 0
            ? nextAllocations[idx].id
            : incomingId || `a-${Date.now()}-${nextAllocations.length + 1}`,
        personId,
        projectId,
        year,
        monthlyPercentage,
        monthlyStatus,
        notes:
          alloc.notes !== undefined
            ? String(alloc.notes || '') || undefined
            : idx >= 0
            ? nextAllocations[idx].notes
            : undefined
      };
      if (idx >= 0) nextAllocations[idx] = normalizedAlloc;
      else nextAllocations.push(normalizedAlloc);
    }
  }

  if (rawLeaves) {
    for (const rawL of rawLeaves) {
      if (!rawL || typeof rawL !== 'object') continue;
      const leave = rawL as Record<string, unknown>;
      const personId = String(leave.person_id ?? leave.personId ?? '').trim();
      if (!personId) continue;
      leavesCount++;

      const leaveType = String(leave.leave_type ?? leave.type ?? 'vacation').trim() || 'vacation';
      if (!nextLeaveTypes[leaveType]) {
        nextLeaveTypes[leaveType] = getLeaveTypeMeta(leaveType, nextLeaveTypes);
      }

      const startRaw = leave.start_month ?? leave.startMonth ?? 0;
      const endRaw = leave.end_month ?? leave.endMonth ?? startRaw;
      const startMonth = Math.max(0, Math.min(11, Number(startRaw)));
      const endMonth = Math.max(startMonth, Math.min(11, Number(endRaw)));
      const year = Number(leave.year || currentState.selectedYear);
      const title = String(leave.title || nextLeaveTypes[leaveType].label);
      const impactPercent = parsePercentValue(
        (leave.impact_percent ?? leave.impactPercent) as string | number | undefined,
        nextLeaveTypes[leaveType].defaultImpact
      );
      const incomingId = leave.id ? String(leave.id) : '';

      const idx = nextLeaves.findIndex(
        (existing) =>
          (incomingId && existing.id === incomingId) ||
          (existing.personId === personId &&
            existing.year === year &&
            existing.title.toLowerCase() === title.toLowerCase() &&
            existing.startMonth === startMonth)
      );

      const normalizedLeave: LeaveEntry = {
        id:
          idx >= 0
            ? nextLeaves[idx].id
            : incomingId || `leave-${Date.now()}-${nextLeaves.length + 1}`,
        personId,
        type: leaveType,
        title,
        year,
        startMonth,
        endMonth,
        impactPercent,
        notes:
          leave.notes !== undefined
            ? String(leave.notes || '') || undefined
            : idx >= 0
            ? nextLeaves[idx].notes
            : undefined
      };
      if (idx >= 0) nextLeaves[idx] = normalizedLeave;
      else nextLeaves.push(normalizedLeave);
    }
  }

  const parsedYearNumbers: number[] = [];
  let parsedSelectedYear: number | undefined =
    typeof parsed.selectedYear === 'number' ? parsed.selectedYear : undefined;

  if (rawPlanningYears) {
    for (const item of rawPlanningYears) {
      if (typeof item === 'number') {
        parsedYearNumbers.push(item);
      } else if (item && typeof item === 'object') {
        const yrObj = item as Record<string, unknown>;
        const yr = Number(yrObj.year);
        if (Number.isFinite(yr) && yr >= 2000 && yr <= 2100) {
          parsedYearNumbers.push(yr);
          if (Number(yrObj.is_selected) === 1 && parsedSelectedYear === undefined) {
            parsedSelectedYear = yr;
          }
        }
      }
    }
  }
  if (rawAvailableYears) {
    for (const y of rawAvailableYears) {
      if (typeof y === 'number' && Number.isFinite(y)) parsedYearNumbers.push(y);
    }
  }

  const allYears = Array.from(
    new Set([
      ...(mergeMode === 'replace' && parsedYearNumbers.length > 0
        ? []
        : currentState.availableYears),
      ...parsedYearNumbers,
      ...nextAllocations.map((a) => a.year),
      ...nextLeaves.map((l) => l.year)
    ])
  ).sort((a, b) => a - b);

  const parsedDeptNames: string[] = [];
  if (rawDepartments) {
    const sorted = [...rawDepartments].sort((a, b) => {
      const ao = typeof a === 'object' && a ? Number((a as Record<string, unknown>).sort_order ?? 0) : 0;
      const bo = typeof b === 'object' && b ? Number((b as Record<string, unknown>).sort_order ?? 0) : 0;
      return ao - bo;
    });
    for (const d of sorted) {
      if (typeof d === 'string' && d.trim()) parsedDeptNames.push(d.trim());
      else if (d && typeof d === 'object' && (d as Record<string, unknown>).name) {
        parsedDeptNames.push(String((d as Record<string, unknown>).name).trim());
      }
    }
  }

  const allDepts = Array.from(
    new Set([
      ...(mergeMode === 'replace' && parsedDeptNames.length > 0
        ? []
        : currentState.departments),
      ...parsedDeptNames,
      ...nextPeople.map((p) => p.department).filter(Boolean)
    ])
  );

  syncLeaveTypeConfigRegistry(nextLeaveTypes);

  const rawNextState: AppState = {
    people: nextPeople,
    clients: nextClients,
    projects: nextProjects,
    allocations: nextAllocations,
    leaves: nextLeaves,
    availableYears: allYears.length > 0 ? allYears : [2025, 2026, 2027],
    selectedYear:
      parsedSelectedYear !== undefined ? parsedSelectedYear : currentState.selectedYear,
    departments: allDepts,
    leaveTypes: nextLeaveTypes
  };

  const nextState = enforceReferentialIntegrity(rawNextState);

  const parts: string[] = [];
  if (peopleCount > 0) parts.push(`${peopleCount} people`);
  if (clientsCount > 0) parts.push(`${clientsCount} clients`);
  if (projectsCount > 0) parts.push(`${projectsCount} projects`);
  if (allocationsCount > 0) parts.push(`${allocationsCount} allocations`);
  if (leavesCount > 0) parts.push(`${leavesCount} leaves`);
  if (leaveTypesCount > 0) parts.push(`${leaveTypesCount} leave types`);
  if (parsedDeptNames.length > 0) parts.push(`${parsedDeptNames.length} departments`);
  if (parsedYearNumbers.length > 0) parts.push(`${parsedYearNumbers.length} years`);

  return {
    nextState,
    summaryMessage:
      parts.length > 0
        ? `Successfully imported SQLite-aligned JSON (${parts.join(', ')}).`
        : `Successfully imported JSON data for ${targetScope}.`
  };
}

function detectStandaloneTableFromHeaders(
  lowerHeaders: string[],
  targetScope: ExportScope
): SQLiteTableName | null {
  const has = (name: string) => lowerHeaders.includes(name);
  if (has('table_name') || has('record_type') || has('row_type')) {
    return null;
  }

  if (has('year') && has('is_selected') && !has('person_id') && !has('project_id')) {
    return 'planning_years';
  }
  if (has('sort_order') && has('name') && !has('id') && !has('client_id')) {
    return 'departments';
  }
  if (has('type_key') || (has('badge_class') && has('default_impact'))) {
    return 'leave_types';
  }
  if (
    (has('person_id') || has('full_name') || has('first_name') || has('person name')) &&
    (has('project_id') || has('project_name') || has('project')) &&
    has('jan')
  ) {
    return 'allocations';
  }
  if (
    (has('leave_type') || has('start_month') || has('impact_percent')) &&
    (has('person_id') || has('full_name') || has('first_name') || has('person name')) &&
    !has('project_id')
  ) {
    return 'leaves';
  }
  if (has('client_id') && (has('code') || has('billable'))) {
    return 'projects';
  }
  if (has('industry') && has('status') && !has('client_id') && !has('role')) {
    return 'clients';
  }
  if (
    has('first_name') ||
    has('full_name') ||
    has('employment_type') ||
    (has('role') && has('department'))
  ) {
    return 'people';
  }

  if (isTableScope(targetScope)) {
    return tableScopeToTableName(targetScope);
  }
  return null;
}

function importFromCsvContent(
  csvText: string,
  currentState: AppState,
  targetScope: ExportScope,
  mergeMode: ImportMergeMode
): ImportResult {
  const rows = parseCsvToRows(csvText);
  if (rows.length < 2) {
    throw new Error('CSV file must contain a header row and at least one data row.');
  }

  const rawHeaders = rows[0].map((h) => h.trim());
  const lowerHeaders = rawHeaders.map((h) => h.toLowerCase());

  const colIndex = (candidates: string[], allowSubstringMatch: boolean = true): number => {
    for (const c of candidates) {
      const idx = lowerHeaders.findIndex((h) => h === c.toLowerCase());
      if (idx >= 0) return idx;
    }
    if (allowSubstringMatch) {
      for (const c of candidates) {
        const idx = lowerHeaders.findIndex((h) => h.includes(c.toLowerCase()));
        if (idx >= 0) return idx;
      }
    }
    return -1;
  };

  const detectedStandaloneTable = detectStandaloneTableFromHeaders(lowerHeaders, targetScope);

  const idxTableName = (() => {
    const primary = colIndex(['table_name', 'row type', 'record type']);
    return primary >= 0 ? primary : colIndex(['type'], false);
  })();
  const idxId = colIndex(['id']);
  const idxYear = colIndex(['year']);
  const idxIsSelected = colIndex(['is_selected']);
  const idxSortOrder = colIndex(['sort_order']);

  const idxPersonId = colIndex(['person_id']);
  const idxFirstName = colIndex(['first_name', 'first name', 'firstname', 'given name']);
  const idxLastName = colIndex(['last_name', 'last name', 'lastname', 'surname', 'family name']);
  const idxPersonName = colIndex([
    'full_name',
    'person name',
    'full name',
    'team member',
    'person',
    'staff'
  ]);
  const idxRole = colIndex(['role', 'job title']);
  const idxDept = colIndex(['department', 'dept']);
  const idxEmployment = colIndex([
    'employment_type',
    'employment',
    'employment type',
    'contract',
    'contract type'
  ]);
  const idxEmail = colIndex(['email']);
  const idxMaxCap = colIndex([
    'max_capacity_percent',
    'max capacity %',
    'max capacity',
    'base capacity'
  ]);
  const idxAvatarColor = colIndex(['avatar_color']);
  const idxInitials = colIndex(['initials']);
  const idxGenericName = colIndex(['name']);
  const idxGenericStatus = colIndex(['status'], false);
  const idxColor = colIndex(['color']);
  const idxNotes = colIndex(['notes']);

  const idxPersonComment = colIndex([
    'person comment',
    'skills & bench comment',
    'staffing note',
    'skills note',
    'person note',
    'comment'
  ]);

  const idxClientId = colIndex(['client_id']);
  const idxClient = colIndex(['client_name', 'client', 'client name']);
  const idxIndustry = colIndex(['industry']);
  const idxClientStatus = colIndex(['client_status', 'client status']);

  const idxProjectId = colIndex(['project_id']);
  const idxProject = colIndex(['project_name', 'project', 'project name']);
  const idxProjectCode = colIndex(['code', 'project code']);
  const idxProjectStatus = (() => {
    const primary = colIndex(['project_status', 'project status']);
    return primary >= 0 ? primary : colIndex(['status'], false);
  })();
  const idxBillable = colIndex(['billable']);
  const idxProjectComment = colIndex(['project scope comment', 'scope note', 'project note']);
  const idxAllocComment = colIndex(['assignment note', 'role note', 'allocation note']);

  const idxLeaveType = colIndex(['type_key', 'leave_type', 'leave category', 'leave type']);
  const idxLeaveTypeLabel = colIndex(['label', 'leave type label', 'category label']);
  const idxBadgeClass = colIndex(['badge_class', 'badge theme', 'theme', 'badge color']);
  const idxIconName = colIndex(['icon_name']);
  const idxDefaultImpact = colIndex(['default_impact']);
  const idxLeaveTitle = colIndex(['title', 'leave title', 'reason']);
  const idxStartMonth = colIndex(['start_month', 'start month', 'from month']);
  const idxEndMonth = colIndex(['end_month', 'end month', 'to month']);
  const idxImpact = colIndex(['impact_percent', 'impact %', 'impact', 'capacity reduction']);
  const idxLeaveNote = colIndex(['leave note']);

  const isZeroBasedMonthColumn = lowerHeaders.includes('start_month');

  const monthIndices: number[] = MONTH_NAMES.map((m, i) => {
    const full = MONTH_FULL_NAMES[i].toLowerCase();
    const short = m.toLowerCase();
    return lowerHeaders.findIndex(
      (h) => h === short || h === full || h.startsWith(`${short} `)
    );
  });

  const statusIndices: number[] = DB_STATUS_COLUMNS.map((sCol) =>
    lowerHeaders.findIndex((h) => h === sCol)
  );
  const hasStatusColumns = statusIndices.some((colIdx) => colIdx >= 0);

  // Determine replace semantics aligned with SQLite tables
  const rowDiscriminators = new Set<string>(
    rows
      .slice(1)
      .map((r) =>
        idxTableName >= 0 && idxTableName < r.length ? r[idxTableName].trim().toLowerCase() : ''
      )
      .filter(Boolean)
  );

  const hasType = (...aliases: string[]) => aliases.some((a) => rowDiscriminators.has(a));

  let nextPeople =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'people' ||
      targetScope === 'table_people' ||
      (targetScope === 'all' && hasType('people', 'person')))
      ? []
      : [...currentState.people];

  let nextClients =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'clients' ||
      targetScope === 'table_clients' ||
      (targetScope === 'all' && hasType('clients', 'client')))
      ? []
      : [...currentState.clients];

  let nextProjects =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'projects' ||
      targetScope === 'table_projects' ||
      (targetScope === 'all' && hasType('projects', 'project')))
      ? []
      : [...currentState.projects];

  let nextDepartments =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'departments' ||
      targetScope === 'table_departments' ||
      (targetScope === 'all' && hasType('departments', 'department')))
      ? []
      : [...currentState.departments];

  let nextAvailableYears =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'planning_years' ||
      targetScope === 'table_planning_years' ||
      (targetScope === 'all' && hasType('planning_years')))
      ? []
      : [...currentState.availableYears];

  let nextSelectedYear = currentState.selectedYear;

  const currentLeaveTypes =
    currentState.leaveTypes && Object.keys(currentState.leaveTypes).length > 0
      ? { ...currentState.leaveTypes }
      : { ...DEFAULT_LEAVE_TYPE_CONFIG };

  const hasExplicitLeaveTypeRows =
    detectedStandaloneTable === 'leave_types' ||
    targetScope === 'table_leave_types' ||
    hasType('leave_types', 'leave type', 'leavetype');

  const nextLeaveTypes: Record<LeaveType, LeaveTypeMeta> =
    mergeMode === 'replace' &&
    hasExplicitLeaveTypeRows &&
    (detectedStandaloneTable === 'leave_types' ||
      targetScope === 'table_leave_types' ||
      targetScope === 'availability' ||
      targetScope === 'admin' ||
      targetScope === 'all')
      ? {}
      : { ...currentLeaveTypes };

  const nextAllocations =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'allocations' || targetScope === 'table_allocations')
      ? []
      : mergeMode === 'replace' &&
        (targetScope === 'people' || targetScope === 'clients' || targetScope === 'all')
      ? currentState.allocations.filter((a) => a.year !== currentState.selectedYear)
      : [...currentState.allocations];

  const nextLeaves =
    mergeMode === 'replace' &&
    (detectedStandaloneTable === 'leaves' || targetScope === 'table_leaves')
      ? []
      : mergeMode === 'replace' &&
        (targetScope === 'availability' || targetScope === 'admin' || targetScope === 'all')
      ? currentState.leaves.filter((l) => l.year !== currentState.selectedYear)
      : [...currentState.leaves];

  let updatedPeopleCount = 0;
  let updatedClientsCount = 0;
  let updatedProjectsCount = 0;
  let updatedAllocationsCount = 0;
  let updatedLeavesCount = 0;
  let updatedLeaveTypesCount = 0;
  let updatedDeptsCount = 0;
  let updatedYearsCount = 0;

  const ensureDepartment = (deptName: string) => {
    const clean = deptName.trim();
    if (!clean || clean.toLowerCase() === 'all') return;
    if (!nextDepartments.some((d) => d.toLowerCase() === clean.toLowerCase())) {
      nextDepartments.push(clean);
      updatedDeptsCount++;
    }
  };

  const resolveOrRegisterLeaveType = (
    rawCategory: string,
    rawLabel?: string,
    rawBadgeTheme?: string,
    rawImpact?: number,
    rawIconName?: string
  ): LeaveType => {
    const catClean = rawCategory.trim();
    const labelClean = (rawLabel || '').trim();

    if (catClean) {
      const exactKey = Object.keys(nextLeaveTypes).find(
        (k) => k.toLowerCase() === catClean.toLowerCase()
      );
      if (exactKey) {
        if (labelClean || rawBadgeTheme || rawImpact !== undefined || rawIconName) {
          nextLeaveTypes[exactKey] = {
            ...nextLeaveTypes[exactKey],
            label: labelClean || nextLeaveTypes[exactKey].label,
            badgeClass: rawBadgeTheme
              ? resolveBadgeClassFromTheme(rawBadgeTheme, nextLeaveTypes[exactKey].badgeClass)
              : nextLeaveTypes[exactKey].badgeClass,
            iconName: rawIconName || nextLeaveTypes[exactKey].iconName,
            defaultImpact:
              rawImpact !== undefined && rawImpact > 0
                ? rawImpact
                : nextLeaveTypes[exactKey].defaultImpact
          };
          updatedLeaveTypesCount++;
        }
        return exactKey;
      }

      const byLabelKey = Object.keys(nextLeaveTypes).find(
        (k) => nextLeaveTypes[k].label.toLowerCase() === catClean.toLowerCase()
      );
      if (byLabelKey) return byLabelKey;
    }

    if (labelClean) {
      const byLabelKey = Object.keys(nextLeaveTypes).find(
        (k) => nextLeaveTypes[k].label.toLowerCase() === labelClean.toLowerCase()
      );
      if (byLabelKey) return byLabelKey;
    }

    if (!catClean && !labelClean) {
      return nextLeaveTypes['vacation']
        ? 'vacation'
        : Object.keys(nextLeaveTypes)[0] || 'vacation';
    }

    const newKey =
      (catClean || labelClean)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `custom_${Date.now()}`;

    const finalLabel =
      labelClean ||
      catClean.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

    const defaultMeta = DEFAULT_LEAVE_TYPE_CONFIG[newKey];
    nextLeaveTypes[newKey] = {
      label: finalLabel,
      badgeClass: resolveBadgeClassFromTheme(
        rawBadgeTheme,
        defaultMeta?.badgeClass || LEAVE_BADGE_THEMES.teal.badgeClass
      ),
      iconName: rawIconName || defaultMeta?.iconName || 'CalendarOff',
      defaultImpact:
        rawImpact !== undefined && rawImpact > 0
          ? Math.max(5, Math.min(100, rawImpact))
          : defaultMeta?.defaultImpact || 50
    };
    updatedLeaveTypesCount++;
    return newKey;
  };

  const ensurePerson = (params: {
    id?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    role?: string;
    dept?: string;
    employmentRaw?: string;
    email?: string;
    maxCap?: number;
    avatarColor?: string;
    initials?: string;
    notes?: string;
  }): Person | null => {
    const { firstName, lastName, fullName } = splitPersonName({
      firstName: params.firstName,
      lastName: params.lastName,
      name: params.fullName
    });

    if (params.dept) ensureDepartment(params.dept);

    const existingIdx = nextPeople.findIndex(
      (p) =>
        (params.id && p.id === params.id) ||
        (fullName && p.name.toLowerCase() === fullName.toLowerCase())
    );

    if (existingIdx >= 0) {
      const existing = nextPeople[existingIdx];
      const updated: Person = {
        ...existing,
        firstName: firstName || existing.firstName,
        lastName: lastName || existing.lastName,
        name: fullName || existing.name,
        role: params.role || existing.role,
        department: params.dept || existing.department,
        employmentType: params.employmentRaw
          ? parseEmploymentType(params.employmentRaw, existing.employmentType || 'Internal')
          : existing.employmentType || 'Internal',
        email: params.email || existing.email,
        maxCapacityPercent:
          params.maxCap !== undefined ? params.maxCap : existing.maxCapacityPercent,
        avatarColor: params.avatarColor || existing.avatarColor,
        initials: params.initials || existing.initials,
        notes:
          params.notes !== undefined && params.notes !== '' ? params.notes : existing.notes
      };
      nextPeople[existingIdx] = updated;
      updatedPeopleCount++;
      return updated;
    }

    if (!fullName && !params.id) return null;

    const finalName = fullName || params.id || 'Team Member';
    const created: Person = {
      id: params.id || `p-${Date.now()}-${nextPeople.length + 1}`,
      firstName: firstName || finalName.split(' ')[0] || 'Team',
      lastName,
      name: finalName,
      role: params.role || 'Specialist',
      department: params.dept || 'Engineering',
      employmentType: parseEmploymentType(params.employmentRaw, 'Internal'),
      email:
        params.email || `${finalName.toLowerCase().replace(/\s+/g, '.')}@company.internal`,
      maxCapacityPercent: params.maxCap ?? 100,
      avatarColor:
        params.avatarColor || AVATAR_COLORS[nextPeople.length % AVATAR_COLORS.length],
      initials: params.initials || getInitials(finalName),
      notes: params.notes || undefined
    };
    nextPeople.push(created);
    updatedPeopleCount++;
    return created;
  };

  const ensureClient = (params: {
    id?: string;
    name: string;
    industry?: string;
    color?: string;
    status?: string;
  }): Client => {
    const cleanName = params.name.trim() || params.id || 'Internal';
    const existingIdx = nextClients.findIndex(
      (c) =>
        (params.id && c.id === params.id) ||
        c.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (existingIdx >= 0) {
      nextClients[existingIdx] = {
        ...nextClients[existingIdx],
        name: params.name.trim() || nextClients[existingIdx].name,
        industry: params.industry || nextClients[existingIdx].industry,
        color: params.color || nextClients[existingIdx].color,
        status: params.status
          ? parseClientStatus(params.status, nextClients[existingIdx].status)
          : nextClients[existingIdx].status
      };
      updatedClientsCount++;
      return nextClients[existingIdx];
    }

    const created: Client = {
      id: params.id || `c-${Date.now()}-${nextClients.length + 1}`,
      name: cleanName,
      industry: params.industry || 'Technology',
      color: params.color || AVATAR_COLORS[nextClients.length % AVATAR_COLORS.length],
      status: parseClientStatus(params.status, 'active')
    };
    nextClients.push(created);
    updatedClientsCount++;
    return created;
  };

  const ensureProject = (params: {
    id?: string;
    name: string;
    code?: string;
    clientId: string;
    status?: string;
    color?: string;
    billableStr?: string;
    notes?: string;
  }): Project => {
    const existingIdx = nextProjects.findIndex(
      (p) =>
        (params.id && p.id === params.id) ||
        (params.name && p.name.toLowerCase() === params.name.toLowerCase()) ||
        (params.code && p.code.toLowerCase() === params.code.toLowerCase())
    );
    const hasBillableVal = params.billableStr !== undefined && params.billableStr !== '';
    const isBillable = hasBillableVal ? parseBoolFlag(params.billableStr, true) : undefined;

    if (existingIdx >= 0) {
      const existing = nextProjects[existingIdx];
      const updated: Project = {
        ...existing,
        clientId: params.clientId || existing.clientId,
        name: params.name || existing.name,
        code: params.code || existing.code,
        status: parseProjectStatus(params.status, existing.status),
        color: params.color || existing.color,
        billable: isBillable !== undefined ? isBillable : existing.billable,
        notes:
          params.notes !== undefined && params.notes !== '' ? params.notes : existing.notes
      };
      nextProjects[existingIdx] = updated;
      updatedProjectsCount++;
      return updated;
    }

    const cleanName = params.name.trim() || params.code || params.id || 'Project';
    const code =
      params.code ||
      cleanName
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 6) ||
      'PRJ';

    const created: Project = {
      id: params.id || `proj-${Date.now()}-${nextProjects.length + 1}`,
      clientId: params.clientId,
      name: cleanName,
      code,
      status: parseProjectStatus(params.status, 'active'),
      color: params.color || AVATAR_COLORS[nextProjects.length % AVATAR_COLORS.length],
      billable: isBillable ?? true,
      notes: params.notes || undefined
    };
    nextProjects.push(created);
    updatedProjectsCount++;
    return created;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const getCell = (idx: number): string =>
      idx >= 0 && idx < row.length ? row[idx].trim() : '';

    const rawTableOrType = getCell(idxTableName).toLowerCase();
    const effectiveTable = detectedStandaloneTable || rawTableOrType;

    const rowId = getCell(idxId);
    const rowYearNum = parseInt(getCell(idxYear), 10);
    const year =
      !isNaN(rowYearNum) && rowYearNum >= 2000 && rowYearNum <= 2100
        ? rowYearNum
        : currentState.selectedYear;
    const isSelectedRaw = getCell(idxIsSelected);

    const personIdVal =
      getCell(idxPersonId) || (effectiveTable === 'people' ? rowId : '');
    const firstNameVal = getCell(idxFirstName);
    const lastNameVal = getCell(idxLastName);
    const legacyFullNameVal = getCell(idxPersonName);
    const role = getCell(idxRole);
    const dept =
      getCell(idxDept) || (effectiveTable === 'departments' ? getCell(idxGenericName) : '');
    const employmentRaw = getCell(idxEmployment);
    const email = getCell(idxEmail);
    const maxCapRaw = getCell(idxMaxCap);
    const maxCap = maxCapRaw ? parsePercentValue(maxCapRaw, 100) : undefined;
    const avatarColor = getCell(idxAvatarColor);
    const initials = getCell(idxInitials);
    const rowNotes = getCell(idxNotes);
    const personComment =
      getCell(idxPersonComment) ||
      (effectiveTable === 'people' ||
      effectiveTable === 'person_summary' ||
      effectiveTable === 'person summary' ||
      effectiveTable === 'bench_availability' ||
      effectiveTable === 'bench availability'
        ? rowNotes
        : '');

    const clientIdVal =
      getCell(idxClientId) || (effectiveTable === 'clients' ? rowId : '');
    const clientName =
      getCell(idxClient) || (effectiveTable === 'clients' ? getCell(idxGenericName) : '');
    const industry = getCell(idxIndustry);
    const clientStatusRaw =
      getCell(idxClientStatus) || (effectiveTable === 'clients' ? getCell(idxGenericStatus) : '');

    const projectIdVal =
      getCell(idxProjectId) || (effectiveTable === 'projects' ? rowId : '');
    const projectName =
      getCell(idxProject) || (effectiveTable === 'projects' ? getCell(idxGenericName) : '');
    const projectCode = getCell(idxProjectCode);
    const projectStatus = getCell(idxProjectStatus);
    const billableStr = getCell(idxBillable);
    const entityColor = getCell(idxColor);
    const projectComment =
      getCell(idxProjectComment) ||
      (effectiveTable === 'projects' ||
      effectiveTable === 'project_summary' ||
      effectiveTable === 'project summary'
        ? rowNotes
        : '');
    const allocComment =
      getCell(idxAllocComment) || (effectiveTable === 'allocations' ? rowNotes : '');

    const leaveTypeRaw = getCell(idxLeaveType);
    const leaveTypeLabel = getCell(idxLeaveTypeLabel);
    const badgeThemeRaw = getCell(idxBadgeClass);
    const iconNameRaw = getCell(idxIconName);
    const defaultImpactRaw = getCell(idxDefaultImpact);
    const leaveTitle = getCell(idxLeaveTitle);
    const startMonthStr = getCell(idxStartMonth);
    const endMonthStr = getCell(idxEndMonth);
    const impactStr = getCell(idxImpact) || defaultImpactRaw;
    const leaveNote = getCell(idxLeaveNote) || (effectiveTable === 'leaves' ? rowNotes : '');

    const monthValues = monthIndices.map((colIdx) =>
      colIdx >= 0 ? parsePercentValue(getCell(colIdx), 0) : 0
    );
    const hasMonthColumns = monthIndices.some((colIdx) => colIdx >= 0);

    // 1. planning_years row
    if (effectiveTable === 'planning_years') {
      if (!isNaN(rowYearNum) && rowYearNum >= 2000 && rowYearNum <= 2100) {
        if (!nextAvailableYears.includes(rowYearNum)) {
          nextAvailableYears.push(rowYearNum);
          updatedYearsCount++;
        }
        if (parseBoolFlag(isSelectedRaw, false)) {
          nextSelectedYear = rowYearNum;
        }
      }
      continue;
    }

    // 2. departments row
    if (effectiveTable === 'departments' || effectiveTable === 'department') {
      if (dept) {
        const order = parseInt(getCell(idxSortOrder), 10);
        if (!isNaN(order) && !nextDepartments.some((d) => d.toLowerCase() === dept.toLowerCase())) {
          nextDepartments.splice(Math.max(0, Math.min(nextDepartments.length, order)), 0, dept);
          updatedDeptsCount++;
        } else {
          ensureDepartment(dept);
        }
      }
      continue;
    }

    // 3. leave_types row
    if (
      effectiveTable === 'leave_types' ||
      effectiveTable === 'leave type' ||
      effectiveTable === 'leavetype'
    ) {
      const parsedImpact = impactStr ? parsePercentValue(impactStr, 50) : 50;
      resolveOrRegisterLeaveType(
        leaveTypeRaw || rowId || leaveTypeLabel || leaveTitle,
        leaveTypeLabel || leaveTitle,
        badgeThemeRaw,
        parsedImpact,
        iconNameRaw || undefined
      );
      continue;
    }

    // 4. standalone clients row
    if (effectiveTable === 'clients' || effectiveTable === 'client') {
      if (clientName || clientIdVal) {
        ensureClient({
          id: clientIdVal || undefined,
          name: clientName || clientIdVal,
          industry,
          color: entityColor || undefined,
          status: clientStatusRaw || projectStatus
        });
      }
      continue;
    }

    // 5. standalone projects row
    if (effectiveTable === 'projects' || effectiveTable === 'project') {
      if (projectName || projectIdVal || projectCode) {
        const clientById = clientIdVal
          ? nextClients.find((c) => c.id === clientIdVal)
          : undefined;
        const clientObj =
          clientById ||
          ensureClient({
            id: clientIdVal || undefined,
            name: clientName || 'Internal',
            industry,
            status: clientStatusRaw
          });
        ensureProject({
          id: projectIdVal || undefined,
          name: projectName || projectCode || projectIdVal,
          code: projectCode || undefined,
          clientId: clientObj.id,
          status: projectStatus,
          color: entityColor || undefined,
          billableStr,
          notes: projectComment
        });
      }
      continue;
    }

    // 6. standalone people row
    if (effectiveTable === 'people' || effectiveTable === 'person') {
      ensurePerson({
        id: personIdVal || undefined,
        firstName: firstNameVal,
        lastName: lastNameVal,
        fullName: legacyFullNameVal,
        role,
        dept,
        employmentRaw,
        email,
        maxCap,
        avatarColor: avatarColor || entityColor || undefined,
        initials: initials || undefined,
        notes: personComment
      });
      continue;
    }

    // Composite / Matrix row handling (allocations, leaves, person_summary, project_summary, bench_availability, effective_capacity)
    const hasPersonIdentity = Boolean(
      personIdVal || firstNameVal || lastNameVal || legacyFullNameVal
    );
    let personObj: Person | null = null;
    if (hasPersonIdentity) {
      const existingById = personIdVal
        ? nextPeople.find((p) => p.id === personIdVal)
        : undefined;
      personObj =
        existingById && effectiveTable === 'allocations' && !firstNameVal && !legacyFullNameVal
          ? existingById
          : ensurePerson({
              id: personIdVal || undefined,
              firstName: firstNameVal,
              lastName: lastNameVal,
              fullName: legacyFullNameVal,
              role,
              dept,
              employmentRaw,
              email,
              maxCap,
              avatarColor: avatarColor || undefined,
              initials: initials || undefined,
              notes: personComment
            });
    }

    let projectObj: Project | null = null;
    if (projectIdVal || projectName || projectCode) {
      const existingProjById = projectIdVal
        ? nextProjects.find((p) => p.id === projectIdVal)
        : undefined;
      if (existingProjById && effectiveTable === 'allocations' && !projectName) {
        projectObj = existingProjById;
      } else {
        const existingClient = clientIdVal
          ? nextClients.find((c) => c.id === clientIdVal)
          : undefined;
        const clientObj =
          existingClient ||
          ensureClient({
            id: clientIdVal || undefined,
            name: clientName || 'Internal',
            industry,
            status: clientStatusRaw
          });
        projectObj = ensureProject({
          id: projectIdVal || undefined,
          name: projectName || projectCode || projectIdVal,
          code: projectCode || undefined,
          clientId: clientObj.id,
          status: projectStatus,
          billableStr,
          notes: projectComment
        });
      }
    }

    // Leave row
    const isLeaveRow =
      effectiveTable === 'leaves' ||
      effectiveTable === 'leave' ||
      effectiveTable === 'leave entry' ||
      (personObj &&
        !projectObj &&
        (Boolean(leaveTypeRaw) ||
          (leaveTitle && !leaveTitle.includes('scheduled leave(s)'))));

    if (isLeaveRow && personObj) {
      const parsedImpact = impactStr ? parsePercentValue(impactStr, 50) : undefined;
      const validType: LeaveType = resolveOrRegisterLeaveType(
        leaveTypeRaw,
        leaveTypeLabel,
        badgeThemeRaw,
        parsedImpact,
        iconNameRaw || undefined
      );
      const typeMeta = getLeaveTypeMeta(validType, nextLeaveTypes);

      let startM = parseMonthToken(startMonthStr, isZeroBasedMonthColumn);
      let endM = parseMonthToken(endMonthStr, isZeroBasedMonthColumn);

      if (startM === null || endM === null) {
        const activeMonths = monthIndices
          .map((colIdx, mIdx) => {
            if (colIdx < 0) return -1;
            const raw = getCell(colIdx);
            return parsePercentValue(raw, 0) > 0 ? mIdx : -1;
          })
          .filter((mIdx) => mIdx >= 0);

        if (activeMonths.length > 0) {
          startM = Math.min(...activeMonths);
          endM = Math.max(...activeMonths);
        } else {
          startM = startM ?? 0;
          endM = endM ?? startM;
        }
      }

      const normStart = Math.max(0, Math.min(11, Math.min(startM, endM)));
      const normEnd = Math.max(normStart, Math.min(11, Math.max(startM, endM)));
      const impact = impactStr
        ? parsePercentValue(impactStr, typeMeta.defaultImpact)
        : typeMeta.defaultImpact;
      const title = leaveTitle || typeMeta.label;
      const incomingLeaveId = effectiveTable === 'leaves' ? rowId : '';

      const existingLeaveIdx = nextLeaves.findIndex(
        (l) =>
          (incomingLeaveId && l.id === incomingLeaveId) ||
          (l.personId === personObj!.id &&
            l.year === year &&
            l.startMonth === normStart &&
            l.endMonth === normEnd &&
            l.type === validType)
      );

      if (existingLeaveIdx >= 0) {
        nextLeaves[existingLeaveIdx] = {
          ...nextLeaves[existingLeaveIdx],
          type: validType,
          title,
          startMonth: normStart,
          endMonth: normEnd,
          impactPercent: impact,
          notes: leaveNote || nextLeaves[existingLeaveIdx].notes
        };
      } else {
        nextLeaves.push({
          id: incomingLeaveId || `leave-${Date.now()}-${nextLeaves.length + 1}`,
          personId: personObj.id,
          type: validType,
          title,
          year,
          startMonth: normStart,
          endMonth: normEnd,
          impactPercent: impact,
          notes: leaveNote || undefined
        });
      }
      updatedLeavesCount++;
      continue;
    }

    // Allocation row
    const isSummaryOnlyRow =
      effectiveTable === 'person_summary' ||
      effectiveTable === 'person summary' ||
      effectiveTable === 'project_summary' ||
      effectiveTable === 'project summary' ||
      effectiveTable === 'effective_capacity' ||
      effectiveTable === 'effective capacity' ||
      effectiveTable === 'bench_availability' ||
      effectiveTable === 'bench availability';

    if (personObj && projectObj && !isSummaryOnlyRow && hasMonthColumns) {
      const incomingAllocId = effectiveTable === 'allocations' ? rowId : '';
      const existingAllocIdx = nextAllocations.findIndex(
        (a) =>
          (incomingAllocId && a.id === incomingAllocId) ||
          (a.personId === personObj!.id &&
            a.projectId === projectObj!.id &&
            a.year === year)
      );

      const baseStatuses =
        existingAllocIdx >= 0
          ? normalizeAllocationStatuses(nextAllocations[existingAllocIdx].monthlyStatus, 'unknown')
          : normalizeAllocationStatuses(undefined, 'unknown');
      const monthStatusValues: AllocationStatus[] = hasStatusColumns
        ? statusIndices.map((colIdx, mIdx) => {
            if (colIdx < 0) return baseStatuses[mIdx];
            const raw = getCell(colIdx);
            return raw ? normalizeAllocationStatus(raw, baseStatuses[mIdx]) : baseStatuses[mIdx];
          })
        : baseStatuses;

      if (existingAllocIdx >= 0) {
        nextAllocations[existingAllocIdx] = {
          ...nextAllocations[existingAllocIdx],
          monthlyPercentage: monthValues,
          monthlyStatus: monthStatusValues,
          notes: allocComment || nextAllocations[existingAllocIdx].notes
        };
      } else {
        nextAllocations.push({
          id: incomingAllocId || `a-${Date.now()}-${nextAllocations.length + 1}`,
          personId: personObj.id,
          projectId: projectObj.id,
          year,
          monthlyPercentage: monthValues,
          monthlyStatus: monthStatusValues,
          notes: allocComment || undefined
        });
      }
      updatedAllocationsCount++;
    }
  }

  if (Object.keys(nextLeaveTypes).length === 0) {
    Object.assign(nextLeaveTypes, currentLeaveTypes);
  }
  syncLeaveTypeConfigRegistry(nextLeaveTypes);

  const rawNextState: AppState = {
    people: nextPeople,
    clients: nextClients,
    projects: nextProjects,
    allocations: nextAllocations,
    leaves: nextLeaves,
    availableYears:
      nextAvailableYears.length > 0 ? nextAvailableYears : currentState.availableYears,
    selectedYear: nextSelectedYear,
    departments: nextDepartments,
    leaveTypes: nextLeaveTypes
  };

  const nextState = enforceReferentialIntegrity(rawNextState);

  const summaryParts: string[] = [];
  if (updatedPeopleCount > 0) summaryParts.push(`${updatedPeopleCount} people`);
  if (updatedClientsCount > 0) summaryParts.push(`${updatedClientsCount} clients`);
  if (updatedProjectsCount > 0) summaryParts.push(`${updatedProjectsCount} projects`);
  if (updatedAllocationsCount > 0) summaryParts.push(`${updatedAllocationsCount} allocations`);
  if (updatedLeavesCount > 0) summaryParts.push(`${updatedLeavesCount} leaves`);
  if (updatedLeaveTypesCount > 0) summaryParts.push(`${updatedLeaveTypesCount} leave types`);
  if (updatedDeptsCount > 0) summaryParts.push(`${updatedDeptsCount} departments`);
  if (updatedYearsCount > 0) summaryParts.push(`${updatedYearsCount} planning years`);

  return {
    nextState,
    summaryMessage:
      summaryParts.length > 0
        ? `Imported SQLite-aligned CSV (${summaryParts.join(', ')}).`
        : 'CSV processed successfully.'
  };
}
