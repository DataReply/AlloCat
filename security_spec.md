# Security Specification — AlloCat Collaborative Workspace

## Phase 0: Data Invariants

1. **Authentication & Verification**: All workspace reads and writes require a verified Google account (`request.auth != null && request.auth.token.email_verified == true`).
2. **Membership Gate (Master Gate)**: Access to any workspace subcollection (`people`, `clients`, `projects`, `allocations`, `leaves`) requires an active collaborator document at `/workspaces/{workspaceId}/members/{request.auth.uid}` or global admin status.
3. **Role Integrity (Anti-Privilege Escalation)**: Self-registration via an invite code strictly forces `role == 'editor'`; claiming an email invite forces `role` to match the admin-issued invite; users cannot escalate their own `role` during updates or write to `/admins/{uid}`.
4. **PII Isolation**: Personal Google email addresses are isolated in `/workspaces/{workspaceId}/memberPrivate/{userId}` and readable only by the document owner or workspace administrators.
5. **Relational Integrity**: Projects must reference an existing or atomically created Client (`existsAfter`); Allocations must reference existing/atomic Person and Project; Leaves must reference an existing/atomic Person.
6. **Temporal & Author Integrity**: All `createdAt` and `updatedAt` timestamps must match `request.time` on creation, `createdAt` is immutable on update, `updatedAt` must match `request.time` on update, and `updatedByUid` must match `request.auth.uid`.
7. **Strict Schema & Bounds**: Every document enforces exact allowed/required keys (`hasAll` + `hasOnly`), string length limits, enum allowlists, array size limits, and regex-guarded IDs (`^[a-zA-Z0-9_\-]+$`).

## The "Dirty Dozen" Adversarial Payloads

1. **Unauthenticated Workspace Read/Write**: Read or write `/workspaces/default` with `auth == null` -> `PERMISSION_DENIED`.
2. **Email Spoofing (`email_verified: false`)**: Sign in with `email: 'ictismylife@gmail.com'`, `email_verified: false` -> `PERMISSION_DENIED`.
3. **Self-Assigned Admin Escalation**: Non-admin user attempts `create` on `/workspaces/default/members/{uid}` with `role: 'admin'` and `joinedVia: 'code'` -> `PERMISSION_DENIED`.
4. **Admin Collection Poisoning**: Non-admin user attempts `create` on `/admins/{uid}` -> `PERMISSION_DENIED`.
5. **Shadow / Ghost Field Injection**: Collaborator creates or updates a `person` document including an unexpected `isVerified: true` field -> `PERMISSION_DENIED` (`hasOnly` rejects).
6. **ID Poisoning / Oversized Document ID**: Collaborator creates a `client` with a 200-character ID or invalid characters (`../bad/id`) -> `PERMISSION_DENIED` (`isValidId` rejects).
7. **Timestamp Spoofing**: Collaborator sets `updatedAt` to a past client-chosen timestamp instead of `serverTimestamp()` -> `PERMISSION_DENIED` (`updatedAt == request.time` rejects).
8. **Immutability Tampering**: Collaborator attempts to mutate `createdAt` or `workspaceId` on an existing `allocation` -> `PERMISSION_DENIED`.
9. **Orphaned Allocation Write**: Collaborator creates an `allocation` referencing a nonexistent `personId` or `projectId` -> `PERMISSION_DENIED` (`existsAfter` rejects).
10. **PII Cross-Read**: Regular `'editor'` attempts `get` or `list` on `/workspaces/default/memberPrivate/{otherUid}` -> `PERMISSION_DENIED`.
11. **Invalid Monthly Status Array Poisoning**: Collaborator writes `monthlyStatus: ['hacked', ...]` or wrong length `11` on an `allocation` -> `PERMISSION_DENIED` (`size() == 12 && hasOnly(...)` rejects).
12. **Blanket List Scraping**: Non-member signed-in user runs `list` on `/workspaces/default/people` or `/workspaces/default/invites` -> `PERMISSION_DENIED`.
