import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  DEFAULT_LEAVE_TYPE_CONFIG,
  normalizeAllocationStatuses,
  syncLeaveTypeConfigRegistry
} from '../types';
import type {
  Allocation,
  Client,
  LeaveEntry,
  LeaveType,
  LeaveTypeMeta,
  Person,
  Project
} from '../types';
import type { AppState } from '../data/seedData';
import { requireSupabase, type AuthUser } from '../supabase';

export const DEFAULT_WORKSPACE_ID = 'default';

export type WorkspaceRole = 'admin' | 'editor';
type Unsubscribe = () => void;
type EntityTable =
  | 'workspace_people'
  | 'workspace_clients'
  | 'workspace_projects'
  | 'workspace_allocations'
  | 'workspace_leaves';

export interface WorkspaceMember {
  uid: string;
  displayName: string;
  photoURL: string;
  role: WorkspaceRole;
  joinedVia: 'bootstrap' | 'invite' | 'code' | 'approval';
  email?: string;
}

export interface WorkspaceJoinCode {
  code: string;
  label: string;
  active: boolean;
  createdByUid: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByUid: string;
}

export interface WorkspaceJoinRequest {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
}

export type WorkspaceAccessResult =
  | {
      status: 'granted';
      member: WorkspaceMember;
      isAdmin: boolean;
      bootstrapped: boolean;
    }
  | {
      status: 'needs_access';
      existingRequest: WorkspaceJoinRequest | null;
    };

export interface WorkspaceSubscriptionCallbacks {
  onStateHydrated: (cloudState: AppState) => void;
  onMembersUpdate: (members: WorkspaceMember[]) => void;
  onSyncError?: (err: Error) => void;
}

export interface AdminCollabState {
  joinCodes: WorkspaceJoinCode[];
  invites: WorkspaceInvite[];
  joinRequests: WorkspaceJoinRequest[];
  memberEmails: Record<string, string>;
}

interface DatabaseRow {
  id: string;
  data: Record<string, unknown>;
}

interface WorkspaceAccessResponse {
  status?: unknown;
  member?: unknown;
  isAdmin?: unknown;
  bootstrapped?: unknown;
  existingRequest?: unknown;
}

function assertNoError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback;
}

function asNumberArray(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : fallback;
}

function mapMember(value: unknown): WorkspaceMember {
  const member = asRecord(value);
  const role = member.role === 'admin' ? 'admin' : 'editor';
  const joinedVia =
    member.joinedVia === 'bootstrap' ||
    member.joinedVia === 'invite' ||
    member.joinedVia === 'code' ||
    member.joinedVia === 'approval'
      ? member.joinedVia
      : 'approval';
  return {
    uid: asString(member.uid),
    displayName: asString(member.displayName, 'Collaborator'),
    photoURL: asString(member.photoURL),
    role,
    joinedVia,
    email: asString(member.email) || undefined
  };
}

function mapJoinRequest(value: unknown): WorkspaceJoinRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = asRecord(value);
  const status =
    request.status === 'approved' || request.status === 'rejected' ? request.status : 'pending';
  return {
    uid: asString(request.uid),
    displayName: asString(request.displayName, 'Collaborator'),
    email: asString(request.email),
    photoURL: asString(request.photoURL),
    note: asString(request.note),
    status
  };
}

function mapAccessResponse(value: unknown): WorkspaceAccessResult {
  const response = asRecord(value) as WorkspaceAccessResponse;
  if (response.status === 'granted') {
    return {
      status: 'granted',
      member: mapMember(response.member),
      isAdmin: response.isAdmin === true,
      bootstrapped: response.bootstrapped === true
    };
  }
  if (response.status === 'needs_access') {
    return {
      status: 'needs_access',
      existingRequest: mapJoinRequest(response.existingRequest)
    };
  }
  throw new Error('Supabase returned an invalid workspace access response.');
}

export async function checkOrJoinWorkspace(
  user: AuthUser,
): Promise<WorkspaceAccessResult> {
  const { data, error } = await requireSupabase().rpc('ensure_workspace_access', {
    p_invite_code: null,
    p_display_name: user.displayName || user.email || 'Collaborator',
    p_photo_url: user.photoURL || ''
  });
  assertNoError(error);
  return mapAccessResponse(data);
}

