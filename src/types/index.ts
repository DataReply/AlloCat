export type Department = string;

export type EmploymentType = 'Internal' | 'External' | 'B2B';

export const EMPLOYMENT_TYPES: EmploymentType[] = ['Internal', 'External', 'B2B'];

export const EMPLOYMENT_BADGE_CONFIG: Record<
  EmploymentType,
  { label: string; badgeClass: string }
> = {
  Internal: {
    label: 'Internal',
    badgeClass:
      'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/70 dark:text-blue-300 dark:border-blue-800/80'
  },
  External: {
    label: 'External',
    badgeClass:
      'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/70 dark:text-amber-300 dark:border-amber-800/80'
  },
  B2B: {
    label: 'B2B',
    badgeClass:
      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-800/80'
  }
};

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  department: Department;
  employmentType?: EmploymentType; // 'Internal' | 'External' | 'B2B' (defaults to 'Internal')
  email: string;
  maxCapacityPercent: number; // default 100
  avatarColor: string;
  initials: string;
  isActive?: boolean; // Defaults to true for existing/imported records
  isPlaceholder?: boolean; // Reserved planning placeholder with unrestricted allocation capacity
  notes?: string; // Additional comments / staffing notes
}

export type ClientStatus = 'active' | 'lead' | 'completed';

export interface Client {
  id: string;
  name: string;
  industry: string;
  color: string;
  status: ClientStatus;
}

export type ProjectStatus = 'active' | 'planned' | 'completed';

export interface Project {
  id: string;
  clientId: string;
  name: string;
  code: string;
  status: ProjectStatus;
  color: string;
  billable: boolean;
  notes?: string; // Comments / deliverable scope notes
}

export type AllocationStatus = 'unknown' | 'planned' | 'confirmed';

export const ALLOCATION_STATUSES: AllocationStatus[] = [
  'unknown',
  'planned',
  'confirmed'
];

export const ALLOCATION_STATUS_CONFIG: Record<
  AllocationStatus,
  {
    label: string;
    shortLabel: string;
    cellBg: string;
    cellText: string;
    badgeClass: string;
    dotClass: string;
    buttonActiveClass: string;
  }
> = {
  unknown: {
    label: 'Unknown',
    shortLabel: 'Unk',
    cellBg: 'bg-slate-200/90 dark:bg-[#3b4048]',
    cellText: 'text-slate-800 dark:text-slate-100',
    badgeClass:
      'bg-slate-200 text-slate-700 border-slate-300 dark:bg-[#3b4048] dark:text-slate-100 dark:border-slate-500/70',
    dotClass: 'bg-slate-500 dark:bg-slate-300',
    buttonActiveClass:
      'bg-slate-600 text-white border-slate-600 dark:bg-slate-500 dark:border-slate-400 font-bold'
  },
  planned: {
    label: 'Planned',
    shortLabel: 'Plan',
    cellBg: 'bg-yellow-100/95 dark:bg-[#594d17]',
    cellText: 'text-yellow-950 dark:text-yellow-100',
    badgeClass:
      'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-[#594d17] dark:text-yellow-100 dark:border-yellow-500/60',
    dotClass: 'bg-yellow-500 dark:bg-yellow-400',
    buttonActiveClass:
      'bg-yellow-400 text-slate-950 border-yellow-500 font-bold'
  },
  confirmed: {
    label: 'Confirmed',
    shortLabel: 'Conf',
    cellBg: 'bg-green-100/95 dark:bg-[#1b5236]',
    cellText: 'text-green-950 dark:text-green-100',
    badgeClass:
      'bg-green-100 text-green-900 border-green-300 dark:bg-[#1b5236] dark:text-green-100 dark:border-emerald-500/60',
    dotClass: 'bg-green-600 dark:bg-emerald-400',
    buttonActiveClass:
      'bg-emerald-600 text-white border-emerald-600 dark:bg-emerald-600 dark:border-emerald-400 font-bold'
  }
};

export function normalizeAllocationStatus(
  raw: unknown,
  fallback: AllocationStatus = 'unknown'
): AllocationStatus {
  if (typeof raw !== 'string') return fallback;
  const val = raw.trim().toLowerCase();
  if (val === 'confirmed' || val === 'conf' || val === 'approved') return 'confirmed';
  if (val === 'planned' || val === 'plan' || val === 'tentative') return 'planned';
  if (val === 'unknown' || val === 'unk' || val === 'tbd') return 'unknown';
  return fallback;
}

export function normalizeAllocationStatuses(
  raw?: unknown[],
  fallback: AllocationStatus = 'unknown'
): AllocationStatus[] {
  return Array.from({ length: 12 }, (_, idx) =>
    normalizeAllocationStatus(Array.isArray(raw) ? raw[idx] : undefined, fallback)
  );
}

export function getNextAllocationStatus(current: AllocationStatus): AllocationStatus {
  if (current === 'unknown') return 'planned';
  if (current === 'planned') return 'confirmed';
  return 'unknown';
}

export interface Allocation {
  id: string;
  personId: string;
  projectId: string;
  year: number;
  monthlyPercentage: number[]; // 12 numbers (0..100+) representing Jan through Dec
  monthlyStatus?: AllocationStatus[]; // 12 statuses ('unknown' | 'planned' | 'confirmed') for Jan through Dec
  notes?: string; // Comments / role detail on this specific assignment
}

export type LeaveType = string;

export interface LeaveTypeMeta {
  label: string;
  badgeClass: string;
  iconName: string;
  defaultImpact: number;
}

