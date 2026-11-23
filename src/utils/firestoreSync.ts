import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
  Unsubscribe
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import {
  Allocation,
  AllocationStatus,
  Client,
  ClientStatus,
  DEFAULT_LEAVE_TYPE_CONFIG,
  EmploymentType,
  LeaveEntry,
  LeaveType,
  LeaveTypeMeta,
  Person,
  Project,
  ProjectStatus,
  normalizeAllocationStatuses,
  syncLeaveTypeConfigRegistry
} from '../types';
import { AppState, getDefaultAppState } from '../data/seedData';
import { initSQLiteWorkspace } from './sqliteDatabase';

export const DEFAULT_WORKSPACE_ID = 'default';
export const BOOTSTRAPPED_ADMIN_EMAIL = 'ictismylife@gmail.com';

export type WorkspaceRole = 'admin' | 'editor';

export interface WorkspaceMember {
  uid: string;
  displayName: string;
  photoURL: string;
  role: WorkspaceRole;
  joinedVia: 'bootstrap' | 'invite' | 'code' | 'approval';
  email?: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface WorkspaceJoinCode {
  code: string;
  label: string;
  active: boolean;
  createdByUid: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByUid: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface WorkspaceJoinRequest {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export type WorkspaceAccessResult =
  | {
      status: 'granted';
      member: WorkspaceMember;
      isAdmin: boolean;
      bootstrapped: boolean;
      migratedFromLocal: boolean;
    }
  | {
      status: 'needs_access';
      existingRequest: WorkspaceJoinRequest | null;
    };

// ============================================================================
// BLUEPRINT-SYNCHRONIZED SANITIZERS (matches firebase-blueprint.json)
// ============================================================================
function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const str = typeof val === 'string' ? val : val == null ? fallback : String(val);
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function clampNonEmptyStr(val: unknown, maxLen: number, fallback: string): string {
  const trimmed = clampStr(val, maxLen).trim();
  return trimmed.length > 0 ? trimmed : fallback.slice(0, maxLen);
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num * 100) / 100));
}