export async function joinWorkspaceWithCode(
  user: AuthUser,
  rawCode: string
): Promise<WorkspaceMember> {
  const { data, error } = await requireSupabase().rpc('join_workspace_by_code', {
    p_code: rawCode.trim()
  });
  assertNoError(error);
  const result = mapAccessResponse(data);
  if (result.status !== 'granted') {
    throw new Error('Invalid or inactive workspace invite code. Please check with your admin.');
  }
  return result.member;
}

export async function submitJoinRequest(
  user: AuthUser,
  note: string
): Promise<WorkspaceJoinRequest> {
  const client = requireSupabase();
  const request: WorkspaceJoinRequest = {
    uid: user.uid,
    displayName: user.displayName || user.email || 'Collaborator',
    email: user.email || '',
    photoURL: user.photoURL || '',
    note: note.trim().slice(0, 300),
    status: 'pending'
  };
  const { data: existing, error: existingError } = await client
    .from('workspace_join_requests')
    .select('user_id,display_name,email,photo_url,note,status')
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('user_id', user.uid)
    .maybeSingle();
  assertNoError(existingError);
  if (existing) {
    return {
      uid: existing.user_id,
      displayName: existing.display_name,
      email: existing.email,
      photoURL: existing.photo_url,
      note: existing.note,
      status: existing.status
    };
  }
  const { error } = await client.from('workspace_join_requests').insert({
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: user.uid,
    display_name: request.displayName,
    email: request.email,
    photo_url: request.photoURL,
    note: request.note,
    status: request.status
  });
  assertNoError(error);
  return request;
}

function mapPerson(row: DatabaseRow): Person {
  const data = row.data;
  const employmentType =
    data.employmentType === 'External' || data.employmentType === 'B2B'
      ? data.employmentType
      : 'Internal';
  return {
    id: row.id,
    firstName: asString(data.firstName),
    lastName: asString(data.lastName),
    name: asString(data.name, 'Team Member'),
    role: asString(data.role),
    department: asString(data.department, 'General'),
    employmentType,
    email: asString(data.email),
    maxCapacityPercent: asNumber(data.maxCapacityPercent, 100),
    avatarColor: asString(data.avatarColor, '#2563EB'),
    initials: asString(data.initials),
    isActive: data.isActive !== false,
    isPlaceholder: data.isPlaceholder === true || row.id === 'p-tbd',
    notes: asString(data.notes)
  };
}

function mapClient(row: DatabaseRow): Client {
  const data = row.data;
  const status = data.status === 'lead' || data.status === 'completed' ? data.status : 'active';
  return {
    id: row.id,
    name: asString(data.name, 'Client'),
    industry: asString(data.industry),
    color: asString(data.color, '#2563EB'),
    status
  };
}

function mapProject(row: DatabaseRow): Project {
  const data = row.data;
  const status = data.status === 'planned' || data.status === 'completed' ? data.status : 'active';
  return {
    id: row.id,
    clientId: asString(data.clientId),
    name: asString(data.name, 'Project'),
    code: asString(data.code),
    status,
    color: asString(data.color, '#2563EB'),
    billable: data.billable === true,
    notes: asString(data.notes)
  };
}

function mapAllocation(row: DatabaseRow): Allocation {
  const data = row.data;
  const percentages = Array.isArray(data.monthlyPercentage) ? data.monthlyPercentage : [];
  return {
    id: row.id,
    personId: asString(data.personId),
    projectId: asString(data.projectId),
    year: asNumber(data.year, new Date().getFullYear()),
    monthlyPercentage: Array.from({ length: 12 }, (_, index) =>
      asNumber(percentages[index], 0)
    ),
    monthlyStatus: normalizeAllocationStatuses(
      Array.isArray(data.monthlyStatus) ? data.monthlyStatus : undefined,
      'unknown'
    ),
    notes: asString(data.notes)
  };
}

function mapLeave(row: DatabaseRow): LeaveEntry {
  const data = row.data;
  const startMonth = Math.max(0, Math.min(11, Math.round(asNumber(data.startMonth))));
  return {
    id: row.id,
    personId: asString(data.personId),
    type: asString(data.type, 'other'),
    title: asString(data.title),
    year: asNumber(data.year, new Date().getFullYear()),
    startMonth,
    endMonth: Math.max(startMonth, Math.min(11, Math.round(asNumber(data.endMonth, startMonth)))),
    impactPercent: asNumber(data.impactPercent, 50),
    notes: asString(data.notes)
  };
}

