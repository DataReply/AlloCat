import { useState, useMemo, useEffect, useRef } from 'react';
import {
  ViewMode,
  FilterState,
  Person,
  Client,
  Project,
  AllocationStatus,
  LeaveEntry,
  LeaveType,
  LeaveTypeMeta,
  DEFAULT_LEAVE_TYPE_CONFIG,
  Department,
  EmploymentType,
  normalizeAllocationStatuses,
  getLeaveTypeMeta,
  syncLeaveTypeConfigRegistry
} from './types';
import {
  AppState,
  getDefaultAppState
} from './data/seedData';
import {
  calculateExecutiveKPIs,
  getPersonCapacitySummary
} from './utils/allocationMath';
import { Header } from './components/Header';
import { Toolbar } from './components/Toolbar';
import { PeopleMatrixView } from './components/PeopleMatrixView';
import { ClientProjectMatrixView } from './components/ClientProjectMatrixView';
import { AvailabilityMatrixView } from './components/AvailabilityMatrixView';
import { BenchMatrixView } from './components/BenchMatrixView';
import { CellAllocationPopover } from './components/CellAllocationPopover';
import { BatchAssignModal } from './components/BatchAssignModal';
import { AddPersonModal } from './components/AddPersonModal';
import { AddClientProjectModal } from './components/AddClientProjectModal';
import { AddLeaveModal } from './components/AddLeaveModal';
import { OvertimeAlertsDrawer } from './components/OvertimeAlertsDrawer';
import { ManageYearsModal } from './components/ManageYearsModal';
import { ManageDepartmentsModal } from './components/ManageDepartmentsModal';
import { ConfirmDeletePersonModal } from './components/ConfirmDeletePersonModal';
import { ExportImportModal } from './components/ExportImportModal';
import {
  AdminPanelModal,
  AdminTab,
  ClearableDataArea
} from './components/AdminPanelModal';
import { ReportingModal, ReportTab } from './components/ReportingModal';
import { StandaloneAppModal } from './components/StandaloneAppModal';
import { useOnlineStatus } from './utils/usePWAInstall';
import {
  isSupabaseConfigured,
  restoreLocalAuth,
  signOutUser,
  subscribeToLocalAuthChange,
  subscribeToSupabaseConfigChange,
  type AuthUser
} from './supabase';
import { LoginOverlay } from './components/LoginOverlay';
import { ExportScope } from './utils/importExportUtils';
import {
  initSQLiteWorkspace,
  syncAppStateToSQLite,
  exportSQLiteBinaryFile
} from './utils/sqliteDatabase';
import { triggerBinaryDownload } from './utils/importExportUtils';
import {
  AdminCollabState,
  WorkspaceMember,
  approveJoinRequest,
  checkOrJoinWorkspace,
  deleteWorkspaceEmailInvite,
  rejectJoinRequest,
  removeCollaborator,
  rotateWorkspaceJoinCode,
  subscribeToAdminCollabState,
  subscribeToWorkspaceData,
  syncWorkspaceDeltaToSupabase,
  updateCollaboratorRole
} from './utils/supabaseSync';

function formatCloudError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Unknown cloud error');
  try {
    const parsed = JSON.parse(raw) as { error?: string; path?: string; operationType?: string };
    if (parsed && typeof parsed === 'object' && parsed.error) {
      const target = parsed.path ? ` (${parsed.operationType || 'access'} ${parsed.path})` : '';
      return `${parsed.error}${target}`;
    }
  } catch {
    // Plain string error
  }
  return raw;
}