export function sanitizeShortId(raw: unknown, prefix: string): string {
  const base = typeof raw === 'string' ? raw.trim() : '';
  const cleaned = base.replace(/[^a-zA-Z0-9_\-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

function sanitizeEmploymentType(val: unknown): EmploymentType {
  if (val === 'External' || val === 'B2B' || val === 'Internal') return val;
  return 'Internal';
}

function sanitizeClientStatus(val: unknown): ClientStatus {
  if (val === 'active' || val === 'lead' || val === 'completed') return val;
  return 'active';
}

function sanitizeProjectStatus(val: unknown): ProjectStatus {
  if (val === 'active' || val === 'planned' || val === 'completed') return val;
  return 'active';
}

function sanitizeLeaveTypesMap(
  raw?: Record<LeaveType, LeaveTypeMeta>
): Record<LeaveType, LeaveTypeMeta> {
  const source = raw && Object.keys(raw).length > 0 ? raw : DEFAULT_LEAVE_TYPE_CONFIG;
  const entries = Object.entries(source).slice(0, 40);
  const out: Record<LeaveType, LeaveTypeMeta> = {};
  for (const [k, meta] of entries) {
    const cleanKey = sanitizeShortId(k, 'leave');
    out[cleanKey] = {
      label: clampNonEmptyStr(meta?.label, 120, cleanKey),
      badgeClass: clampNonEmptyStr(
        meta?.badgeClass,
        300,
        DEFAULT_LEAVE_TYPE_CONFIG.other.badgeClass
      ),
      iconName: clampNonEmptyStr(meta?.iconName, 60, 'CalendarOff'),
      defaultImpact: clampInt(meta?.defaultImpact, 0, 100, 50)
    };
  }
  return Object.keys(out).length > 0 ? out : { ...DEFAULT_LEAVE_TYPE_CONFIG };
}

function sanitizeDepartments(raw?: string[]): string[] {
  const list = Array.isArray(raw) ? raw : ['General'];
  const deduped = Array.from(
    new Set(
      list
        .map((d) => clampStr(d, 80).trim())
        .filter((d) => d.length >= 1)
    )
  ).slice(0, 100);
  return deduped.length > 0 ? deduped : ['General'];
}

function sanitizeYears(raw?: number[], selectedYear?: number): {
  availableYears: number[];
  selectedYear: number;
} {
  const fallbackYear = new Date().getFullYear();
  const valid = Array.isArray(raw)
    ? Array.from(
        new Set(
          raw
            .map((y) => clampInt(y, 2000, 2100, fallbackYear))
            .filter((y) => Number.isInteger(y))
        )
      )
        .sort((a, b) => a - b)
        .slice(0, 30)
    : [];
  const availableYears = valid.length > 0 ? valid : [fallbackYear];
  const targetSelected = clampInt(selectedYear, 2000, 2100, availableYears[0]);
  const finalSelected = availableYears.includes(targetSelected)
    ? targetSelected
    : availableYears[0];
  return { availableYears, selectedYear: finalSelected };
}

/**
 * Ensures all entity IDs and foreign keys conform to ^[a-zA-Z0-9_-]{1,64}$
 * before persisting to Firestore (important for arbitrary CSV/JSON imports).
 */
export function normalizeStateIdsForFirestore(state: AppState): AppState {
  const personIdMap = new Map<string, string>();
  const clientIdMap = new Map<string, string>();
  const projectIdMap = new Map<string, string>();
  const allocIdSet = new Set<string>();
  const leaveIdSet = new Set<string>();

  const nextClients: Client[] = state.clients.map((c, idx) => {
    let nextId = sanitizeShortId(c.id, `c-${idx + 1}`);
    while (Array.from(clientIdMap.values()).includes(nextId)) {
      nextId = sanitizeShortId(`${nextId}-${idx}`, 'c');
    }
    clientIdMap.set(c.id, nextId);
    return { ...c, id: nextId };
  });

  const nextPeople: Person[] = state.people.map((p, idx) => {
    let nextId = sanitizeShortId(p.id, `p-${idx + 1}`);
    while (Array.from(personIdMap.values()).includes(nextId)) {
      nextId = sanitizeShortId(`${nextId}-${idx}`, 'p');
    }
    personIdMap.set(p.id, nextId);
    return { ...p, id: nextId };
  });

  const nextProjects: Project[] = state.projects
    .filter((proj) => clientIdMap.has(proj.clientId))
    .map((proj, idx) => {
      let nextId = sanitizeShortId(proj.id, `proj-${idx + 1}`);
      while (Array.from(projectIdMap.values()).includes(nextId)) {
        nextId = sanitizeShortId(`${nextId}-${idx}`, 'proj');
      }
      projectIdMap.set(proj.id, nextId);
      return {
        ...proj,
        id: nextId,
        clientId: clientIdMap.get(proj.clientId)!
      };
    });

  const nextAllocations: Allocation[] = state.allocations
    .filter((a) => personIdMap.has(a.personId) && projectIdMap.has(a.projectId))
    .map((a, idx) => {
      let nextId = sanitizeShortId(a.id, `a-${idx + 1}`);
      while (allocIdSet.has(nextId)) {
        nextId = sanitizeShortId(`${nextId}-${idx}`, 'a');
      }
      allocIdSet.add(nextId);
      return {
        ...a,
        id: nextId,
        personId: personIdMap.get(a.personId)!,
        projectId: projectIdMap.get(a.projectId)!
      };
    });

  const nextLeaves: LeaveEntry[] = state.leaves
    .filter((l) => personIdMap.has(l.personId))
    .map((l, idx) => {
      let nextId = sanitizeShortId(l.id, `leave-${idx + 1}`);
      while (leaveIdSet.has(nextId)) {
        nextId = sanitizeShortId(`${nextId}-${idx}`, 'leave');
      }
      leaveIdSet.add(nextId);
      return {
        ...l,
        id: nextId,
        personId: personIdMap.get(l.personId)!
      };
    });

  const years = sanitizeYears(state.availableYears, state.selectedYear);

  return {
    ...state,
    people: nextPeople,
    clients: nextClients,
    projects: nextProjects,
    allocations: nextAllocations,
    leaves: nextLeaves,
    availableYears: years.availableYears,
    selectedYear: years.selectedYear,
    departments: sanitizeDepartments(state.departments),
    leaveTypes: sanitizeLeaveTypesMap(state.leaveTypes)
  };
}

function buildPersonPayload(person: Person, uid: string, isCreate: boolean) {
  const base = {
    firstName: clampStr(person.firstName, 80),
    lastName: clampStr(person.lastName, 80),
    name: clampNonEmptyStr(person.name, 160, 'Team Member'),
    role: clampStr(person.role, 120),
    department: clampNonEmptyStr(person.department, 80, 'General'),
    employmentType: sanitizeEmploymentType(person.employmentType),
    email: clampStr(person.email, 180),
    maxCapacityPercent: clampNum(person.maxCapacityPercent, 0, 300, 100),
    avatarColor: clampNonEmptyStr(person.avatarColor, 32, '#2563EB'),
    initials: clampStr(person.initials, 10),
    notes: clampStr(person.notes, 2000),
    updatedAt: serverTimestamp(),
    updatedByUid: uid
  };
  if (isCreate) {
    return {
      id: person.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...base,
      createdAt: serverTimestamp()
    };
  }
  return base;
}

function buildClientPayload(client: Client, uid: string, isCreate: boolean) {
  const base = {
    name: clampNonEmptyStr(client.name, 160, 'Client'),
    industry: clampStr(client.industry, 120),
    color: clampNonEmptyStr(client.color, 32, '#2563EB'),
    status: sanitizeClientStatus(client.status),
    updatedAt: serverTimestamp(),
    updatedByUid: uid
  };
  if (isCreate) {
    return {
      id: client.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...base,
      createdAt: serverTimestamp()
    };
  }
  return base;
}

function buildProjectPayload(project: Project, uid: string, isCreate: boolean) {
  const base = {
    clientId: project.clientId,
    name: clampNonEmptyStr(project.name, 160, 'Project'),
    code: clampStr(project.code, 40),
    status: sanitizeProjectStatus(project.status),
    color: clampNonEmptyStr(project.color, 32, '#2563EB'),
    billable: Boolean(project.billable),
    notes: clampStr(project.notes, 2000),
    updatedAt: serverTimestamp(),
    updatedByUid: uid
  };
  if (isCreate) {
    return {
      id: project.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...base,
      createdAt: serverTimestamp()
    };
  }
  return base;
}

function buildAllocationPayload(alloc: Allocation, uid: string, isCreate: boolean) {
  const monthlyPercentage = Array.from({ length: 12 }, (_, i) =>
    clampNum(Array.isArray(alloc.monthlyPercentage) ? alloc.monthlyPercentage[i] : 0, 0, 500, 0)
  );
  const monthlyStatus: AllocationStatus[] = normalizeAllocationStatuses(
    alloc.monthlyStatus,
    'unknown'
  );
  const base = {
    monthlyPercentage,
    monthlyStatus,
    notes: clampStr(alloc.notes, 2000),
    updatedAt: serverTimestamp(),
    updatedByUid: uid
  };
  if (isCreate) {
    return {
      id: alloc.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      personId: alloc.personId,
      projectId: alloc.projectId,
      year: clampInt(alloc.year, 2000, 2100, new Date().getFullYear()),
      ...base,
      createdAt: serverTimestamp()
    };
  }
  return base;
}

function buildLeavePayload(leave: LeaveEntry, uid: string, isCreate: boolean) {
  const startMonth = clampInt(leave.startMonth, 0, 11, 0);
  const endMonth = clampInt(leave.endMonth, startMonth, 11, startMonth);
  const base = {
    type: clampNonEmptyStr(leave.type, 64, 'other'),
    title: clampStr(leave.title, 160),
    year: clampInt(leave.year, 2000, 2100, new Date().getFullYear()),
    startMonth,
    endMonth,
    impactPercent: clampNum(leave.impactPercent, 0, 100, 50),
    notes: clampStr(leave.notes, 2000),
    updatedAt: serverTimestamp(),
    updatedByUid: uid
  };
  if (isCreate) {
    return {
      id: leave.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      personId: leave.personId,
      ...base,
      createdAt: serverTimestamp()
    };
  }
  return base;
}

// ============================================================================
// BATCH COMMIT HELPER (max 400 operations per Firestore writeBatch)
// ============================================================================
type BatchOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> }
  | { type: 'delete'; path: string };

async function commitBatchOps(ops: BatchOp[]): Promise<void> {
  const CHUNK_SIZE = 400;
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const op of chunk) {
      const ref = doc(db, op.path);
      if (op.type === 'set') {
        batch.set(ref, op.data);
      } else if (op.type === 'update') {
        batch.update(ref, op.data);
      } else {
        batch.delete(ref);
      }
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(
        error,
        chunk[0]?.type === 'delete' ? OperationType.DELETE : OperationType.WRITE,
        chunk[0]?.path || `workspaces/${DEFAULT_WORKSPACE_ID}`
      );
    }
  }
}

function generateRandomJoinCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `team-${suffix}`;
}

export function isBootstrappedAdminEmail(email?: string | null): boolean {
  return (email || '').trim().toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL;
}

// ============================================================================
// WORKSPACE ACCESS & INITIALIZATION
// ============================================================================
export async function checkOrJoinWorkspace(
  user: User,
  explicitInviteCode?: string | null
): Promise<WorkspaceAccessResult> {
  const uid = user.uid;
  const emailLower = (user.email || '').trim().toLowerCase();
  const displayName = clampNonEmptyStr(user.displayName || emailLower || 'Collaborator', 120, 'Collaborator');
  const photoURL = clampStr(user.photoURL || '', 500);
  const bootstrapped = isBootstrappedAdminEmail(emailLower);

  const memberPath = `workspaces/${DEFAULT_WORKSPACE_ID}/members/${uid}`;
  const memberRef = doc(db, memberPath);
  const workspacePath = `workspaces/${DEFAULT_WORKSPACE_ID}`;
  const workspaceRef = doc(db, workspacePath);

  let isAdminUser = bootstrapped;
  if (!isAdminUser) {
    try {
      const adminSnap = await getDoc(doc(db, 'admins', uid));
      if (adminSnap.exists()) {
        isAdminUser = true;
      }
    } catch {
      // Not an admin doc or unreadable if not admin
    }
  }

  let memberSnap;
  try {
    memberSnap = await getDoc(memberRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, memberPath);
  }

  // Bootstrapped admin or existing global admin: ensure admin doc, workspace, and membership exist
  if (isAdminUser) {
    if (bootstrapped) {
      try {
        const adminDocRef = doc(db, 'admins', uid);
        const adminSnap = await getDoc(adminDocRef);
        if (!adminSnap.exists()) {
          await setDoc(adminDocRef, {
            uid,
            displayName,
            email: clampStr(emailLower, 180),
            addedByUid: uid,
            createdAt: serverTimestamp()
          });
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `admins/${uid}`);
      }
    }

    let workspaceSnap;
    try {
      workspaceSnap = await getDoc(workspaceRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, workspacePath);
    }

    let migratedFromLocal = false;
    if (!workspaceSnap.exists()) {
      // Check if local browser SQLite has prior data to migrate on initial cloud setup
      let initialSeed: AppState = getDefaultAppState();
      try {
        const sqliteBoot = await Promise.race([
          initSQLiteWorkspace(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('SQLite bootstrap timeout')), 3000)
          )
        ]);
        const localHasAnyData =
          sqliteBoot.state.people.length > 0 ||
          sqliteBoot.state.clients.length > 0 ||
          sqliteBoot.state.projects.length > 0 ||
          sqliteBoot.state.allocations.length > 0 ||
          sqliteBoot.state.leaves.length > 0;
        if (localHasAnyData) {
          initialSeed = sqliteBoot.state;
          migratedFromLocal = sqliteBoot.stats.engineReady;
        }
      } catch {
        // Fallback cleanly to default seed state
      }

      const cleanSeed = normalizeStateIdsForFirestore(initialSeed);
      const years = sanitizeYears(cleanSeed.availableYears, cleanSeed.selectedYear);

      // 1. Create workspace document & bootstrapped admin membership + default invite code
      const defaultCode = generateRandomJoinCode();
      await commitBatchOps([
        {
          type: 'set',
          path: workspacePath,
          data: {
            name: 'AlloCat Team Workspace',
            ownerId: uid,
            availableYears: years.availableYears,
            selectedYear: years.selectedYear,
            departments: sanitizeDepartments(cleanSeed.departments),
            leaveTypes: sanitizeLeaveTypesMap(cleanSeed.leaveTypes),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedByUid: uid,
            updatedByName: displayName
          }
        },
        {
          type: 'set',
          path: memberPath,
          data: {
            uid,
            displayName,
            photoURL,
            role: 'admin',
            joinedVia: 'bootstrap',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        },
        {
          type: 'set',
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${uid}`,
          data: {
            uid,
            email: clampStr(emailLower, 180),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        },
        {
          type: 'set',
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/joinCodes/${defaultCode}`,
          data: {
            code: defaultCode,
            label: 'Default Team Invite Link',
            active: true,
            createdByUid: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        }
      ]);

      // 2. Seed parent entities (clients, people)
      const wave1: BatchOp[] = [
        ...cleanSeed.clients.map((c) => ({
          type: 'set' as const,
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/clients/${c.id}`,
          data: buildClientPayload(c, uid, true)
        })),
        ...cleanSeed.people.map((p) => ({
          type: 'set' as const,
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/people/${p.id}`,
          data: buildPersonPayload(p, uid, true)
        }))
      ];
      if (wave1.length > 0) await commitBatchOps(wave1);

      // 3. Seed projects (references clients)
      const wave2: BatchOp[] = cleanSeed.projects.map((proj) => ({
        type: 'set' as const,
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/projects/${proj.id}`,
        data: buildProjectPayload(proj, uid, true)
      }));
      if (wave2.length > 0) await commitBatchOps(wave2);

      // 4. Seed allocations & leaves (reference people & projects)
      const wave3: BatchOp[] = [
        ...cleanSeed.allocations.map((a) => ({
          type: 'set' as const,
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${a.id}`,
          data: buildAllocationPayload(a, uid, true)
        })),
        ...cleanSeed.leaves.map((l) => ({
          type: 'set' as const,
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${l.id}`,
          data: buildLeavePayload(l, uid, true)
        }))
      ];
      if (wave3.length > 0) await commitBatchOps(wave3);

      const newMember: WorkspaceMember = {
        uid,
        displayName,
        photoURL,
        role: 'admin',
        joinedVia: 'bootstrap',
        email: emailLower
      };
      return {
        status: 'granted',
        member: newMember,
        isAdmin: true,
        bootstrapped: true,
        migratedFromLocal
      };
    }

    // Workspace exists; ensure admin has a member doc
    if (!memberSnap.exists()) {
      await commitBatchOps([
        {
          type: 'set',
          path: memberPath,
          data: {
            uid,
            displayName,
            photoURL,
            role: 'admin',
            joinedVia: 'bootstrap',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        },
        {
          type: 'set',
          path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${uid}`,
          data: {
            uid,
            email: clampStr(emailLower, 180),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        }
      ]);
      const newMember: WorkspaceMember = {
        uid,
        displayName,
        photoURL,
        role: 'admin',
        joinedVia: 'bootstrap',
        email: emailLower
      };
      return {
        status: 'granted',
        member: newMember,
        isAdmin: true,
        bootstrapped: false,
        migratedFromLocal: false
      };
    }
  }

  // Already a member of the workspace
  if (memberSnap.exists()) {
    const data = memberSnap.data() as WorkspaceMember;
    const role: WorkspaceRole = isAdminUser ? 'admin' : data.role || 'editor';
    return {
      status: 'granted',
      member: {
        uid,
        displayName: data.displayName || displayName,
        photoURL: data.photoURL || photoURL,
        role,
        joinedVia: data.joinedVia || 'approval',
        email: emailLower
      },
      isAdmin: role === 'admin',
      bootstrapped: false,
      migratedFromLocal: false
    };
  }

  // Try explicit invite code from URL (?invite=...)
  const cleanedCode = (explicitInviteCode || '').trim();
  if (cleanedCode) {
    const joined = await tryJoinWithCodeInternal(user, cleanedCode);
    if (joined) {
      return {
        status: 'granted',
        member: joined,
        isAdmin: joined.role === 'admin',
        bootstrapped: false,
        migratedFromLocal: false
      };
    }
  }

  // Check if user has a pending email invitation
  if (emailLower) {
    const invitesPath = `workspaces/${DEFAULT_WORKSPACE_ID}/invites`;
    try {
      const inviteQuery = query(
        collection(db, invitesPath),
        where('email', '==', emailLower)
      );
      const inviteSnap = await getDocs(inviteQuery);
      if (!inviteSnap.empty) {
        const inviteDoc = inviteSnap.docs[0];
        const inviteData = inviteDoc.data() as WorkspaceInvite;
        const assignedRole: WorkspaceRole =
          inviteData.role === 'admin' ? 'admin' : 'editor';

        await commitBatchOps([
          {
            type: 'set',
            path: memberPath,
            data: {
              uid,
              displayName,
              photoURL,
              role: assignedRole,
              joinedVia: 'invite',
              inviteId: inviteDoc.id,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            }
          },
          {
            type: 'set',
            path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${uid}`,
            data: {
              uid,
              email: clampStr(emailLower, 180),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            }
          },
          {
            type: 'delete',
            path: `${invitesPath}/${inviteDoc.id}`
          }
        ]);

        return {
          status: 'granted',
          member: {
            uid,
            displayName,
            photoURL,
            role: assignedRole,
            joinedVia: 'invite',
            email: emailLower
          },
          isAdmin: assignedRole === 'admin',
          bootstrapped: false,
          migratedFromLocal: false
        };
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, invitesPath);
    }
  }

  // Check if user already submitted a join request
  const requestPath = `workspaces/${DEFAULT_WORKSPACE_ID}/joinRequests/${uid}`;
  let existingRequest: WorkspaceJoinRequest | null = null;
  try {
    const reqSnap = await getDoc(doc(db, requestPath));
    if (reqSnap.exists()) {
      existingRequest = reqSnap.data() as WorkspaceJoinRequest;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, requestPath);
  }

  return {
    status: 'needs_access',
    existingRequest
  };
}

async function tryJoinWithCodeInternal(
  user: User,
  rawCode: string
): Promise<WorkspaceMember | null> {
  const code = sanitizeShortId(rawCode, 'code');
  const codePath = `workspaces/${DEFAULT_WORKSPACE_ID}/joinCodes/${code}`;
  try {
    const codeSnap = await getDoc(doc(db, codePath));
    if (!codeSnap.exists()) return null;
    const codeData = codeSnap.data() as WorkspaceJoinCode;
    if (!codeData.active) return null;
  } catch {
    return null;
  }

  const uid = user.uid;
  const emailLower = (user.email || '').trim().toLowerCase();
  const displayName = clampNonEmptyStr(
    user.displayName || emailLower || 'Collaborator',
    120,
    'Collaborator'
  );
  const photoURL = clampStr(user.photoURL || '', 500);

  await commitBatchOps([
    {
      type: 'set',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/members/${uid}`,
      data: {
        uid,
        displayName,
        photoURL,
        role: 'editor',
        joinedVia: 'code',
        inviteCode: code,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    },
    {
      type: 'set',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${uid}`,
      data: {
        uid,
        email: clampStr(emailLower, 180),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    }
  ]);

  return {
    uid,
    displayName,
    photoURL,
    role: 'editor',
    joinedVia: 'code',
    email: emailLower
  };
}

export async function joinWorkspaceWithCode(
  user: User,
  rawCode: string
): Promise<WorkspaceMember> {
  const joined = await tryJoinWithCodeInternal(user, rawCode);
  if (!joined) {
    throw new Error('Invalid or inactive workspace invite code. Please check with your admin.');
  }
  return joined;
}

export async function submitJoinRequest(
  user: User,
  note: string
): Promise<WorkspaceJoinRequest> {
  const uid = user.uid;
  const emailLower = (user.email || '').trim().toLowerCase();
  const displayName = clampNonEmptyStr(
    user.displayName || emailLower || 'Collaborator',
    120,
    'Collaborator'
  );
  const photoURL = clampStr(user.photoURL || '', 500);
  const cleanNote = clampStr(note.trim(), 300);
  const reqPath = `workspaces/${DEFAULT_WORKSPACE_ID}/joinRequests/${uid}`;

  const payload = {
    uid,
    displayName,
    email: clampNonEmptyStr(emailLower, 180, 'user@unknown'),
    photoURL,
    note: cleanNote,
    status: 'pending' as const,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, reqPath), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, reqPath);
  }

  return {
    uid,
    displayName,
    email: emailLower,
    photoURL,
    note: cleanNote,
    status: 'pending'
  };
}

export function subscribeToMemberAccess(
  uid: string,
  onGranted: () => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const memberPath = `workspaces/${DEFAULT_WORKSPACE_ID}/members/${uid}`;
  return onSnapshot(
    doc(db, memberPath),
    (snap) => {
      if (snap.exists()) {
        onGranted();
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, memberPath);
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

// ============================================================================
// REAL-TIME WORKSPACE SNAPSHOT SUBSCRIPTIONS
// ============================================================================
export interface WorkspaceSubscriptionCallbacks {
  onStateHydrated: (cloudState: AppState) => void;
  onMembersUpdate: (members: WorkspaceMember[]) => void;
  onSyncError?: (err: Error) => void;
}

export function subscribeToWorkspaceData(
  callbacks: WorkspaceSubscriptionCallbacks
): Unsubscribe {
  let metaLoaded = false;
  let peopleLoaded = false;
  let clientsLoaded = false;
  let projectsLoaded = false;
  let allocationsLoaded = false;
  let leavesLoaded = false;

  let currentMeta: {
    availableYears: number[];
    selectedYear: number;
    departments: string[];
    leaveTypes: Record<LeaveType, LeaveTypeMeta>;
  } = {
    availableYears: [new Date().getFullYear()],
    selectedYear: new Date().getFullYear(),
    departments: ['General'],
    leaveTypes: { ...DEFAULT_LEAVE_TYPE_CONFIG }
  };

  let currentPeople: Person[] = [];
  let currentClients: Client[] = [];
  let currentProjects: Project[] = [];
  let currentAllocations: Allocation[] = [];
  let currentLeaves: LeaveEntry[] = [];

  const emitIfReady = () => {
    if (
      !metaLoaded ||
      !peopleLoaded ||
      !clientsLoaded ||
      !projectsLoaded ||
      !allocationsLoaded ||
      !leavesLoaded
    ) {
      return;
    }

    syncLeaveTypeConfigRegistry(currentMeta.leaveTypes);
    callbacks.onStateHydrated({
      people: currentPeople,
      clients: currentClients,
      projects: currentProjects,
      allocations: currentAllocations,
      leaves: currentLeaves,
      availableYears: currentMeta.availableYears,
      selectedYear: currentMeta.selectedYear,
      departments: currentMeta.departments,
      leaveTypes: currentMeta.leaveTypes
    });
  };

  const wsPath = `workspaces/${DEFAULT_WORKSPACE_ID}`;
  const unsubWs = onSnapshot(
    doc(db, wsPath),
    (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        const years = sanitizeYears(d.availableYears, d.selectedYear);
        currentMeta = {
          availableYears: years.availableYears,
          selectedYear: years.selectedYear,
          departments: sanitizeDepartments(d.departments),
          leaveTypes: sanitizeLeaveTypesMap(d.leaveTypes)
        };
      }
      metaLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, wsPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const peoplePath = `workspaces/${DEFAULT_WORKSPACE_ID}/people`;
  const unsubPeople = onSnapshot(
    query(collection(db, peoplePath), where('workspaceId', '==', DEFAULT_WORKSPACE_ID)),
    (snap) => {
      currentPeople = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          firstName: clampStr(d.firstName, 80),
          lastName: clampStr(d.lastName, 80),
          name: clampNonEmptyStr(d.name, 160, 'Team Member'),
          role: clampStr(d.role, 120),
          department: clampNonEmptyStr(d.department, 80, 'General'),
          employmentType: sanitizeEmploymentType(d.employmentType),
          email: clampStr(d.email, 180),
          maxCapacityPercent: clampNum(d.maxCapacityPercent, 0, 300, 100),
          avatarColor: clampNonEmptyStr(d.avatarColor, 32, '#2563EB'),
          initials: clampStr(d.initials, 10),
          notes: clampStr(d.notes, 2000)
        };
      });
      peopleLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, peoplePath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const clientsPath = `workspaces/${DEFAULT_WORKSPACE_ID}/clients`;
  const unsubClients = onSnapshot(
    query(collection(db, clientsPath), where('workspaceId', '==', DEFAULT_WORKSPACE_ID)),
    (snap) => {
      currentClients = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          name: clampNonEmptyStr(d.name, 160, 'Client'),
          industry: clampStr(d.industry, 120),
          color: clampNonEmptyStr(d.color, 32, '#2563EB'),
          status: sanitizeClientStatus(d.status)
        };
      });
      clientsLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, clientsPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const projectsPath = `workspaces/${DEFAULT_WORKSPACE_ID}/projects`;
  const unsubProjects = onSnapshot(
    query(collection(db, projectsPath), where('workspaceId', '==', DEFAULT_WORKSPACE_ID)),
    (snap) => {
      currentProjects = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          clientId: String(d.clientId || ''),
          name: clampNonEmptyStr(d.name, 160, 'Project'),
          code: clampStr(d.code, 40),
          status: sanitizeProjectStatus(d.status),
          color: clampNonEmptyStr(d.color, 32, '#2563EB'),
          billable: Boolean(d.billable),
          notes: clampStr(d.notes, 2000)
        };
      });
      projectsLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, projectsPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const allocsPath = `workspaces/${DEFAULT_WORKSPACE_ID}/allocations`;
  const unsubAllocations = onSnapshot(
    query(collection(db, allocsPath), where('workspaceId', '==', DEFAULT_WORKSPACE_ID)),
    (snap) => {
      currentAllocations = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          personId: String(d.personId || ''),
          projectId: String(d.projectId || ''),
          year: clampInt(d.year, 2000, 2100, new Date().getFullYear()),
          monthlyPercentage: Array.from({ length: 12 }, (_, i) =>
            clampNum(Array.isArray(d.monthlyPercentage) ? d.monthlyPercentage[i] : 0, 0, 500, 0)
          ),
          monthlyStatus: normalizeAllocationStatuses(d.monthlyStatus, 'unknown'),
          notes: clampStr(d.notes, 2000)
        };
      });
      allocationsLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, allocsPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const leavesPath = `workspaces/${DEFAULT_WORKSPACE_ID}/leaves`;
  const unsubLeaves = onSnapshot(
    query(collection(db, leavesPath), where('workspaceId', '==', DEFAULT_WORKSPACE_ID)),
    (snap) => {
      currentLeaves = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          personId: String(d.personId || ''),
          type: clampNonEmptyStr(d.type, 64, 'other'),
          title: clampStr(d.title, 160),
          year: clampInt(d.year, 2000, 2100, new Date().getFullYear()),
          startMonth: clampInt(d.startMonth, 0, 11, 0),
          endMonth: clampInt(d.endMonth, 0, 11, 0),
          impactPercent: clampNum(d.impactPercent, 0, 100, 50),
          notes: clampStr(d.notes, 2000)
        };
      });
      leavesLoaded = true;
      emitIfReady();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, leavesPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  const membersPath = `workspaces/${DEFAULT_WORKSPACE_ID}/members`;
  const unsubMembers = onSnapshot(
    collection(db, membersPath),
    (snap) => {
      const members = snap.docs.map((docSnap) => docSnap.data() as WorkspaceMember);
      callbacks.onMembersUpdate(members);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, membersPath);
      } catch (e) {
        callbacks.onSyncError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );

  return () => {
    unsubWs();
    unsubPeople();
    unsubClients();
    unsubProjects();
    unsubAllocations();
    unsubLeaves();
    unsubMembers();
  };
}

// ============================================================================
// GRANULAR DELTA SYNC TO FIRESTORE
// ============================================================================
function stableEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function syncWorkspaceDeltaToFirestore(
  prevState: AppState,
  nextRawState: AppState,
  user: User
): Promise<AppState> {
  const uid = user.uid;
  const displayName = clampNonEmptyStr(
    user.displayName || user.email || 'Collaborator',
    120,
    'Collaborator'
  );
  const nextState = normalizeStateIdsForFirestore(nextRawState);

  const deleteWave1: BatchOp[] = []; // leaves, allocations
  const deleteWave2: BatchOp[] = []; // projects
  const deleteWave3: BatchOp[] = []; // clients, people

  const upsertWave1: BatchOp[] = []; // clients, people
  const upsertWave2: BatchOp[] = []; // projects
  const upsertWave3: BatchOp[] = []; // allocations, leaves

  // 1. Clients diff
  const prevClients = new Map(prevState.clients.map((c) => [c.id, c]));
  const nextClients = new Map(nextState.clients.map((c) => [c.id, c]));
  for (const [id] of prevClients) {
    if (!nextClients.has(id)) {
      deleteWave3.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/clients/${id}`
      });
    }
  }
  for (const [id, client] of nextClients) {
    const prev = prevClients.get(id);
    if (!prev) {
      upsertWave1.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/clients/${id}`,
        data: buildClientPayload(client, uid, true)
      });
    } else if (!stableEqual(prev, client)) {
      upsertWave1.push({
        type: 'update',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/clients/${id}`,
        data: buildClientPayload(client, uid, false)
      });
    }
  }

  // 2. People diff
  const prevPeople = new Map(prevState.people.map((p) => [p.id, p]));
  const nextPeople = new Map(nextState.people.map((p) => [p.id, p]));
  for (const [id] of prevPeople) {
    if (!nextPeople.has(id)) {
      deleteWave3.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/people/${id}`
      });
    }
  }
  for (const [id, person] of nextPeople) {
    const prev = prevPeople.get(id);
    if (!prev) {
      upsertWave1.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/people/${id}`,
        data: buildPersonPayload(person, uid, true)
      });
    } else if (!stableEqual(prev, person)) {
      upsertWave1.push({
        type: 'update',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/people/${id}`,
        data: buildPersonPayload(person, uid, false)
      });
    }
  }

  // 3. Projects diff
  const prevProjects = new Map(prevState.projects.map((p) => [p.id, p]));
  const nextProjects = new Map(nextState.projects.map((p) => [p.id, p]));
  for (const [id] of prevProjects) {
    if (!nextProjects.has(id)) {
      deleteWave2.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/projects/${id}`
      });
    }
  }
  for (const [id, proj] of nextProjects) {
    const prev = prevProjects.get(id);
    if (!prev) {
      upsertWave2.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/projects/${id}`,
        data: buildProjectPayload(proj, uid, true)
      });
    } else if (!stableEqual(prev, proj)) {
      upsertWave2.push({
        type: 'update',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/projects/${id}`,
        data: buildProjectPayload(proj, uid, false)
      });
    }
  }

  // 4. Allocations diff
  const prevAllocs = new Map(prevState.allocations.map((a) => [a.id, a]));
  const nextAllocs = new Map(nextState.allocations.map((a) => [a.id, a]));
  for (const [id] of prevAllocs) {
    if (!nextAllocs.has(id)) {
      deleteWave1.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${id}`
      });
    }
  }
  for (const [id, alloc] of nextAllocs) {
    const prev = prevAllocs.get(id);
    if (!prev) {
      upsertWave3.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${id}`,
        data: buildAllocationPayload(alloc, uid, true)
      });
    } else if (
      prev.personId !== alloc.personId ||
      prev.projectId !== alloc.projectId ||
      prev.year !== alloc.year
    ) {
      // Immutable key fields changed: recreate cleanly
      deleteWave1.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${id}`
      });
      upsertWave3.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${id}`,
        data: buildAllocationPayload(alloc, uid, true)
      });
    } else if (!stableEqual(prev, alloc)) {
      upsertWave3.push({
        type: 'update',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/allocations/${id}`,
        data: buildAllocationPayload(alloc, uid, false)
      });
    }
  }

  // 5. Leaves diff
  const prevLeaves = new Map(prevState.leaves.map((l) => [l.id, l]));
  const nextLeaves = new Map(nextState.leaves.map((l) => [l.id, l]));
  for (const [id] of prevLeaves) {
    if (!nextLeaves.has(id)) {
      deleteWave1.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${id}`
      });
    }
  }
  for (const [id, leave] of nextLeaves) {
    const prev = prevLeaves.get(id);
    if (!prev) {
      upsertWave3.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${id}`,
        data: buildLeavePayload(leave, uid, true)
      });
    } else if (prev.personId !== leave.personId) {
      deleteWave1.push({
        type: 'delete',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${id}`
      });
      upsertWave3.push({
        type: 'set',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${id}`,
        data: buildLeavePayload(leave, uid, true)
      });
    } else if (!stableEqual(prev, leave)) {
      upsertWave3.push({
        type: 'update',
        path: `workspaces/${DEFAULT_WORKSPACE_ID}/leaves/${id}`,
        data: buildLeavePayload(leave, uid, false)
      });
    }
  }

  // 6. Workspace config diff (availableYears, departments, leaveTypes)
  const configOps: BatchOp[] = [];
  const configChanged =
    !stableEqual(prevState.availableYears, nextState.availableYears) ||
    !stableEqual(prevState.departments, nextState.departments) ||
    !stableEqual(
      prevState.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG,
      nextState.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG
    );
  if (configChanged) {
    const years = sanitizeYears(nextState.availableYears, nextState.selectedYear);
    configOps.push({
      type: 'update',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}`,
      data: {
        availableYears: years.availableYears,
        selectedYear: years.selectedYear,
        departments: sanitizeDepartments(nextState.departments),
        leaveTypes: sanitizeLeaveTypesMap(nextState.leaveTypes),
        updatedAt: serverTimestamp(),
        updatedByUid: uid,
        updatedByName: displayName
      }
    });
  }

  // Execute in dependency-safe order
  if (deleteWave1.length > 0) await commitBatchOps(deleteWave1);
  if (deleteWave2.length > 0) await commitBatchOps(deleteWave2);
  if (deleteWave3.length > 0) await commitBatchOps(deleteWave3);
  if (upsertWave1.length > 0) await commitBatchOps(upsertWave1);
  if (upsertWave2.length > 0) await commitBatchOps(upsertWave2);
  if (upsertWave3.length > 0) await commitBatchOps(upsertWave3);
  if (configOps.length > 0) await commitBatchOps(configOps);

  return nextState;
}

