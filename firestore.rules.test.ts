/**
 * Payload-First Security Test Suite Specification (Dirty Dozen Adversarial Payloads).
 * Documents and verifies the 12 adversarial payloads that must be rejected by firestore.rules.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: {
    uid: string | null;
    email?: string;
    emailVerified?: boolean;
  };
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
  enforcedByRule: string;
}

export const DIRTY_DOZEN_SECURITY_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated workspace read',
    operation: 'get',
    path: '/workspaces/default',
    auth: { uid: null },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'isEmailVerified() && (isWorkspaceMember(workspaceId) || isAdmin())'
  },
  {
    id: 2,
    name: 'Unverified email spoofing as bootstrapped admin',
    operation: 'create',
    path: '/workspaces/default',
    auth: { uid: 'attacker-1', email: 'ictismylife@gmail.com', emailVerified: false },
    payload: { name: 'Hijacked' },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'isEmailVerified() checks request.auth.token.email_verified == true'
  },
  {
    id: 3,
    name: 'Self-assigned admin role via join code',
    operation: 'create',
    path: '/workspaces/default/members/user-2',
    auth: { uid: 'user-2', email: 'user2@example.com', emailVerified: true },
    payload: {
      uid: 'user-2',
      displayName: 'User Two',
      photoURL: '',
      role: 'admin',
      joinedVia: 'code',
      inviteCode: 'valid-code-123'
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: "incoming().role == 'editor' enforced for joinCode self-registration"
  },
  {
    id: 4,
    name: 'Unauthorized write to /admins/{uid}',
    operation: 'create',
    path: '/admins/user-2',
    auth: { uid: 'user-2', email: 'user2@example.com', emailVerified: true },
    payload: { uid: 'user-2', displayName: 'Fake Admin', email: 'user2@example.com', addedByUid: 'user-2' },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'allow create: if isAdmin()'
  },
  {
    id: 5,
    name: 'Shadow ghost field injection on person create',
    operation: 'create',
    path: '/workspaces/default/people/p-999',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: {
      id: 'p-999',
      workspaceId: 'default',
      firstName: 'Alex',
      lastName: 'Reed',
      name: 'Alex Reed',
      role: 'Engineer',
      department: 'Engineering',
      employmentType: 'Internal',
      email: 'alex@example.com',
      maxCapacityPercent: 100,
      avatarColor: '#2563EB',
      initials: 'AR',
      notes: '',
      isVerified: true
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'isValidPerson() enforces data.keys().hasOnly([...])'
  },
  {
    id: 6,
    name: 'Oversized / malformed document ID poisoning',
    operation: 'create',
    path: '/workspaces/default/clients/' + 'a'.repeat(140),
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: { id: 'a'.repeat(140), workspaceId: 'default', name: 'Bad Client' },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'isShortId(clientId) enforces size() <= 64 and regex ^[a-zA-Z0-9_\\-]+$'
  },
  {
    id: 7,
    name: 'Client-forged updatedAt timestamp',
    operation: 'update',
    path: '/workspaces/default/clients/c-1',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: {
      updatedAt: '2020-01-01T00:00:00Z',
      updatedByUid: 'editor-1'
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'incoming().updatedAt == request.time'
  },
  {
    id: 8,
    name: 'Immutable createdAt tampering on allocation update',
    operation: 'update',
    path: '/workspaces/default/allocations/a-1',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: {
      createdAt: '2026-11-23T00:00:00Z'
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'incoming().createdAt == existing().createdAt && affectedKeys().hasOnly([...])'
  },
  {
    id: 9,
    name: 'Orphaned allocation referencing missing personId',
    operation: 'create',
    path: '/workspaces/default/allocations/a-orphan',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: {
      id: 'a-orphan',
      workspaceId: 'default',
      personId: 'nonexistent-person',
      projectId: 'proj-1',
      year: 2026
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'existsAfter(/databases/$(database)/documents/workspaces/$(workspaceId)/people/$(incoming().personId))'
  },
  {
    id: 10,
    name: 'PII cross-read of another member private email',
    operation: 'get',
    path: '/workspaces/default/memberPrivate/other-uid',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'isOwner(userId) || isWorkspaceAdmin(workspaceId)'
  },
  {
    id: 11,
    name: 'Invalid monthlyStatus array enum poisoning',
    operation: 'update',
    path: '/workspaces/default/allocations/a-1',
    auth: { uid: 'editor-1', email: 'editor@example.com', emailVerified: true },
    payload: {
      monthlyStatus: ['invalid_status', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned']
    },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: "data.monthlyStatus.size() == 12 && data.monthlyStatus.hasOnly(['unknown', 'planned', 'confirmed'])"
  },
  {
    id: 12,
    name: 'Non-member blanket list query on workspace people',
    operation: 'list',
    path: '/workspaces/default/people',
    auth: { uid: 'outsider-99', email: 'outsider@example.com', emailVerified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcedByRule: 'resource.data.workspaceId == workspaceId && (isWorkspaceMember(workspaceId) || isAdmin())'
  }
];