async function fetchEntityRows(table: EntityTable): Promise<DatabaseRow[]> {
  const { data, error } = await requireSupabase()
    .from(table)
    .select('id,data')
    .eq('workspace_id', DEFAULT_WORKSPACE_ID);
  assertNoError(error);
  return (data || []).map((row) => ({
    id: row.id,
    data: asRecord(row.data)
  }));
}

async function fetchWorkspaceState(): Promise<AppState> {
  const client = requireSupabase();
  const [workspaceResult, people, clients, projects, allocations, leaves, membersResult] =
    await Promise.all([
      client
        .from('workspaces')
        .select('available_years,selected_year,departments,leave_types')
        .eq('id', DEFAULT_WORKSPACE_ID)
        .single(),
      fetchEntityRows('workspace_people'),
      fetchEntityRows('workspace_clients'),
      fetchEntityRows('workspace_projects'),
      fetchEntityRows('workspace_allocations'),
      fetchEntityRows('workspace_leaves'),
      client
        .from('workspace_members')
        .select('user_id,display_name,photo_url,role,joined_via')
        .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    ]);
  assertNoError(workspaceResult.error);
  assertNoError(membersResult.error);

  const workspace = workspaceResult.data;
  if (!workspace) throw new Error('The Supabase workspace record was not found.');
  const members: WorkspaceMember[] = (membersResult.data || []).map((member) => ({
    uid: member.user_id,
    displayName: member.display_name,
    photoURL: member.photo_url,
    role: member.role === 'admin' ? 'admin' : 'editor',
    joinedVia:
      member.joined_via === 'bootstrap' ||
      member.joined_via === 'invite' ||
      member.joined_via === 'code'
        ? member.joined_via
        : 'approval'
  }));
  const leaveTypes = asRecord(workspace.leave_types) as Record<LeaveType, LeaveTypeMeta>;
  syncLeaveTypeConfigRegistry(leaveTypes);

  const state: AppState = {
    people: people.map(mapPerson),
    clients: clients.map(mapClient),
    projects: projects.map(mapProject),
    allocations: allocations.map(mapAllocation),
    leaves: leaves.map(mapLeave),
    availableYears: asNumberArray(workspace.available_years, [new Date().getFullYear()]),
    selectedYear: asNumber(workspace.selected_year, new Date().getFullYear()),
    departments: asStringArray(workspace.departments, ['General']),
    leaveTypes: Object.keys(leaveTypes).length > 0 ? leaveTypes : { ...DEFAULT_LEAVE_TYPE_CONFIG }
  };
  return state;
}

async function fetchWorkspaceMembers(): Promise<WorkspaceMember[]> {
  const { data, error } = await requireSupabase()
    .from('workspace_members')
    .select('user_id,display_name,photo_url,role,joined_via')
    .eq('workspace_id', DEFAULT_WORKSPACE_ID);
  assertNoError(error);
  return (data || []).map((member) => ({
    uid: member.user_id,
    displayName: member.display_name,
    photoURL: member.photo_url,
    role: member.role === 'admin' ? 'admin' : 'editor',
    joinedVia:
      member.joined_via === 'bootstrap' ||
      member.joined_via === 'invite' ||
      member.joined_via === 'code'
        ? member.joined_via
        : 'approval'
  }));
}

function scheduleRefresh(refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 50);
  };
}

export function subscribeToWorkspaceData(callbacks: WorkspaceSubscriptionCallbacks): Unsubscribe {
  const client = requireSupabase();
  let disposed = false;
  let refreshing = false;
  let refreshPending = false;

  const refresh = async () => {
    if (disposed) return;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      const [state, members] = await Promise.all([fetchWorkspaceState(), fetchWorkspaceMembers()]);
      if (!disposed) {
        callbacks.onStateHydrated(state);
        callbacks.onMembersUpdate(members);
      }
    } catch (error) {
      callbacks.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        void refresh();
      }
    }
  };
  const refreshSoon = scheduleRefresh(() => void refresh());
  const channel = client.channel(`workspace-data-${DEFAULT_WORKSPACE_ID}`);
  const tables = [
    'workspaces',
    'workspace_members',
    'workspace_people',
    'workspace_clients',
    'workspace_projects',
    'workspace_allocations',
    'workspace_leaves'
  ] as const;
  for (const table of tables) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `workspace_id=eq.${DEFAULT_WORKSPACE_ID}`
      },
      refreshSoon
    );
  }
  channel.subscribe((status, error) => {
    if (status === 'SUBSCRIBED') void refresh();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      callbacks.onSyncError?.(
        new Error(error?.message || `Workspace subscription ${status.toLowerCase()}.`)
      );
    }
  });
  void refresh();
  return () => {
    disposed = true;
    void client.removeChannel(channel);
  };
}

function stableEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function syncEntityDelta<T extends { id: string }>(
  table: EntityTable,
  previous: T[],
  next: T[]
): Promise<void> {
  const client = requireSupabase();
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const removedIds = [...previousById.keys()].filter((id) => !nextById.has(id));
  if (removedIds.length > 0) {
    const { error } = await client
      .from(table)
      .delete()
      .eq('workspace_id', DEFAULT_WORKSPACE_ID)
      .in('id', removedIds);
    assertNoError(error);
  }
  const changedRows = next.filter((item) => !stableEqual(previousById.get(item.id), item));
  if (changedRows.length > 0) {
    const { error } = await client.from(table).upsert(
      changedRows.map((item) => ({
        workspace_id: DEFAULT_WORKSPACE_ID,
        id: item.id,
        data: item
      })),
      { onConflict: 'workspace_id,id' }
    );
    assertNoError(error);
  }
}

export async function syncWorkspaceDeltaToSupabase(
  previousState: AppState,
  nextState: AppState,
  user: AuthUser
): Promise<AppState> {
  await Promise.all([
    syncEntityDelta('workspace_clients', previousState.clients, nextState.clients),
    syncEntityDelta('workspace_people', previousState.people, nextState.people),
    syncEntityDelta('workspace_projects', previousState.projects, nextState.projects),
    syncEntityDelta('workspace_allocations', previousState.allocations, nextState.allocations),
    syncEntityDelta('workspace_leaves', previousState.leaves, nextState.leaves)
  ]);

  const configChanged =
    !stableEqual(previousState.availableYears, nextState.availableYears) ||
    previousState.selectedYear !== nextState.selectedYear ||
    !stableEqual(previousState.departments, nextState.departments) ||
    !stableEqual(previousState.leaveTypes, nextState.leaveTypes);
  if (configChanged) {
    const { error } = await requireSupabase()
      .from('workspaces')
      .update({
        available_years: nextState.availableYears,
        selected_year: nextState.selectedYear,
        departments: nextState.departments,
        leave_types: nextState.leaveTypes,
        updated_by_uid: user.uid,
        updated_by_name: user.displayName || user.email || 'Collaborator',
        updated_at: new Date().toISOString()
      })
      .eq('id', DEFAULT_WORKSPACE_ID);
    assertNoError(error);
  }
  return nextState;
}

async function fetchAdminCollabState(): Promise<AdminCollabState> {
  const client = requireSupabase();
  const [codesResult, invitesResult, requestsResult, privateResult] = await Promise.all([
    client
      .from('workspace_join_codes')
      .select('code,label,active,created_by_uid')
      .eq('workspace_id', DEFAULT_WORKSPACE_ID),
    client
      .from('workspace_invites')
      .select('id,email,role,invited_by_uid')
      .eq('workspace_id', DEFAULT_WORKSPACE_ID),
    client
      .from('workspace_join_requests')
      .select('user_id,display_name,email,photo_url,note,status')
      .eq('workspace_id', DEFAULT_WORKSPACE_ID)
      .eq('status', 'pending'),
    client
      .from('workspace_member_private')
      .select('user_id,email')
      .eq('workspace_id', DEFAULT_WORKSPACE_ID)
  ]);
  assertNoError(codesResult.error);
  assertNoError(invitesResult.error);
  assertNoError(requestsResult.error);
  assertNoError(privateResult.error);
  const memberEmails: Record<string, string> = {};
  for (const member of privateResult.data || []) {
    if (member.email) memberEmails[member.user_id] = member.email;
  }
  return {
    joinCodes: (codesResult.data || []).map((code) => ({
      code: code.code,
      label: code.label,
      active: code.active,
      createdByUid: code.created_by_uid || ''
    })),
    invites: (invitesResult.data || []).map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role === 'admin' ? 'admin' : 'editor',
      invitedByUid: invite.invited_by_uid || ''
    })),
    joinRequests: (requestsResult.data || []).map((request) => ({
      uid: request.user_id,
      displayName: request.display_name,
      email: request.email,
      photoURL: request.photo_url,
      note: request.note,
      status: request.status
    })),
    memberEmails
  };
}