export interface LeaveEntry {
  id: string;
  personId: string;
  type: LeaveType;
  title: string;
  year: number;
  startMonth: number; // 0..11
  endMonth: number;   // 0..11
  impactPercent: number; // % reduction in availability during these months (e.g. 100 for full month off, 50 for 2 weeks, 25 for 1 week)
  notes?: string;
}

export type ViewMode = 'people' | 'clients' | 'availability' | 'bench';

export type UtilizationFilter = 'all' | 'overbooked' | 'balanced' | 'underbooked';

export type PeopleSortOrder =
  | 'default'
  | 'firstName-asc'
  | 'firstName-desc'
  | 'lastName-asc'
  | 'lastName-desc';

export type ClientSortOrder =
  | 'default'
  | 'client-asc'
  | 'client-desc'
  | 'project-asc'
  | 'project-desc';

export interface FilterState {
  search: string;
  department: Department | 'all';
  employmentFilter?: EmploymentType | 'all';
  utilization: UtilizationFilter;
  clientFilter: string | 'all';
  peopleSort?: PeopleSortOrder;
  clientSort?: ClientSortOrder;
  visibleMonths?: boolean[];
}

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
] as const;

export const MONTH_FULL_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
] as const;

export const LEAVE_BADGE_THEMES: Record<string, { name: string; badgeClass: string; dotColor: string }> = {
  blue: {
    name: 'Blue',
    badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-950/80 dark:text-blue-300 border-blue-300 dark:border-blue-800',
    dotColor: '#2563EB'
  },
  purple: {
    name: 'Purple',
    badgeClass: 'bg-purple-100 text-purple-800 dark:bg-purple-950/80 dark:text-purple-300 border-purple-300 dark:border-purple-800',
    dotColor: '#7C3AED'
  },
  indigo: {
    name: 'Indigo',
    badgeClass: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/80 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800',
    dotColor: '#4F46E5'
  },
  teal: {
    name: 'Teal',
    badgeClass: 'bg-teal-100 text-teal-800 dark:bg-teal-950/80 dark:text-teal-300 border-teal-300 dark:border-teal-800',
    dotColor: '#0D9488'
  },
  emerald: {
    name: 'Emerald',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    dotColor: '#059669'
  },
  amber: {
    name: 'Amber',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border-amber-300 dark:border-amber-800',
    dotColor: '#D97706'
  },
  rose: {
    name: 'Rose',
    badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border-rose-300 dark:border-rose-800',
    dotColor: '#E11D48'
  },
  slate: {
    name: 'Slate',
    badgeClass: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border-slate-300 dark:border-slate-700',
    dotColor: '#64748B'
  }
};

export const DEFAULT_LEAVE_TYPE_CONFIG: Record<LeaveType, LeaveTypeMeta> = {
  sick: {
    label: 'Sick Leave',
    badgeClass: LEAVE_BADGE_THEMES.amber.badgeClass,
    iconName: 'Activity',
    defaultImpact: 50
  },
  maternity: {
    label: 'Maternity Leave',
    badgeClass: LEAVE_BADGE_THEMES.purple.badgeClass,
    iconName: 'Baby',
    defaultImpact: 100
  },
  paternity: {
    label: 'Paternity Leave',
    badgeClass: LEAVE_BADGE_THEMES.indigo.badgeClass,
    iconName: 'HeartHandshake',
    defaultImpact: 100
  },
  vacation: {
    label: 'Annual Vacation / PTO',
    badgeClass: LEAVE_BADGE_THEMES.blue.badgeClass,
    iconName: 'Palmtree',
    defaultImpact: 50
  },
  sabbatical: {
    label: 'Sabbatical',
    badgeClass: LEAVE_BADGE_THEMES.teal.badgeClass,
    iconName: 'BookOpen',
    defaultImpact: 100
  },
  unpaid: {
    label: 'Unpaid Leave',
    badgeClass: LEAVE_BADGE_THEMES.slate.badgeClass,
    iconName: 'Clock',
    defaultImpact: 100
  },
  other: {
    label: 'Special Leave / Other',
    badgeClass: LEAVE_BADGE_THEMES.rose.badgeClass,
    iconName: 'CalendarOff',
    defaultImpact: 50
  }
};

export const LEAVE_TYPE_CONFIG: Record<LeaveType, LeaveTypeMeta> = {
  ...DEFAULT_LEAVE_TYPE_CONFIG
};

export function syncLeaveTypeConfigRegistry(customConfig?: Record<LeaveType, LeaveTypeMeta>): void {
  if (!customConfig || Object.keys(customConfig).length === 0) return;
  for (const key of Object.keys(LEAVE_TYPE_CONFIG)) {
    delete LEAVE_TYPE_CONFIG[key];
  }
  for (const [key, val] of Object.entries(customConfig)) {
    LEAVE_TYPE_CONFIG[key] = val;
  }
}

export function getLeaveTypeMeta(
  type: LeaveType,
  customConfig?: Record<LeaveType, LeaveTypeMeta>
): LeaveTypeMeta {
  const source = customConfig || LEAVE_TYPE_CONFIG;
  if (source[type]) return source[type];
  if (DEFAULT_LEAVE_TYPE_CONFIG[type]) return DEFAULT_LEAVE_TYPE_CONFIG[type];
  return {
    label: type.charAt(0).toUpperCase() + type.slice(1).replace(/[-_]/g, ' '),
    badgeClass: LEAVE_BADGE_THEMES.slate.badgeClass,
    iconName: 'CalendarOff',
    defaultImpact: 50
  };
}