export function App() {
  const isOnline = useOnlineStatus();
  const [appState, setAppState] = useState<AppState>(() => getDefaultAppState());
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [accessStatus, setAccessStatus] = useState<'checking' | 'granted'>('checking');
  const [currentMember, setCurrentMember] = useState<WorkspaceMember | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [adminCollabState, setAdminCollabState] = useState<AdminCollabState | null>(null);
  const [isWorkspaceHydrated, setIsWorkspaceHydrated] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'error'>('synced');
  const [workspaceSyncError, setWorkspaceSyncError] = useState<string | null>(null);
  const [accessCheckNonce, setAccessCheckNonce] = useState(0);

  const isCloudReadyRef = useRef(false);
  const remoteHydratedStatesRef = useRef(new WeakSet<AppState>());
  const lastCloudStateRef = useRef<AppState>(appState);
  const pendingWritesCountRef = useRef(0);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const selectedYearRef = useRef<number>(appState.selectedYear);
  const isSqliteMirrorReadyRef = useRef(false);

  const [viewMode, setViewMode] = useState<ViewMode>('clients');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);

  const [filters, setFilters] = useState<FilterState>({
    search: '',
    department: 'all',
    employmentFilter: 'all',
    utilization: 'all',
    clientFilter: 'all',
    peopleSort: 'lastName-asc',
    clientSort: 'client-asc',
    visibleMonths: Array(12).fill(true)
  });

  const handleToggleMonthVisibility = (monthIdx: number) => {
    setFilters((prev) => {
      const current =
        prev.visibleMonths && prev.visibleMonths.length === 12
          ? [...prev.visibleMonths]
          : Array(12).fill(true);
      current[monthIdx] = !current[monthIdx];
      return { ...prev, visibleMonths: current };
    });
  };

  const [expandedPersonIds, setExpandedPersonIds] = useState<Set<string>>(
    () => new Set<string>()
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(appState.projects.map((p) => p.id))
  );

  // Active cell editor popover state
  const [activeCellEditor, setActiveCellEditor] = useState<{
    personId: string;
    projectId: string;
    monthIndex: number;
  } | null>(null);

  // Modal states
  const [assignModalState, setAssignModalState] = useState<{
    isOpen: boolean;
    personId?: string;
    projectId?: string;
    monthIndex?: number;
  }>({ isOpen: false });
  const [isAddPersonOpen, setIsAddPersonOpen] = useState(false);
  const [personToEdit, setPersonToEdit] = useState<Person | null>(null);
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [projectToEdit, setProjectToEdit] = useState<Project | null>(null);
  const [clientToEdit, setClientToEdit] = useState<Client | null>(null);
  const [leaveModalState, setLeaveModalState] = useState<{
    isOpen: boolean;
    personId?: string;
    monthIndex?: number;
  }>({ isOpen: false });
  const [isOvertimeDrawerOpen, setIsOvertimeDrawerOpen] = useState(false);
  const [isManageYearsOpen, setIsManageYearsOpen] = useState(false);
  const [isManageDepartmentsOpen, setIsManageDepartmentsOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportModalScope, setExportModalScope] = useState<ExportScope>('all');
  const [personToDelete, setPersonToDelete] = useState<Person | null>(null);
  const [adminPanelState, setAdminPanelState] = useState<{
    isOpen: boolean;
    tab: AdminTab;
  }>({ isOpen: false, tab: 'people' });
  const [reportingModalState, setReportingModalState] = useState<{
    isOpen: boolean;
    tab: ReportTab;
  }>({ isOpen: false, tab: 'departments' });
  const [isStandaloneModalOpen, setIsStandaloneModalOpen] = useState(false);

  useEffect(() => {
    selectedYearRef.current = appState.selectedYear;
  }, [appState.selectedYear]);

  // Boot local SQLite engine in background solely as an export/SQL console mirror
  useEffect(() => {
    let cancelled = false;
    initSQLiteWorkspace().then(() => {
      if (!cancelled) {
        isSqliteMirrorReadyRef.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Local credentials control the app; Supabase anonymous auth supplies a database identity.
  useEffect(() => {
    let cancelled = false;
    const refreshLocalUser = async () => {
      try {
        const user = await restoreLocalAuth();
        if (cancelled) return;
        setCurrentUser(user);
        setAuthReady(true);
        if (!user) {
          isCloudReadyRef.current = false;
          pendingWritesCountRef.current = 0;
          syncQueueRef.current = Promise.resolve();
          setIsWorkspaceHydrated(false);
          setAccessStatus('checking');
          setCurrentMember(null);
          setWorkspaceMembers([]);
          setAdminCollabState(null);
          setWorkspaceSyncError(null);
          setSyncStatus('synced');
        }
      } catch (error) {
        if (cancelled) return;
        setCurrentUser(null);
        setAuthReady(true);
        setWorkspaceSyncError(formatCloudError(error));
        setSyncStatus('error');
      }
    };
    void refreshLocalUser();
    const unsubscribeAuth = subscribeToLocalAuthChange(() => void refreshLocalUser());
    const unsubscribeConfig = subscribeToSupabaseConfigChange(() => void refreshLocalUser());
    return () => {
      cancelled = true;
      unsubscribeAuth();
      unsubscribeConfig();
    };
  }, []);

  // Initialize the public cloud workspace after local app login.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    setAccessStatus('checking');
    setWorkspaceSyncError(null);

    if (!isSupabaseConfigured()) {
      setCurrentMember({
        uid: currentUser.uid,
        displayName: currentUser.displayName || 'admin',
        photoURL: '',
        role: 'admin',
        joinedVia: 'bootstrap'
      });
      setAccessStatus('granted');
      setIsWorkspaceHydrated(true);
      setSyncStatus('error');
      setWorkspaceSyncError('Supabase is not configured. Add the project URL and anon key in Admin Panel.');
      return () => {
        cancelled = true;
      };
    }

    checkOrJoinWorkspace(currentUser)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 'granted') {
          setCurrentMember(res.member);
          setAccessStatus('granted');
        } else {
          throw new Error('Supabase did not grant workspace access. Check the anonymous access setup.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setCurrentMember({
          uid: currentUser.uid,
          displayName: currentUser.displayName || 'admin',
          photoURL: '',
          role: 'admin',
          joinedVia: 'bootstrap'
        });
        setAccessStatus('granted');
        setIsWorkspaceHydrated(true);
        setSyncStatus('error');
        setWorkspaceSyncError(formatCloudError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser, accessCheckNonce]);

  // Subscribe to the real-time collaborative Supabase workspace once access is granted.
  useEffect(() => {
    if (!currentUser || accessStatus !== 'granted' || !isSupabaseConfigured()) return;

    let firstHydration = true;
    setWorkspaceSyncError(null);
    const unsub = subscribeToWorkspaceData({
      onStateHydrated: (cloudState) => {
        if (pendingWritesCountRef.current > 0) {
          return;
        }
        lastCloudStateRef.current = cloudState;
        const preferredYear = selectedYearRef.current;
        const mergedSelectedYear = cloudState.availableYears.includes(preferredYear)
          ? preferredYear
          : cloudState.selectedYear;
        const nextHydrated: AppState = {
          ...cloudState,
          selectedYear: mergedSelectedYear
        };
        remoteHydratedStatesRef.current.add(nextHydrated);
        setAppState(nextHydrated);
        setWorkspaceSyncError(null);
        setSyncStatus('synced');
        if (firstHydration) {
          firstHydration = false;
          setExpandedProjectIds(new Set(nextHydrated.projects.map((p) => p.id)));
          isCloudReadyRef.current = true;
          setIsWorkspaceHydrated(true);
        }
        if (isSqliteMirrorReadyRef.current) {
          syncAppStateToSQLite(nextHydrated);
        }
      },
      onMembersUpdate: (members) => {
        setWorkspaceMembers(members);
        const me = members.find((m) => m.uid === currentUser.uid);
        if (me) {
          setCurrentMember((prev) =>
            prev ? { ...prev, role: me.role, displayName: me.displayName } : me
          );
        }
      },
      onSyncError: (err) => {
        setSyncStatus('error');
        setWorkspaceSyncError(formatCloudError(err));
      }
    });

    return () => {
      unsub();
      isCloudReadyRef.current = false;
    };
  }, [currentUser, accessStatus, accessCheckNonce]);

  // Subscribe to admin collaboration metadata when user is an admin
  useEffect(() => {
    if (
      !currentUser ||
      accessStatus !== 'granted' ||
      currentUser.role !== 'admin' ||
      !isSupabaseConfigured()
    ) {
      setAdminCollabState(null);
      return;
    }
    return subscribeToAdminCollabState(
      (collab) => {
        setAdminCollabState(collab);
      },
      (err) => {
        console.warn('Admin collaboration listener error:', err);
      }
    );
  }, [currentUser, accessStatus]);

  // Push local workspace mutations to Supabase via queued delta sync.
  useEffect(() => {
    if (
      !isCloudReadyRef.current ||
      !currentUser ||
      currentUser.role === 'viewer' ||
      accessStatus !== 'granted'
    ) return;
    if (remoteHydratedStatesRef.current.has(appState)) {
      return;
    }

    const nextSnapshot = appState;
    pendingWritesCountRef.current += 1;
    setSyncStatus('syncing');

    syncQueueRef.current = syncQueueRef.current
      .then(async () => {
        const prevSnapshot = lastCloudStateRef.current;
        const syncedState = await syncWorkspaceDeltaToSupabase(
          prevSnapshot,
          nextSnapshot,
          currentUser
        );
        lastCloudStateRef.current = syncedState;
        setWorkspaceSyncError(null);
        if (isSqliteMirrorReadyRef.current) {
          syncAppStateToSQLite(syncedState);
        }
      })
      .catch((err) => {
        console.error('Supabase delta sync failed:', err);
        setSyncStatus('error');
        setWorkspaceSyncError(formatCloudError(err));
      })
      .finally(() => {
        pendingWritesCountRef.current = Math.max(0, pendingWritesCountRef.current - 1);
        if (pendingWritesCountRef.current === 0) {
          setSyncStatus((prev) => (prev === 'error' ? 'error' : 'synced'));
        }
      });
  }, [appState, currentUser, accessStatus]);

  // Toggle dark mode class on root html element
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

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
  } = appState;

  const kpis = useMemo(
    () => calculateExecutiveKPIs(people, projects, allocations, leaves, selectedYear),
    [people, projects, allocations, leaves, selectedYear]
  );

  // Filtered & sorted people
  const filteredPeople = useMemo(() => {
    const matched = people.filter((person) => {
      if (filters.department !== 'all' && person.department !== filters.department) {
        return false;
      }

      if (
        filters.employmentFilter &&
        filters.employmentFilter !== 'all' &&
        (person.employmentType || 'Internal') !== filters.employmentFilter
      ) {
        return false;
      }

      if (filters.search.trim() !== '') {
        const q = filters.search.toLowerCase();
        const personAllocs = allocations.filter(
          (a) => a.personId === person.id && a.year === selectedYear
        );
        const matchesProject = personAllocs.some((a) => {
          const proj = projects.find((p) => p.id === a.projectId);
          const client = proj ? clients.find((c) => c.id === proj.clientId) : undefined;
          return (
            proj?.name.toLowerCase().includes(q) ||
            proj?.code.toLowerCase().includes(q) ||
            client?.name.toLowerCase().includes(q)
          );
        });

        const matchesPerson =
          person.name.toLowerCase().includes(q) ||
          (person.firstName && person.firstName.toLowerCase().includes(q)) ||
          (person.lastName && person.lastName.toLowerCase().includes(q)) ||
          person.role.toLowerCase().includes(q) ||
          person.department.toLowerCase().includes(q) ||
          (person.employmentType || 'Internal').toLowerCase().includes(q) ||
          (person.notes && person.notes.toLowerCase().includes(q));

        if (!matchesPerson && !matchesProject) return false;
      }

      if (filters.utilization !== 'all') {
        const summary = getPersonCapacitySummary(
          person.id,
          selectedYear,
          allocations,
          person.maxCapacityPercent,
          leaves
        );
        if (filters.utilization === 'overbooked' && !summary.hasOvertime) return false;
        if (
          filters.utilization === 'balanced' &&
          (summary.hasOvertime || summary.annualAverage < 75)
        ) {
          return false;
        }
        if (filters.utilization === 'underbooked' && summary.annualAverage >= 75) {
          return false;
        }
      }

      return true;
    });

    const sortMode = filters.peopleSort || 'lastName-asc';
    if (sortMode === 'default') return matched;

    return [...matched].sort((a, b) => {
      const aFirst = (a.firstName || a.name.split(' ')[0] || a.name).trim();
      const bFirst = (b.firstName || b.name.split(' ')[0] || b.name).trim();
      const aLast = (a.lastName || a.name.split(' ').slice(1).join(' ') || a.name).trim();
      const bLast = (b.lastName || b.name.split(' ').slice(1).join(' ') || b.name).trim();

      if (sortMode === 'firstName-asc') {
        return aFirst.localeCompare(bFirst, undefined, { sensitivity: 'base' }) ||
          aLast.localeCompare(bLast, undefined, { sensitivity: 'base' });
      }
      if (sortMode === 'firstName-desc') {
        return bFirst.localeCompare(aFirst, undefined, { sensitivity: 'base' }) ||
          bLast.localeCompare(aLast, undefined, { sensitivity: 'base' });
      }
      if (sortMode === 'lastName-asc') {
        return aLast.localeCompare(bLast, undefined, { sensitivity: 'base' }) ||
          aFirst.localeCompare(bFirst, undefined, { sensitivity: 'base' });
      }
      if (sortMode === 'lastName-desc') {
        return bLast.localeCompare(aLast, undefined, { sensitivity: 'base' }) ||
          bFirst.localeCompare(aFirst, undefined, { sensitivity: 'base' });
      }
      return 0;
    });
  }, [people, allocations, projects, clients, leaves, selectedYear, filters]);

  // Sorted clients
  const sortedClients = useMemo(() => {
    const sortMode = filters.clientSort || 'client-asc';
    if (sortMode === 'client-asc' || sortMode === 'project-asc') {
      return [...clients].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    }
    if (sortMode === 'client-desc' || sortMode === 'project-desc') {
      return [...clients].sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
      );
    }
    return clients;
  }, [clients, filters.clientSort]);

  // Filtered & sorted projects
  const filteredProjects = useMemo(() => {
    const matched = projects.filter((proj) => {
      if (filters.clientFilter !== 'all' && proj.clientId !== filters.clientFilter) {
        return false;
      }
      if (filters.search.trim() !== '') {
        const q = filters.search.toLowerCase();
        const client = clients.find((c) => c.id === proj.clientId);
        return (
          proj.name.toLowerCase().includes(q) ||
          proj.code.toLowerCase().includes(q) ||
          (proj.notes && proj.notes.toLowerCase().includes(q)) ||
          (client && client.name.toLowerCase().includes(q))
        );
      }
      return true;
    });

    const sortMode = filters.clientSort || 'client-asc';
    if (sortMode === 'project-asc' || sortMode === 'client-asc') {
      return [...matched].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    }
    if (sortMode === 'project-desc' || sortMode === 'client-desc') {
      return [...matched].sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
      );
    }
    return matched;
  }, [projects, clients, filters]);

  const handleTogglePeopleSort = () => {
    setFilters((prev) => ({
      ...prev,
      peopleSort:
        (prev.peopleSort || 'lastName-asc') === 'lastName-asc'
          ? 'lastName-desc'
          : 'lastName-asc'
    }));
  };

  const handleToggleClientSort = () => {
    setFilters((prev) => ({
      ...prev,
      clientSort:
        (prev.clientSort || 'client-asc') === 'client-asc'
          ? 'client-desc'
          : 'client-asc'
    }));
  };

  const handleTogglePersonExpand = (personId: string) => {
    setExpandedPersonIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  const handleToggleProjectExpand = (projectId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const isAllExpanded =
    viewMode === 'clients'
      ? projects.length > 0 && expandedProjectIds.size >= projects.length
      : people.length > 0 && expandedPersonIds.size >= people.length;

  const handleToggleExpandAll = () => {
    if (viewMode === 'clients') {
      if (expandedProjectIds.size >= projects.length) {
        setExpandedProjectIds(new Set());
      } else {
        setExpandedProjectIds(new Set(projects.map((p) => p.id)));
      }
    } else {
      if (expandedPersonIds.size >= people.length) {
        setExpandedPersonIds(new Set());
      } else {
        setExpandedPersonIds(new Set(people.map((p) => p.id)));
      }
    }
  };

  // Open cell editor when clicking a person's summary month cell
  const handleOpenPersonMonth = (personId: string, monthIndex: number) => {
    const personAllocs = allocations.filter(
      (a) => a.personId === personId && a.year === selectedYear
    );
    const activeInMonth = personAllocs.find((a) => (a.monthlyPercentage[monthIndex] || 0) > 0);
    const fallbackProjectId =
      activeInMonth?.projectId || personAllocs[0]?.projectId || projects[0]?.id;
    if (!fallbackProjectId) return;
    setActiveCellEditor({
      personId,
      projectId: fallbackProjectId,
      monthIndex
    });
  };

  const handleSaveCellAllocation = (
    newPercentage: number,
    newStatus: AllocationStatus,
    fillOptions?: { applyToAllRemaining?: boolean; applyToAllYear?: boolean }
  ) => {
    if (!activeCellEditor) return;
    const { personId, projectId, monthIndex } = activeCellEditor;

    setAppState((prev) => {
      const existingIdx = prev.allocations.findIndex(
        (a) =>
          a.personId === personId &&
          a.projectId === projectId &&
          a.year === prev.selectedYear
      );

      const nextAllocations = [...prev.allocations];

      if (existingIdx >= 0) {
        const updatedMonths = [...nextAllocations[existingIdx].monthlyPercentage];
        const updatedStatuses = normalizeAllocationStatuses(
          nextAllocations[existingIdx].monthlyStatus,
          'unknown'
        );
        if (fillOptions?.applyToAllYear) {
          for (let m = 0; m < 12; m++) {
            updatedMonths[m] = newPercentage;
            updatedStatuses[m] = newStatus;
          }
        } else if (fillOptions?.applyToAllRemaining) {
          for (let m = monthIndex; m < 12; m++) {
            updatedMonths[m] = newPercentage;
            updatedStatuses[m] = newStatus;
          }
        } else {
          updatedMonths[monthIndex] = newPercentage;
          updatedStatuses[monthIndex] = newStatus;
        }
        nextAllocations[existingIdx] = {
          ...nextAllocations[existingIdx],
          monthlyPercentage: updatedMonths,
          monthlyStatus: updatedStatuses
        };
      } else {
        const freshMonths = Array(12).fill(0);
        const freshStatuses: AllocationStatus[] = Array(12).fill('unknown');
        if (fillOptions?.applyToAllYear) {
          for (let m = 0; m < 12; m++) {
            freshMonths[m] = newPercentage;
            freshStatuses[m] = newStatus;
          }
        } else if (fillOptions?.applyToAllRemaining) {
          for (let m = monthIndex; m < 12; m++) {
            freshMonths[m] = newPercentage;
            freshStatuses[m] = newStatus;
          }
        } else {
          freshMonths[monthIndex] = newPercentage;
          freshStatuses[monthIndex] = newStatus;
        }
        nextAllocations.push({
          id: `a-${Date.now()}`,
          personId,
          projectId,
          year: prev.selectedYear,
          monthlyPercentage: freshMonths,
          monthlyStatus: freshStatuses
        });
      }

      return {
        ...prev,
        allocations: nextAllocations
      };
    });
  };

  const handleUpdateAllocationMonth = (
    personId: string,
    projectId: string,
    monthIndex: number,
    newPercentage: number
  ) => {
    setAppState((prev) => ({
      ...prev,
      allocations: prev.allocations.map((a) => {
        if (
          a.personId === personId &&
          a.projectId === projectId &&
          a.year === prev.selectedYear
        ) {
          const nextMonths = [...a.monthlyPercentage];
          nextMonths[monthIndex] = newPercentage;
          return { ...a, monthlyPercentage: nextMonths };
        }
        return a;
      })
    }));
  };

  const handleUpdateAllocationStatus = (
    allocationId: string,
    monthIndex: number,
    nextStatus: AllocationStatus
  ) => {
    setAppState((prev) => ({
      ...prev,
      allocations: prev.allocations.map((a) => {
        if (a.id === allocationId) {
          const nextStatuses = normalizeAllocationStatuses(a.monthlyStatus, 'unknown');
          nextStatuses[monthIndex] = nextStatus;
          return { ...a, monthlyStatus: nextStatuses };
        }
        return a;
      })
    }));
  };

  const handleBatchAssign = (
    personId: string,
    projectId: string,
    startMonth: number,
    endMonth: number,
    percentage: number,
    status: AllocationStatus,
    notes?: string
  ) => {
    setAppState((prev) => {
      const existingIdx = prev.allocations.findIndex(
        (a) =>
          a.personId === personId &&
          a.projectId === projectId &&
          a.year === prev.selectedYear
      );
      const nextAllocations = [...prev.allocations];

      if (existingIdx >= 0) {
        const updatedMonths = [...nextAllocations[existingIdx].monthlyPercentage];
        const updatedStatuses = normalizeAllocationStatuses(
          nextAllocations[existingIdx].monthlyStatus,
          'unknown'
        );
        for (let m = startMonth; m <= endMonth; m++) {
          updatedMonths[m] = percentage;
          updatedStatuses[m] = status;
        }
        nextAllocations[existingIdx] = {
          ...nextAllocations[existingIdx],
          monthlyPercentage: updatedMonths,
          monthlyStatus: updatedStatuses,
          notes: notes !== undefined ? notes : nextAllocations[existingIdx].notes
        };
      } else {
        const freshMonths = Array(12).fill(0);
        const freshStatuses: AllocationStatus[] = Array(12).fill('unknown');
        for (let m = startMonth; m <= endMonth; m++) {
          freshMonths[m] = percentage;
          freshStatuses[m] = status;
        }
        nextAllocations.push({
          id: `a-${Date.now()}`,
          personId,
          projectId,
          year: prev.selectedYear,
          monthlyPercentage: freshMonths,
          monthlyStatus: freshStatuses,
          notes
        });
      }

      return {
        ...prev,
        allocations: nextAllocations
      };
    });
    setExpandedPersonIds((prev) => new Set(prev).add(personId));
    setExpandedProjectIds((prev) => new Set(prev).add(projectId));
  };

  const handleDeleteAllocation = (allocationId: string) => {
    setAppState((prev) => ({
      ...prev,
      allocations: prev.allocations.filter((a) => a.id !== allocationId)
    }));
  };

  const handleAddPerson = (personData: Omit<Person, 'id'>) => {
    const newPerson: Person = {
      ...personData,
      id: `p-${Date.now()}`
    };
    setAppState((prev) => ({
      ...prev,
      people: [...prev.people, newPerson]
    }));
    setExpandedPersonIds((prev) => new Set(prev).add(newPerson.id));
  };

  const handleUpdatePerson = (updatedPerson: Person) => {
    setAppState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === updatedPerson.id ? updatedPerson : p))
    }));
  };

  const handleDeletePerson = (personId: string) => {
    setAppState((prev) => ({
      ...prev,
      people: prev.people.filter((p) => p.id !== personId),
      allocations: prev.allocations.filter((a) => a.personId !== personId),
      leaves: prev.leaves.filter((l) => l.personId !== personId)
    }));
  };

  const handleAddProject = (
    projectData: Omit<Project, 'id'>,
    newClientData?: Omit<Client, 'id'>
  ) => {
    setAppState((prev) => {
      let targetClientId = projectData.clientId;
      const nextClients = [...prev.clients];

      if (newClientData) {
        const createdClient: Client = {
          ...newClientData,
          id: `c-${Date.now()}`
        };
        nextClients.push(createdClient);
        targetClientId = createdClient.id;
      }

      const createdProject: Project = {
        ...projectData,
        clientId: targetClientId,
        id: `proj-${Date.now()}`
      };

      return {
        ...prev,
        clients: nextClients,
        projects: [...prev.projects, createdProject]
      };
    });
  };

  const handleUpdateProject = (
    updatedProject: Project,
    updatedClient?: Client,
    newClientData?: Omit<Client, 'id'>
  ) => {
    setAppState((prev) => {
      let targetClientId = updatedProject.clientId;
      let nextClients = [...prev.clients];

      if (newClientData) {
        const createdClient: Client = {
          ...newClientData,
          id: `c-${Date.now()}`
        };
        nextClients.push(createdClient);
        targetClientId = createdClient.id;
      } else if (updatedClient) {
        nextClients = nextClients.map((c) =>
          c.id === updatedClient.id ? updatedClient : c
        );
      }

      const finalProject: Project = {
        ...updatedProject,
        clientId: targetClientId
      };

      return {
        ...prev,
        clients: nextClients,
        projects: prev.projects.map((p) =>
          p.id === finalProject.id ? finalProject : p
        )
      };
    });
  };

  const handleAddClient = (clientData: Omit<Client, 'id'>) => {
    const newClient: Client = {
      ...clientData,
      id: `c-${Date.now()}`
    };
    setAppState((prev) => ({
      ...prev,
      clients: [...prev.clients, newClient]
    }));
  };

  const handleUpdateClient = (updatedClient: Client) => {
    setAppState((prev) => ({
      ...prev,
      clients: prev.clients.map((c) =>
        c.id === updatedClient.id ? updatedClient : c
      )
    }));
  };

  const handleDeleteClient = (clientId: string) => {
    setAppState((prev) => {
      const removedProjectIds = new Set(
        prev.projects.filter((p) => p.clientId === clientId).map((p) => p.id)
      );
      return {
        ...prev,
        clients: prev.clients.filter((c) => c.id !== clientId),
        projects: prev.projects.filter((p) => p.clientId !== clientId),
        allocations: prev.allocations.filter((a) => !removedProjectIds.has(a.projectId))
      };
    });
    if (filters.clientFilter === clientId) {
      setFilters((prev) => ({ ...prev, clientFilter: 'all' }));
    }
  };

  const handleDeleteProject = (projectId: string) => {
    setAppState((prev) => ({
      ...prev,
      projects: prev.projects.filter((p) => p.id !== projectId),
      allocations: prev.allocations.filter((a) => a.projectId !== projectId)
    }));
  };

  const handleSaveLeave = (leaveData: Omit<LeaveEntry, 'id'>) => {
    const newLeave: LeaveEntry = {
      ...leaveData,
      id: `leave-${Date.now()}`
    };
    setAppState((prev) => ({
      ...prev,
      leaves: [...prev.leaves, newLeave]
    }));
    setExpandedPersonIds((prev) => new Set(prev).add(leaveData.personId));
  };

  const handleDeleteLeave = (leaveId: string) => {
    setAppState((prev) => ({
      ...prev,
      leaves: prev.leaves.filter((l) => l.id !== leaveId)
    }));
  };

  const handleAddLeaveType = (typeKey: LeaveType, meta: LeaveTypeMeta) => {
    setAppState((prev) => ({
      ...prev,
      leaveTypes: {
        ...(prev.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG),
        [typeKey]: meta
      }
    }));
  };

  const handleDeleteLeaveType = (typeKey: LeaveType) => {
    setAppState((prev) => {
      const currentTypes = { ...(prev.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG) };
      if (Object.keys(currentTypes).length <= 1) return prev;
      delete currentTypes[typeKey];
      return {
        ...prev,
        leaveTypes: currentTypes
      };
    });
  };

  // Notes & Employment updaters
  const handleUpdatePersonNotes = (personId: string, notes: string) => {
    setAppState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, notes } : p))
    }));
  };

  const handleUpdatePersonEmployment = (
    personId: string,
    employmentType: EmploymentType
  ) => {
    setAppState((prev) => ({
      ...prev,
      people: prev.people.map((p) =>
        p.id === personId ? { ...p, employmentType } : p
      )
    }));
  };

  const handleUpdateProjectNotes = (projectId: string, notes: string) => {
    setAppState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === projectId ? { ...p, notes } : p))
    }));
  };

  const handleUpdateAllocationNotes = (allocationId: string, notes: string) => {
    setAppState((prev) => ({
      ...prev,
      allocations: prev.allocations.map((a) =>
        a.id === allocationId ? { ...a, notes } : a
      )
    }));
  };

  const handleUpdateLeaveNotes = (leaveId: string, notes: string) => {
    setAppState((prev) => ({
      ...prev,
      leaves: prev.leaves.map((l) => (l.id === leaveId ? { ...l, notes } : l))
    }));
  };

  // Years management
  const handleAddYear = (year: number) => {
    setAppState((prev) => {
      const nextYears = Array.from(new Set([...prev.availableYears, year])).sort(
        (a, b) => a - b
      );
      return {
        ...prev,
        availableYears: nextYears,
        selectedYear: year
      };
    });
  };

  const handleRemoveYear = (yearToRemove: number) => {
    setAppState((prev) => {
      if (prev.availableYears.length <= 1) return prev;
      const nextYears = prev.availableYears.filter((y) => y !== yearToRemove);
      return {
        ...prev,
        availableYears: nextYears,
        selectedYear:
          prev.selectedYear === yearToRemove ? nextYears[0] : prev.selectedYear,
        allocations: prev.allocations.filter((a) => a.year !== yearToRemove),
        leaves: prev.leaves.filter((l) => l.year !== yearToRemove)
      };
    });
  };

  // Department management
  const handleRenameDepartment = (oldName: Department, newName: Department) => {
    setAppState((prev) => ({
      ...prev,
      departments: prev.departments.map((d) => (d === oldName ? newName : d)),
      people: prev.people.map((p) =>
        p.department === oldName ? { ...p, department: newName } : p
      )
    }));
    if (filters.department === oldName) {
      setFilters((prev) => ({ ...prev, department: newName }));
    }
  };

  const handleAddDepartment = (newName: Department) => {
    setAppState((prev) => ({
      ...prev,
      departments: prev.departments.includes(newName)
        ? prev.departments
        : [...prev.departments, newName]
    }));
  };

  const handleDeleteDepartment = (deptName: Department) => {
    setAppState((prev) => ({
      ...prev,
      departments: prev.departments.filter((d) => d !== deptName)
    }));
    if (filters.department === deptName) {
      setFilters((prev) => ({ ...prev, department: 'all' }));
    }
  };

  // Selective or full workspace data clearing (preserves admin login credentials)
  const handleClearWorkspaceData = (areas: ClearableDataArea[]) => {
    const effective = new Set<ClearableDataArea>(areas);
    if (effective.has('clients')) {
      effective.add('projects');
      effective.add('allocations');
    }
    if (effective.has('projects')) {
      effective.add('allocations');
    }
    if (effective.has('people')) {
      effective.add('allocations');
      effective.add('leaves');
    }

    setAppState((prev) => {
      const nextPeople = effective.has('people') ? [] : prev.people;
      const nextClients = effective.has('clients') ? [] : prev.clients;
      const nextProjects = effective.has('projects') ? [] : prev.projects;

      const nextAvailableYears = effective.has('years')
        ? [prev.selectedYear]
        : prev.availableYears;
      const allowedYearSet = new Set(nextAvailableYears);

      const nextAllocations = effective.has('allocations')
        ? []
        : prev.allocations.filter((a) => allowedYearSet.has(a.year));

      const nextLeaves = effective.has('leaves')
        ? []
        : prev.leaves.filter((l) => allowedYearSet.has(l.year));

      const remainingPersonDepts = Array.from(
        new Set(nextPeople.map((p) => p.department).filter(Boolean))
      );
      const nextDepartments = effective.has('departments')
        ? remainingPersonDepts.length > 0
          ? remainingPersonDepts
          : ['General']
        : prev.departments;

      let nextLeaveTypes = prev.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG;
      if (effective.has('leaveTypes')) {
        const preserved: Record<LeaveType, LeaveTypeMeta> = {
          ...DEFAULT_LEAVE_TYPE_CONFIG
        };
        for (const l of nextLeaves) {
          if (!preserved[l.type]) {
            preserved[l.type] = getLeaveTypeMeta(l.type, prev.leaveTypes);
          }
        }
        nextLeaveTypes = preserved;
        syncLeaveTypeConfigRegistry(nextLeaveTypes);
      }

      return {
        ...prev,
        people: nextPeople,
        clients: nextClients,
        projects: nextProjects,
        allocations: nextAllocations,
        leaves: nextLeaves,
        availableYears: nextAvailableYears,
        departments: nextDepartments,
        leaveTypes: nextLeaveTypes
      };
    });

    if (effective.has('clients')) {
      setFilters((prev) => ({ ...prev, clientFilter: 'all' }));
    }
    if (effective.has('departments')) {
      setFilters((prev) => ({ ...prev, department: 'all' }));
    }
    if (effective.has('people')) {
      setExpandedPersonIds(new Set());
    }
    if (effective.has('projects')) {
      setExpandedProjectIds(new Set());
    }
    if (
      effective.has('allocations') ||
      effective.has('people') ||
      effective.has('projects')
    ) {
      setActiveCellEditor(null);
    }
  };

  // Active cell editor details
  const activeEditorData = useMemo(() => {
    if (!activeCellEditor) return null;
    const person = people.find((p) => p.id === activeCellEditor.personId);
    const project = projects.find((p) => p.id === activeCellEditor.projectId);
    if (!person || !project) return null;

    const existingAlloc = allocations.find(
      (a) =>
        a.personId === person.id &&
        a.projectId === project.id &&
        a.year === selectedYear
    );
    const currentPercentage =
      existingAlloc?.monthlyPercentage[activeCellEditor.monthIndex] || 0;
    const currentStatus: AllocationStatus =
      existingAlloc?.monthlyStatus?.[activeCellEditor.monthIndex] || 'unknown';

    const otherAllocsSum = allocations
      .filter(
        (a) =>
          a.personId === person.id &&
          a.projectId !== project.id &&
          a.year === selectedYear
      )
      .reduce(
        (sum, a) => sum + (a.monthlyPercentage[activeCellEditor.monthIndex] || 0),
        0
      );

    return {
      person,
      project,
      monthIndex: activeCellEditor.monthIndex,
      currentPercentage,
      currentStatus,
      otherAllocsSum,
      existingAllocId: existingAlloc?.id
    };
  }, [activeCellEditor, people, projects, allocations, selectedYear]);

  if (
    !authReady ||
    (currentUser && accessStatus === 'checking') ||
    (currentUser && accessStatus === 'granted' && !isWorkspaceHydrated)
  ) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-200 p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-2xl space-y-4">
          {workspaceSyncError ? (
            <>
              <div className="space-y-1.5">
                <div className="text-sm font-bold text-rose-400">
                  Cloud Workspace Connection Issue
                </div>
                <p className="text-xs text-slate-300 leading-relaxed break-words">
                  {workspaceSyncError}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceSyncError(null);
                    setSyncStatus('syncing');
                    setAccessCheckNonce((n) => n + 1);
                  }}
                  className="flex-1 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                >
                  Retry Connection
                </button>
                <button
                  type="button"
                  onClick={() => void signOutUser()}
                  className="py-2 px-3 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center gap-3 text-xs font-mono text-slate-300">
              <span className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
              <span>Connecting to shared AlloCat cloud workspace...</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isAuthenticatedWorkspace = Boolean(currentUser);
  const currentUserLabel =
    currentUser?.displayName || currentMember?.displayName || currentUser?.email || null;
  const currentRole = currentUser?.role || currentMember?.role || 'editor';

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-slate-200/70 dark:bg-slate-950 text-slate-900 dark:text-slate-100 relative">
      {!isAuthenticatedWorkspace && (
        <LoginOverlay />
      )}

      <div
        className={`h-full flex flex-col overflow-hidden transition-all duration-300 ${
          !isAuthenticatedWorkspace ? 'blur-md pointer-events-none select-none' : ''
        }`}
      >
        {isAuthenticatedWorkspace && syncStatus === 'error' && workspaceSyncError && (
          <div className="bg-rose-600 text-white px-4 py-1.5 text-xs flex items-center justify-between gap-3 shrink-0">
            <span className="truncate font-medium">
              Cloud sync issue: {workspaceSyncError}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setWorkspaceSyncError(null);
                  setSyncStatus('syncing');
                  setAccessCheckNonce((n) => n + 1);
                }}
                className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 font-semibold cursor-pointer"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setWorkspaceSyncError(null)}
                aria-label="Dismiss sync error"
                className="px-1.5 py-0.5 rounded hover:bg-white/20 font-bold cursor-pointer"
              >
                ×
              </button>
            </div>
          </div>
        )}
        <Header
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          availableYears={availableYears}
          selectedYear={selectedYear}
          onYearChange={(year) => setAppState((prev) => ({ ...prev, selectedYear: year }))}
          onOpenManageYearsModal={() => setIsManageYearsOpen(true)}
          overtimeCount={kpis.totalPersonMonthsOverbooked}
          onOpenOvertimeDrawer={() => setIsOvertimeDrawerOpen(true)}
          onOpenAssignModal={() => setAssignModalState({ isOpen: true })}
          onOpenAddPersonModal={() => {
            setPersonToEdit(null);
            setIsAddPersonOpen(true);
          }}
          onOpenAddProjectModal={() => {
            setProjectToEdit(null);
            setClientToEdit(null);
            setIsAddProjectOpen(true);
          }}
          onOpenAddLeaveModal={() => setLeaveModalState({ isOpen: true })}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((d) => !d)}
          currentUser={currentUserLabel}
          userRole={currentRole}
          syncStatus={syncStatus}
          collaboratorCount={Math.max(1, workspaceMembers.length)}
          pendingRequestsCount={adminCollabState?.joinRequests.length || 0}
          onOpenAdminPanel={
            currentRole === 'viewer'
              ? undefined
              : (tab = 'people') => setAdminPanelState({ isOpen: true, tab })
          }
          onOpenReportingModal={(tab = 'departments') =>
            setReportingModalState({ isOpen: true, tab })
          }
          onOpenStandaloneModal={() => setIsStandaloneModalOpen(true)}
          onLogout={() => {
            void signOutUser();
          }}
        />

      <Toolbar
        viewMode={viewMode}
        filters={filters}
        onFilterChange={(partial) => setFilters((prev) => ({ ...prev, ...partial }))}
        departments={departments}
        clients={sortedClients}
        onOpenManageDepartmentsModal={() => setIsManageDepartmentsOpen(true)}
        readOnly={currentRole === 'viewer'}
        kpis={kpis}
        isAllExpanded={isAllExpanded}
        onToggleExpandAll={handleToggleExpandAll}
        selectedYear={selectedYear}
      />

      <main
        className="flex-1 min-h-0 max-w-[1720px] w-full mx-auto flex flex-col overflow-hidden"
        aria-disabled={currentRole === 'viewer'}
        onClickCapture={(event) => {
          if (currentRole === 'viewer') {
            event.stopPropagation();
          }
        }}
        onKeyDownCapture={(event) => {
          if (currentRole === 'viewer' && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {viewMode === 'clients' && (
          <ClientProjectMatrixView
            clients={sortedClients}
            projects={filteredProjects}
            people={people}
            allocations={allocations}
            leaves={leaves}
            selectedYear={selectedYear}
            expandedProjectIds={expandedProjectIds}
            onToggleProjectExpand={handleToggleProjectExpand}
            onOpenCellEditor={(personId, projectId, monthIndex) =>
              setActiveCellEditor({ personId, projectId, monthIndex })
            }
            onUpdateAllocationStatus={handleUpdateAllocationStatus}
            onOpenAssignModalForProject={(projectId) =>
              setAssignModalState({ isOpen: true, projectId })
            }
            onDeleteAllocation={handleDeleteAllocation}
            onEditClient={(client) => {
              setClientToEdit(client);
              setProjectToEdit(null);
              setIsAddProjectOpen(true);
            }}
            onEditProject={(project) => {
              setProjectToEdit(project);
              setClientToEdit(null);
              setIsAddProjectOpen(true);
            }}
            onEditPerson={(person) => {
              setPersonToEdit(person);
              setIsAddPersonOpen(true);
            }}
            onUpdateProjectNotes={handleUpdateProjectNotes}
            onUpdateAllocationNotes={handleUpdateAllocationNotes}
            clientSort={filters.clientSort || 'client-asc'}
            onToggleClientSort={handleToggleClientSort}
            visibleMonths={filters.visibleMonths}
            onToggleMonthVisibility={handleToggleMonthVisibility}
          />
        )}

        {viewMode === 'people' && (
          <PeopleMatrixView
            people={filteredPeople}
            clients={sortedClients}
            projects={projects}
            allocations={allocations}
            leaves={leaves}
            selectedYear={selectedYear}
            expandedPersonIds={expandedPersonIds}
            onTogglePersonExpand={handleTogglePersonExpand}
            onOpenCellEditor={(personId, projectId, monthIndex) =>
              setActiveCellEditor({ personId, projectId, monthIndex })
            }
            onUpdateAllocationStatus={handleUpdateAllocationStatus}
            onOpenPersonMonth={handleOpenPersonMonth}
            onOpenAssignModalForPerson={(personId) =>
              setAssignModalState({ isOpen: true, personId })
            }
            onDeleteAllocation={handleDeleteAllocation}
            onEditPerson={(person) => {
              setPersonToEdit(person);
              setIsAddPersonOpen(true);
            }}
            onEditProject={(project) => {
              setProjectToEdit(project);
              setClientToEdit(null);
              setIsAddProjectOpen(true);
            }}
            onDeletePerson={(personId) => {
              const found = people.find((p) => p.id === personId);
              if (found) setPersonToDelete(found);
            }}
            onUpdatePersonNotes={handleUpdatePersonNotes}
            onUpdatePersonEmployment={handleUpdatePersonEmployment}
            onUpdateAllocationNotes={handleUpdateAllocationNotes}
            peopleSort={filters.peopleSort || 'lastName-asc'}
            onTogglePeopleSort={handleTogglePeopleSort}
            visibleMonths={filters.visibleMonths}
            onToggleMonthVisibility={handleToggleMonthVisibility}
          />
        )}

        {viewMode === 'availability' && (
          <AvailabilityMatrixView
            people={filteredPeople}
            allocations={allocations}
            leaves={leaves}
            selectedYear={selectedYear}
            expandedPersonIds={expandedPersonIds}
            onTogglePersonExpand={handleTogglePersonExpand}
            onOpenAddLeaveForPerson={(personId, monthIndex) =>
              setLeaveModalState({ isOpen: true, personId, monthIndex })
            }
            onDeleteLeave={handleDeleteLeave}
            onEditPerson={(person) => {
              setPersonToEdit(person);
              setIsAddPersonOpen(true);
            }}
            onDeletePerson={(personId) => {
              const found = people.find((p) => p.id === personId);
              if (found) setPersonToDelete(found);
            }}
            onUpdatePersonNotes={handleUpdatePersonNotes}
            onUpdatePersonEmployment={handleUpdatePersonEmployment}
            onUpdateLeaveNotes={handleUpdateLeaveNotes}
            peopleSort={filters.peopleSort || 'lastName-asc'}
            onTogglePeopleSort={handleTogglePeopleSort}
            visibleMonths={filters.visibleMonths}
            onToggleMonthVisibility={handleToggleMonthVisibility}
          />
        )}

        {viewMode === 'bench' && (
          <BenchMatrixView
            people={filteredPeople}
            projects={projects}
            clients={sortedClients}
            allocations={allocations}
            leaves={leaves}
            selectedYear={selectedYear}
            onOpenAssignModalForPerson={(personId, monthIndex) =>
              setAssignModalState({ isOpen: true, personId, monthIndex })
            }
            onEditPerson={(person) => {
              setPersonToEdit(person);
              setIsAddPersonOpen(true);
            }}
            onDeletePerson={(personId) => {
              const found = people.find((p) => p.id === personId);
              if (found) setPersonToDelete(found);
            }}
            onUpdatePersonNotes={handleUpdatePersonNotes}
            onUpdatePersonEmployment={handleUpdatePersonEmployment}
            peopleSort={filters.peopleSort || 'lastName-asc'}
            onTogglePeopleSort={handleTogglePeopleSort}
            visibleMonths={filters.visibleMonths}
            onToggleMonthVisibility={handleToggleMonthVisibility}
          />
        )}
      </main>
      </div>

      {/* Cell Allocation & Total Workload Breakdown Popover */}
      {currentRole !== 'viewer' && activeEditorData && (
        <CellAllocationPopover
          isOpen={true}
          onClose={() => setActiveCellEditor(null)}
          person={activeEditorData.person}
          project={activeEditorData.project}
          monthIndex={activeEditorData.monthIndex}
          currentPercentage={activeEditorData.currentPercentage}
          currentStatus={activeEditorData.currentStatus}
          personMonthlyTotalOtherProjects={activeEditorData.otherAllocsSum}
          projects={projects}
          clients={clients}
          allocations={allocations}
          leaves={leaves}
          selectedYear={selectedYear}
          onSave={handleSaveCellAllocation}
          onDeleteAllocation={
            activeEditorData.existingAllocId
              ? () => handleDeleteAllocation(activeEditorData.existingAllocId!)
              : undefined
          }
          onSwitchProject={(newProjectId) =>
            setActiveCellEditor((prev) =>
              prev ? { ...prev, projectId: newProjectId } : null
            )
          }
        />
      )}

      {currentRole !== 'viewer' && <BatchAssignModal
        isOpen={assignModalState.isOpen}
        onClose={() => setAssignModalState({ isOpen: false })}
        people={people}
        projects={projects}
        clients={clients}
        selectedYear={selectedYear}
        defaultPersonId={assignModalState.personId}
        defaultProjectId={assignModalState.projectId}
        defaultMonthIndex={assignModalState.monthIndex}
        onAssign={handleBatchAssign}
      />}

      <AdminPanelModal
        isOpen={adminPanelState.isOpen && currentRole !== 'viewer'}
        initialTab={adminPanelState.tab}
        onClose={() => setAdminPanelState((prev) => ({ ...prev, isOpen: false }))}
        people={people}
        departments={departments}
        clients={clients}
        projects={projects}
        allocations={allocations}
        leaves={leaves}
        availableYears={availableYears}
        selectedYear={selectedYear}
        currentUser={currentUserLabel}
        onOpenAddPerson={() => {
          setPersonToEdit(null);
          setIsAddPersonOpen(true);
        }}
        onEditPerson={(person) => {
          setPersonToEdit(person);
          setIsAddPersonOpen(true);
        }}
        onDeletePerson={handleDeletePerson}
        onAddDepartment={handleAddDepartment}
        onRenameDepartment={handleRenameDepartment}
        onDeleteDepartment={handleDeleteDepartment}
        onAddClient={handleAddClient}
        onEditClient={(client) => {
          setClientToEdit(client);
          setProjectToEdit(null);
          setIsAddProjectOpen(true);
        }}
        onDeleteClient={handleDeleteClient}
        onOpenAddProject={() => {
          setProjectToEdit(null);
          setClientToEdit(null);
          setIsAddProjectOpen(true);
        }}
        onEditProject={(project) => {
          setProjectToEdit(project);
          setClientToEdit(null);
          setIsAddProjectOpen(true);
        }}
        onDeleteProject={handleDeleteProject}
        leaveTypes={leaveTypes}
        onOpenAddLeave={() => setLeaveModalState({ isOpen: true })}
        onDeleteLeave={handleDeleteLeave}
        onAddLeaveType={handleAddLeaveType}
        onDeleteLeaveType={handleDeleteLeaveType}
        onAddYear={handleAddYear}
        onRemoveYear={handleRemoveYear}
        onSelectYear={(yr) => setAppState((prev) => ({ ...prev, selectedYear: yr }))}
        onOpenExportImport={(scope = 'admin') => {
          setExportModalScope(scope);
          setIsExportModalOpen(true);
        }}
        onResetWorkspace={() => {
          const fresh = getDefaultAppState();
          setAppState(fresh);
        }}
        onClearWorkspaceData={handleClearWorkspaceData}
        onCreateWorkspaceBackup={async () => {
          const bytes = await exportSQLiteBinaryFile(appState);
          const dateStr = new Date().toISOString().slice(0, 10);
          triggerBinaryDownload(
            bytes,
            `allocat-workspace-backup-${dateStr}.sqlite`,
            'application/vnd.sqlite3'
          );
        }}
        currentUserUid={currentUser?.uid}
        userRole={currentRole}
        localUserRole={currentUser?.role || 'editor'}
        currentLocalUsername={currentUser?.displayName || ''}
        members={workspaceMembers}
        adminCollabState={adminCollabState}
        onRotateJoinCode={
          currentUser
            ? async () => {
                await rotateWorkspaceJoinCode(currentUser, adminCollabState?.joinCodes || []);
              }
            : undefined
        }
        onDeleteEmailInvite={deleteWorkspaceEmailInvite}
        onApproveJoinRequest={approveJoinRequest}
        onRejectJoinRequest={rejectJoinRequest}
        onUpdateMemberRole={updateCollaboratorRole}
        onRemoveMember={removeCollaborator}
      />

      <ReportingModal
        isOpen={reportingModalState.isOpen}
        initialTab={reportingModalState.tab}
        onClose={() => setReportingModalState((prev) => ({ ...prev, isOpen: false }))}
        people={people}
        departments={departments}
        clients={clients}
        projects={projects}
        allocations={allocations}
        leaves={leaves}
        leaveTypes={leaveTypes}
        availableYears={availableYears}
        selectedYear={selectedYear}
        onSelectYear={(yr) => setAppState((prev) => ({ ...prev, selectedYear: yr }))}
      />

      {currentRole !== 'viewer' && <AddPersonModal
        isOpen={isAddPersonOpen}
        onClose={() => {
          setIsAddPersonOpen(false);
          setPersonToEdit(null);
        }}
        departments={departments}
        personToEdit={personToEdit}
        onSavePerson={handleAddPerson}
        onUpdatePerson={handleUpdatePerson}
      />}

      {currentRole !== 'viewer' && <AddClientProjectModal
        isOpen={isAddProjectOpen}
        onClose={() => {
          setIsAddProjectOpen(false);
          setProjectToEdit(null);
          setClientToEdit(null);
        }}
        clients={clients}
        projectToEdit={projectToEdit}
        clientToEdit={clientToEdit}
        onSaveProject={handleAddProject}
        onUpdateProject={handleUpdateProject}
        onUpdateClient={handleUpdateClient}
        onDeleteProject={handleDeleteProject}
      />}

      {currentRole !== 'viewer' && <AddLeaveModal
        isOpen={leaveModalState.isOpen}
        onClose={() => setLeaveModalState({ isOpen: false })}
        people={people}
        selectedYear={selectedYear}
        defaultPersonId={leaveModalState.personId}
        defaultMonthIndex={leaveModalState.monthIndex}
        leaveTypes={leaveTypes}
        onSaveLeave={handleSaveLeave}
      />}

      {currentRole !== 'viewer' && <OvertimeAlertsDrawer
        isOpen={isOvertimeDrawerOpen}
        onClose={() => setIsOvertimeDrawerOpen(false)}
        people={people}
        projects={projects}
        clients={clients}
        allocations={allocations}
        leaves={leaves}
        selectedYear={selectedYear}
        onUpdateAllocationMonth={handleUpdateAllocationMonth}
      />}

      {currentRole !== 'viewer' && <ManageYearsModal
        isOpen={isManageYearsOpen}
        onClose={() => setIsManageYearsOpen(false)}
        years={availableYears}
        selectedYear={selectedYear}
        onAddYear={handleAddYear}
        onRemoveYear={handleRemoveYear}
        onSelectYear={(yr) => setAppState((prev) => ({ ...prev, selectedYear: yr }))}
      />}

      {currentRole !== 'viewer' && <ManageDepartmentsModal
        isOpen={isManageDepartmentsOpen}
        onClose={() => setIsManageDepartmentsOpen(false)}
        departments={departments}
        people={people}
        onRenameDepartment={handleRenameDepartment}
        onAddDepartment={handleAddDepartment}
        onDeleteDepartment={handleDeleteDepartment}
      />}

      {currentRole !== 'viewer' && <ConfirmDeletePersonModal
        person={personToDelete}
        onClose={() => setPersonToDelete(null)}
        onConfirmDelete={handleDeletePerson}
      />}

      {currentRole !== 'viewer' && <ExportImportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        appState={appState}
        activeViewMode={viewMode}
        initialScope={exportModalScope}
        onImportState={(newState) => setAppState(newState)}
        onResetToDefault={() => {
          const fresh = getDefaultAppState();
          setAppState(fresh);
        }}
        onOpenStandaloneModal={() => {
          setIsExportModalOpen(false);
          setIsStandaloneModalOpen(true);
        }}
      />}

      <StandaloneAppModal
        isOpen={isStandaloneModalOpen}
        onClose={() => setIsStandaloneModalOpen(false)}
        appState={appState}
      />

      {!isOnline && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
          <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
          <span>Offline Mode — Working from local workspace storage</span>
        </div>
      )}
    </div>
  );
}

export default App;