export function subscribeToAdminCollabState(
  onUpdate: (state: AdminCollabState) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const client = requireSupabase();
  let disposed = false;
  let refreshing = false;
  let refreshPending = false;
  const refresh = async () => {
    if (disposed) return;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      const state = await fetchAdminCollabState();
      if (!disposed) onUpdate(state);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        void refresh();
      }
    }
  };
  const refreshSoon = scheduleRefresh(() => void refresh());
  const channel = client.channel(`workspace-admin-${DEFAULT_WORKSPACE_ID}`);
  for (const table of [
    'workspace_join_codes',
    'workspace_invites',
    'workspace_join_requests',
    'workspace_member_private'
  ] as const) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `workspace_id=eq.${DEFAULT_WORKSPACE_ID}`
      },
      refreshSoon
    );
  }
  channel.subscribe((status, error) => {
    if (status === 'SUBSCRIBED') void refresh();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      onError?.(new Error(error?.message || `Admin subscription ${status.toLowerCase()}.`));
    }
  });
  void refresh();
  return () => {
    disposed = true;
    void client.removeChannel(channel);
  };
}

function generateJoinCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const values = crypto.getRandomValues(new Uint8Array(8));
  return `team-${Array.from(values, (value) => chars[value % chars.length]).join('')}`;
}

export async function rotateWorkspaceJoinCode(
  adminUser: AuthUser,
  existingCodes: WorkspaceJoinCode[]
): Promise<string> {
  const client = requireSupabase();
  const { error: deactivateError } = await client
    .from('workspace_join_codes')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('active', true);
  assertNoError(deactivateError);
  const code = generateJoinCode();
  const { error } = await client.from('workspace_join_codes').insert({
    workspace_id: DEFAULT_WORKSPACE_ID,
    code,
    label: existingCodes.length > 0 ? 'Team Invite Link' : 'Default Team Invite Link',
    active: true,
    created_by_uid: adminUser.uid
  });
  assertNoError(error);
  return code;
}

export async function deleteWorkspaceEmailInvite(inviteId: string): Promise<void> {
  const { error } = await requireSupabase()
    .from('workspace_invites')
    .delete()
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('id', inviteId);
  assertNoError(error);
}

export async function approveJoinRequest(
  request: WorkspaceJoinRequest,
  role: WorkspaceRole = 'editor'
): Promise<void> {
  const client = requireSupabase();
  const { error: memberError } = await client.from('workspace_members').upsert(
    {
      workspace_id: DEFAULT_WORKSPACE_ID,
      user_id: request.uid,
      display_name: request.displayName,
      photo_url: request.photoURL,
      role,
      joined_via: 'approval'
    },
    { onConflict: 'workspace_id,user_id' }
  );
  assertNoError(memberError);
  const { error: privateError } = await client.from('workspace_member_private').upsert(
    {
      workspace_id: DEFAULT_WORKSPACE_ID,
      user_id: request.uid,
      email: request.email.toLowerCase()
    },
    { onConflict: 'workspace_id,user_id' }
  );
  assertNoError(privateError);
  const { error } = await client
    .from('workspace_join_requests')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('user_id', request.uid);
  assertNoError(error);
}

export async function rejectJoinRequest(requestUid: string): Promise<void> {
  const { error } = await requireSupabase()
    .from('workspace_join_requests')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('user_id', requestUid);
  assertNoError(error);
}

export async function updateCollaboratorRole(
  member: WorkspaceMember,
  _email: string | undefined,
  nextRole: WorkspaceRole
): Promise<void> {
  const { error } = await requireSupabase()
    .from('workspace_members')
    .update({ role: nextRole, updated_at: new Date().toISOString() })
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('user_id', member.uid);
  assertNoError(error);
}

export async function removeCollaborator(memberUid: string): Promise<void> {
  const { error } = await requireSupabase()
    .from('workspace_members')
    .delete()
    .eq('workspace_id', DEFAULT_WORKSPACE_ID)
    .eq('user_id', memberUid);
  assertNoError(error);
}