// ============================================================================
// ADMIN COLLABORATION MANAGEMENT
// ============================================================================
export interface AdminCollabState {
  joinCodes: WorkspaceJoinCode[];
  invites: WorkspaceInvite[];
  joinRequests: WorkspaceJoinRequest[];
  memberEmails: Record<string, string>;
}

export function subscribeToAdminCollabState(
  onUpdate: (state: AdminCollabState) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  let joinCodes: WorkspaceJoinCode[] = [];
  let invites: WorkspaceInvite[] = [];
  let joinRequests: WorkspaceJoinRequest[] = [];
  let memberEmails: Record<string, string> = {};

  const emit = () => {
    onUpdate({ joinCodes, invites, joinRequests, memberEmails });
  };

  const reportError = (error: unknown, path: string) => {
    try {
      handleFirestoreError(error, OperationType.LIST, path);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const codesPath = `workspaces/${DEFAULT_WORKSPACE_ID}/joinCodes`;
  const unsubCodes = onSnapshot(
    collection(db, codesPath),
    (snap) => {
      joinCodes = snap.docs.map((d) => d.data() as WorkspaceJoinCode);
      emit();
    },
    (error) => reportError(error, codesPath)
  );

  const invitesPath = `workspaces/${DEFAULT_WORKSPACE_ID}/invites`;
  const unsubInvites = onSnapshot(
    collection(db, invitesPath),
    (snap) => {
      invites = snap.docs.map((d) => d.data() as WorkspaceInvite);
      emit();
    },
    (error) => reportError(error, invitesPath)
  );

  const requestsPath = `workspaces/${DEFAULT_WORKSPACE_ID}/joinRequests`;
  const unsubRequests = onSnapshot(
    collection(db, requestsPath),
    (snap) => {
      joinRequests = snap.docs
        .map((d) => d.data() as WorkspaceJoinRequest)
        .filter((r) => r.status === 'pending');
      emit();
    },
    (error) => reportError(error, requestsPath)
  );

  const privatePath = `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate`;
  const unsubPrivate = onSnapshot(
    collection(db, privatePath),
    (snap) => {
      const next: Record<string, string> = {};
      for (const d of snap.docs) {
        const data = d.data() as { uid?: string; email?: string };
        if (data.uid && data.email) {
          next[data.uid] = data.email;
        }
      }
      memberEmails = next;
      emit();
    },
    (error) => reportError(error, privatePath)
  );

  return () => {
    unsubCodes();
    unsubInvites();
    unsubRequests();
    unsubPrivate();
  };
}

export async function rotateWorkspaceJoinCode(
  adminUser: User,
  existingCodes: WorkspaceJoinCode[]
): Promise<string> {
  const newCode = generateRandomJoinCode();
  const ops: BatchOp[] = existingCodes
    .filter((c) => c.active)
    .map((c) => ({
      type: 'update' as const,
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/joinCodes/${c.code}`,
      data: {
        active: false,
        updatedAt: serverTimestamp()
      }
    }));

  ops.push({
    type: 'set',
    path: `workspaces/${DEFAULT_WORKSPACE_ID}/joinCodes/${newCode}`,
    data: {
      code: newCode,
      label: 'Team Invite Link',
      active: true,
      createdByUid: adminUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }
  });

  await commitBatchOps(ops);
  return newCode;
}

export async function createWorkspaceEmailInvite(
  adminUser: User,
  email: string,
  role: WorkspaceRole = 'editor'
): Promise<void> {
  const cleanEmail = clampNonEmptyStr(email.trim().toLowerCase(), 180, '');
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid Google email address.');
  }
  const inviteId = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const path = `workspaces/${DEFAULT_WORKSPACE_ID}/invites/${inviteId}`;
  try {
    await setDoc(doc(db, path), {
      id: inviteId,
      email: cleanEmail,
      role,
      invitedByUid: adminUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteWorkspaceEmailInvite(inviteId: string): Promise<void> {
  const path = `workspaces/${DEFAULT_WORKSPACE_ID}/invites/${inviteId}`;
  try {
    await commitBatchOps([{ type: 'delete', path }]);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function approveJoinRequest(
  request: WorkspaceJoinRequest,
  role: WorkspaceRole = 'editor'
): Promise<void> {
  const uid = request.uid;
  const ops: BatchOp[] = [
    {
      type: 'set',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/members/${uid}`,
      data: {
        uid,
        displayName: clampNonEmptyStr(request.displayName, 120, 'Collaborator'),
        photoURL: clampStr(request.photoURL || '', 500),
        role,
        joinedVia: 'approval',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    },
    {
      type: 'set',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${uid}`,
      data: {
        uid,
        email: clampStr(request.email.toLowerCase(), 180),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    },
    {
      type: 'update',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/joinRequests/${uid}`,
      data: {
        status: 'approved',
        updatedAt: serverTimestamp()
      }
    }
  ];

  if (role === 'admin' && auth.currentUser) {
    ops.push({
      type: 'set',
      path: `admins/${uid}`,
      data: {
        uid,
        displayName: clampStr(request.displayName, 120),
        email: clampStr(request.email.toLowerCase(), 180),
        addedByUid: auth.currentUser.uid,
        createdAt: serverTimestamp()
      }
    });
  }

  await commitBatchOps(ops);
}

export async function rejectJoinRequest(requestUid: string): Promise<void> {
  const path = `workspaces/${DEFAULT_WORKSPACE_ID}/joinRequests/${requestUid}`;
  try {
    await updateDoc(doc(db, path), {
      status: 'rejected',
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateCollaboratorRole(
  member: WorkspaceMember,
  email: string | undefined,
  nextRole: WorkspaceRole
): Promise<void> {
  const ops: BatchOp[] = [
    {
      type: 'update',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/members/${member.uid}`,
      data: {
        role: nextRole,
        updatedAt: serverTimestamp()
      }
    }
  ];

  if (nextRole === 'admin' && auth.currentUser) {
    ops.push({
      type: 'set',
      path: `admins/${member.uid}`,
      data: {
        uid: member.uid,
        displayName: clampStr(member.displayName, 120),
        email: clampStr(email || '', 180),
        addedByUid: auth.currentUser.uid,
        createdAt: serverTimestamp()
      }
    });
  } else if (nextRole === 'editor' && auth.currentUser && member.uid !== auth.currentUser.uid) {
    // Remove from /admins if demoted (only if doc exists; safe delete)
    ops.push({
      type: 'delete',
      path: `admins/${member.uid}`
    });
  }

  await commitBatchOps(ops);
}

export async function removeCollaborator(memberUid: string): Promise<void> {
  const ops: BatchOp[] = [
    {
      type: 'delete',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/members/${memberUid}`
    },
    {
      type: 'delete',
      path: `workspaces/${DEFAULT_WORKSPACE_ID}/memberPrivate/${memberUid}`
    }
  ];
  await commitBatchOps(ops);
}
