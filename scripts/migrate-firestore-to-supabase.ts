import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createClient } from '@supabase/supabase-js';

type JsonRecord = Record<string, unknown>;

const WORKSPACE_ID = 'default';
const APPLY_CHANGES = process.argv.includes('--apply');
const CONFIRM_OVERWRITE = process.argv.includes('--confirm-overwrite');
const ENTITY_TABLES = [
  ['people', 'workspace_people'],
  ['clients', 'workspace_clients'],
  ['projects', 'workspace_projects'],
  ['allocations', 'workspace_allocations'],
  ['leaves', 'workspace_leaves']
] as const;
const COLLABORATION_COLLECTIONS = [
  'members',
  'memberPrivate',
  'joinCodes',
  'invites',
  'joinRequests'
] as const;

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Set one of these environment variables: ${names.join(', ')}`);
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function cleanFirestoreValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(cleanFirestoreValue);
  if (value && typeof value === 'object') {
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = cleanFirestoreValue(nested);
    }
    return output;
  }
  return value;
}

function mapRequiredUid(
  sourceUid: string,
  uidMap: Map<string, string>,
  fallbackUid?: string
): string {
  const mapped = uidMap.get(sourceUid);
  if (mapped) return mapped;
  if (fallbackUid) return fallbackUid;
  throw new Error(
    `Could not map Firebase user ${sourceUid} to a Supabase user. Verify Firebase Auth export and email addresses.`
  );
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'Dry-run by default. Set FIREBASE_SERVICE_ACCOUNT_PATH and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Use --apply to write and --confirm-overwrite if the target workspace already contains data.'
    );
    return;
  }

  const firebaseCredentialsPath = requiredEnv(
    'FIREBASE_SERVICE_ACCOUNT_PATH',
    'GOOGLE_APPLICATION_CREDENTIALS'
  );
  const supabaseUrl = requiredEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const supabaseServiceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const credentials = JSON.parse(readFileSync(firebaseCredentialsPath, 'utf8')) as ServiceAccount;
  const firebaseConfig = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'firebase-applet-config.json'), 'utf8')
  ) as { projectId: string; firestoreDatabaseId?: string };
  const sourceApp = initializeApp(
    { credential: cert(credentials), projectId: firebaseConfig.projectId },
    `allocat-firestore-migration-${Date.now()}`
  );
  const sourceDb = firebaseConfig.firestoreDatabaseId
    ? getFirestore(sourceApp, firebaseConfig.firestoreDatabaseId)
    : getFirestore(sourceApp);
  const sourceAuth = getAuth(sourceApp);
  const target = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const workspaceSnapshot = await sourceDb.doc(`workspaces/${WORKSPACE_ID}`).get();
  if (!workspaceSnapshot.exists) {
    throw new Error(
      `The Firebase workspace workspaces/${WORKSPACE_ID} does not exist; no live data was migrated.`
    );
  }
  const workspace = asRecord(cleanFirestoreValue(workspaceSnapshot.data()));

  const collaboration = new Map<string, Map<string, JsonRecord>>();
  for (const collectionName of COLLABORATION_COLLECTIONS) {
    const snapshot = await sourceDb
      .collection(`workspaces/${WORKSPACE_ID}/${collectionName}`)
      .get();
    collaboration.set(
      collectionName,
      new Map(snapshot.docs.map((document) => [
        document.id,
        asRecord(cleanFirestoreValue(document.data()))
      ]))
    );
  }
  const entities = new Map<string, Array<{ id: string; data: JsonRecord }>>();
  for (const [collectionName] of ENTITY_TABLES) {
    const snapshot = await sourceDb
      .collection(`workspaces/${WORKSPACE_ID}/${collectionName}`)
      .get();
    entities.set(
      collectionName,
      snapshot.docs.map((document) => ({
        id: document.id,
        data: asRecord(cleanFirestoreValue(document.data()))
      }))
    );
  }
  const adminSnapshot = await sourceDb.collection('admins').get();
  const globalAdmins = new Map(
    adminSnapshot.docs.map((document) => [
      document.id,
      asRecord(cleanFirestoreValue(document.data()))
    ])
  );

  const firebaseUsers: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const result = await sourceAuth.listUsers(1000, pageToken);
    firebaseUsers.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  const targetUsers = new Map<string, { id: string; email: string }>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await target.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const user of data.users) {
      if (user.email) {
        targetUsers.set(user.email.toLowerCase(), { id: user.id, email: user.email });
      }
    }
    if (data.users.length < 1000) break;
  }

  const targetWorkspaceCheck = await target
    .from('workspaces')
    .select('id')
    .eq('id', WORKSPACE_ID)
    .maybeSingle();
  if (targetWorkspaceCheck.error) {
    throw new Error(
      `Could not read the Supabase workspace table. Apply the Supabase schema first: ${targetWorkspaceCheck.error.message}`
    );
  }
  let targetHasData = Boolean(targetWorkspaceCheck.data);
  for (const [, table] of ENTITY_TABLES) {
    const { data, error } = await target
      .from(table)
      .select('id')
      .eq('workspace_id', WORKSPACE_ID)
      .limit(1);
    if (error) throw error;
    targetHasData ||= Boolean(data?.length);
  }
  if (targetHasData && APPLY_CHANGES && !CONFIRM_OVERWRITE) {
    throw new Error(
      'The target Supabase workspace already contains data. Review it and rerun with --confirm-overwrite to upsert the Firebase records.'
    );
  }

  const backupPath =
    process.env.MIGRATION_BACKUP_PATH ||
    path.join(tmpdir(), `allocat-firestore-backup-${Date.now()}.json`);
  const backup = {
    projectId: firebaseConfig.projectId,
    workspaceId: WORKSPACE_ID,
    exportedAt: new Date().toISOString(),
    authUsers: firebaseUsers.map((user) => ({
      uid: user.uid,
      email: user.email || null,
      emailVerified: user.emailVerified,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      providers: user.providerData.map((provider) => provider.providerId)
    })),
    workspace,
    collaboration: Object.fromEntries(
      [...collaboration].map(([name, records]) => [name, Object.fromEntries(records)])
    ),
    entities: Object.fromEntries(entities),
    globalAdmins: Object.fromEntries(globalAdmins)
  };
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), {
    flag: 'wx',
    mode: 0o600
  });

  const sourceUidToEmail = new Map(
    firebaseUsers
      .filter((user): user is UserRecord & { email: string } => Boolean(user.email))
      .map((user) => [user.uid, user.email.toLowerCase()])
  );
  for (const [uid, privateData] of collaboration.get('memberPrivate') || []) {
    const email = asString(privateData.email).trim().toLowerCase();
    if (email) sourceUidToEmail.set(uid, email);
  }
  for (const [uid, request] of collaboration.get('joinRequests') || []) {
    const email = asString(request.email).trim().toLowerCase();
    if (email) sourceUidToEmail.set(uid, email);
  }

  const uidMap = new Map<string, string>();
  let usersToCreate = 0;
  for (const user of firebaseUsers) {
    if (!user.email) continue;
    const email = user.email.toLowerCase();
    const existing = targetUsers.get(email);
    if (existing) {
      uidMap.set(user.uid, existing.id);
      continue;
    }
    usersToCreate += 1;
    if (!APPLY_CHANGES) continue;

    const { data, error } = await target.auth.admin.createUser({
      email,
      email_confirm: user.emailVerified,
      user_metadata: {
        full_name: user.displayName || '',
        avatar_url: user.photoURL || ''
      }
    });
    if (error) throw error;
    if (!data.user) throw new Error(`Supabase did not return the created user for ${email}.`);
    targetUsers.set(email, { id: data.user.id, email });
    uidMap.set(user.uid, data.user.id);
  }

  for (const [sourceUid, email] of sourceUidToEmail) {
    if (uidMap.has(sourceUid)) continue;
    const existing = targetUsers.get(email);
    if (existing) {
      uidMap.set(sourceUid, existing.id);
      continue;
    }
    usersToCreate += 1;
    if (APPLY_CHANGES) {
      const request = collaboration.get('joinRequests')?.get(sourceUid);
      const member = collaboration.get('members')?.get(sourceUid);
      const { data, error } = await target.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          full_name: asString(member?.displayName || request?.displayName, email),
          avatar_url: asString(member?.photoURL || request?.photoURL)
        }
      });
      if (error) throw error;
      if (!data.user) throw new Error(`Supabase did not return the created user for ${email}.`);
      targetUsers.set(email, { id: data.user.id, email });
      uidMap.set(sourceUid, data.user.id);
    }
  }

  const emailForSourceUid = (uid: string, privateRows = collaboration.get('memberPrivate')) =>
    sourceUidToEmail.get(uid) || asString(privateRows?.get(uid)?.email).toLowerCase();
  const sourceMembers = collaboration.get('members') || new Map<string, JsonRecord>();
  const privateRows = collaboration.get('memberPrivate') || new Map<string, JsonRecord>();
  for (const [sourceUid, member] of sourceMembers) {
    const email = emailForSourceUid(sourceUid, privateRows);
    if (uidMap.has(sourceUid)) continue;
    if (!email) {
      throw new Error(
        `Workspace member ${sourceUid} has no Firebase email mapping. Add its email to Firebase Auth or memberPrivate.`
      );
    }
    const existing = targetUsers.get(email);
    if (existing) {
      uidMap.set(sourceUid, existing.id);
      continue;
    }
    if (!APPLY_CHANGES) continue;
    throw new Error(`Supabase account ${email} is not available for workspace member ${sourceUid}.`);
  }

  const bootstrapTargetUid =
    uidMap.get(workspace.ownerId as string) ||
    targetUsers.get('ictismylife@gmail.com')?.id;
  if (APPLY_CHANGES && !bootstrapTargetUid) {
    throw new Error('Could not map the existing workspace owner to a Supabase Auth user.');
  }

  const counts = {
    users: firebaseUsers.filter((user) => Boolean(user.email)).length,
    usersToCreate,
    members: sourceMembers.size,
    joinCodes: collaboration.get('joinCodes')?.size || 0,
    invites: collaboration.get('invites')?.size || 0,
    joinRequests: collaboration.get('joinRequests')?.size || 0,
    entities: Object.fromEntries(
      [...entities].map(([name, rows]) => [name, rows.length])
    )
  };
  console.log(JSON.stringify({ mode: APPLY_CHANGES ? 'apply' : 'dry-run', counts, backupPath }, null, 2));
  if (!APPLY_CHANGES) {
    console.log('Dry run only. No Supabase users or workspace records were changed.');
    return;
  }

  const ownerId = mapRequiredUid(asString(workspace.ownerId), uidMap, bootstrapTargetUid);
  const updatedByUid = mapRequiredUid(asString(workspace.updatedByUid), uidMap, ownerId);
  const years = Array.isArray(workspace.availableYears)
    ? workspace.availableYears.filter((value): value is number => typeof value === 'number')
    : [new Date().getFullYear()];
  const currentYear = new Date().getFullYear();
  const { error: workspaceError } = await target.from('workspaces').upsert(
    {
      id: WORKSPACE_ID,
      name: asString(workspace.name, 'AlloCat Team Workspace'),
      owner_id: ownerId,
      available_years: years.length > 0 ? years : [currentYear],
      selected_year: Number(workspace.selectedYear) || currentYear,
      departments: Array.isArray(workspace.departments)
        ? workspace.departments.filter((value): value is string => typeof value === 'string')
        : ['General'],
      leave_types: asRecord(workspace.leaveTypes),
      updated_by_uid: updatedByUid,
      updated_by_name: asString(workspace.updatedByName),
      created_at: asString(workspace.createdAt, new Date().toISOString()),
      updated_at: asString(workspace.updatedAt, new Date().toISOString())
    },
    { onConflict: 'id' }
  );
  if (workspaceError) throw workspaceError;

  const memberRows = new Map<string, JsonRecord>();
  const memberPrivateRows = new Map<string, JsonRecord>();
  for (const [sourceUid, member] of sourceMembers) {
    const email = emailForSourceUid(sourceUid, privateRows);
    const targetUid = mapRequiredUid(sourceUid, uidMap);
    const isAdmin = member.role === 'admin' || globalAdmins.has(sourceUid);
    memberRows.set(targetUid, {
      workspace_id: WORKSPACE_ID,
      user_id: targetUid,
      display_name: asString(member.displayName, email || 'Collaborator'),
      photo_url: asString(member.photoURL),
      role: isAdmin ? 'admin' : 'editor',
      joined_via: ['bootstrap', 'invite', 'code', 'approval'].includes(asString(member.joinedVia))
        ? member.joinedVia
        : 'approval',
      invite_code: asString(member.inviteCode) || null,
      invite_id: asString(member.inviteId) || null,
      created_at: asString(member.createdAt, new Date().toISOString()),
      updated_at: asString(member.updatedAt, new Date().toISOString())
    });
    if (email) {
      memberPrivateRows.set(targetUid, {
        workspace_id: WORKSPACE_ID,
        user_id: targetUid,
        email
      });
    }
  }
  for (const [sourceUid, admin] of globalAdmins) {
    const email = emailForSourceUid(sourceUid, privateRows);
    const targetUid = uidMap.get(sourceUid) || (email ? targetUsers.get(email)?.id : undefined);
    if (!targetUid) continue;
    const existing = memberRows.get(targetUid);
    memberRows.set(targetUid, {
      ...existing,
      workspace_id: WORKSPACE_ID,
      user_id: targetUid,
      display_name: asString(existing?.display_name || admin.displayName, email || 'Admin'),
      photo_url: asString(existing?.photo_url),
      role: 'admin',
      joined_via: asString(existing?.joined_via, 'approval')
    });
    if (email) {
      memberPrivateRows.set(targetUid, {
        workspace_id: WORKSPACE_ID,
        user_id: targetUid,
        email
      });
    }
  }
  for (const memberBatch of chunks([...memberRows.values()], 500)) {
    const { error } = await target
      .from('workspace_members')
      .upsert(memberBatch, { onConflict: 'workspace_id,user_id' });
    if (error) throw error;
  }
  for (const privateBatch of chunks([...memberPrivateRows.values()], 500)) {
    const { error } = await target
      .from('workspace_member_private')
      .upsert(privateBatch, { onConflict: 'workspace_id,user_id' });
    if (error) throw error;
  }

  for (const [collectionName, table] of ENTITY_TABLES) {
    const records = entities.get(collectionName) || [];
    for (const batch of chunks(records, 500)) {
      const { error } = await target.from(table).upsert(
        batch.map((record) => ({ workspace_id: WORKSPACE_ID, id: record.id, data: record.data })),
        { onConflict: 'workspace_id,id' }
      );
      if (error) throw error;
    }
  }

  const joinCodes = [...(collaboration.get('joinCodes') || new Map()).entries()].map(
    ([id, code]) => ({
      workspace_id: WORKSPACE_ID,
      code: asString(code.code, id),
      label: asString(code.label, 'Team Invite Link'),
      active: code.active === true,
      created_by_uid: mapRequiredUid(asString(code.createdByUid), uidMap, ownerId),
      created_at: asString(code.createdAt, new Date().toISOString()),
      updated_at: asString(code.updatedAt, new Date().toISOString())
    })
  );
  for (const batch of chunks(joinCodes, 500)) {
    if (batch.length === 0) continue;
    const { error } = await target
      .from('workspace_join_codes')
      .upsert(batch, { onConflict: 'workspace_id,code' });
    if (error) throw error;
  }

  const invites = [...(collaboration.get('invites') || new Map()).entries()].map(
    ([id, invite]) => ({
      workspace_id: WORKSPACE_ID,
      id,
      email: asString(invite.email).toLowerCase(),
      role: invite.role === 'admin' ? 'admin' : 'editor',
      invited_by_uid: mapRequiredUid(asString(invite.invitedByUid), uidMap, ownerId),
      created_at: asString(invite.createdAt, new Date().toISOString()),
      updated_at: asString(invite.updatedAt, new Date().toISOString())
    })
  );
  for (const batch of chunks(invites, 500)) {
    if (batch.length === 0) continue;
    const { error } = await target
      .from('workspace_invites')
      .upsert(batch, { onConflict: 'workspace_id,id' });
    if (error) throw error;
  }

  const requests = [...(collaboration.get('joinRequests') || new Map()).entries()].map(
    ([sourceUid, request]) => {
      const targetUid = mapRequiredUid(sourceUid, uidMap);
      const status =
        request.status === 'approved' || request.status === 'rejected' ? request.status : 'pending';
      return {
        workspace_id: WORKSPACE_ID,
        user_id: targetUid,
        display_name: asString(request.displayName, 'Collaborator'),
        email: asString(request.email).toLowerCase(),
        photo_url: asString(request.photoURL),
        note: asString(request.note),
        status,
        created_at: asString(request.createdAt, new Date().toISOString()),
        updated_at: asString(request.updatedAt, new Date().toISOString())
      };
    }
  );
  for (const batch of chunks(requests, 500)) {
    if (batch.length === 0) continue;
    const { error } = await target
      .from('workspace_join_requests')
      .upsert(batch, { onConflict: 'workspace_id,user_id' });
    if (error) throw error;
  }

  console.log('Migration completed. Firebase data remains unchanged.');
}

main().catch((error: unknown) => {
  console.error('Firestore-to-Supabase migration failed:', error);
  process.exitCode = 1;
});
