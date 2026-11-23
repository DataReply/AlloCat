import React, { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, Plus, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import {
  createLocalAppAccount,
  deleteLocalAppAccount,
  listLocalAppAccounts,
  updateLocalAppAccount
} from '../supabase';
import type { LocalAppAccount, LocalAppRole } from '../supabase';

const ROLE_LABELS: Record<LocalAppRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer'
};

interface LocalAccountsPanelProps {
  currentUsername: string;
}

export const LocalAccountsPanel: React.FC<LocalAccountsPanelProps> = ({ currentUsername }) => {
  const [accounts, setAccounts] = useState<LocalAppAccount[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<LocalAppRole>('editor');
  const [passwordChanges, setPasswordChanges] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refreshAccounts = async () => {
    setLoading(true);
    try {
      setAccounts(await listLocalAppAccounts());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAccounts();
  }, []);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      setAccounts(await createLocalAppAccount(username, password, role));
      setUsername('');
      setPassword('');
      setRole('editor');
      setFeedback('App account created in this browser.');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  };

  const handleRoleChange = async (account: LocalAppAccount, nextRole: LocalAppRole) => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      setAccounts(await updateLocalAppAccount(account.username, { role: nextRole }));
      setFeedback(`${account.username}'s role updated.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordChange = async (account: LocalAppAccount) => {
    const nextPassword = passwordChanges[account.username] || '';
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      setAccounts(await updateLocalAppAccount(account.username, { password: nextPassword }));
      setPasswordChanges((previous) => ({ ...previous, [account.username]: '' }));
      setFeedback(`${account.username}'s password was reset.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (account: LocalAppAccount) => {
    if (!window.confirm(`Delete the "${account.username}" app account from this browser?`)) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      setAccounts(await deleteLocalAppAccount(account.username));
      setFeedback(`${account.username} was deleted.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 space-y-1">
        <h3 className="text-xs font-bold text-amber-900 dark:text-amber-200">
          Browser-local accounts — not secure access control
        </h3>
        <p className="text-[11px] text-amber-900 dark:text-amber-200">
          Accounts and roles are stored only in this browser and are not shared with other devices.
          These roles only affect the app UI; anyone with the public Supabase key can still access
          the database directly. Use a trusted backend and server-enforced authorization for
          protected data.
        </p>
        <p className="text-[11px] text-amber-900 dark:text-amber-200">
          Admins manage accounts and settings, Editors can change workspace data, and Viewers can
          browse reports without using app editing controls.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {feedback && (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
          {feedback}
        </p>
      )}

      <form onSubmit={handleCreate} className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
        <div className="flex items-center gap-2">
          <UserCog className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Create app account</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Username</span>
            <input
              required
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9._-]+"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Password (8+ characters)</span>
            <input
              required
              minLength={8}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as LocalAppRole)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={busy || loading}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Create account
        </button>
      </form>

      <div className="space-y-2.5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          App accounts ({accounts.length})
        </h3>
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading app accounts...
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => (
              <div key={account.username} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center gap-3">
                <div className="flex items-center gap-2 min-w-36">
                  <ShieldCheck className="w-4 h-4 text-indigo-500 shrink-0" />
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {account.username}
                    {account.username.toLowerCase() === currentUsername.toLowerCase() && ' (you)'}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-[11px] text-slate-500">
                  Role
                  <select
                    value={account.role}
                    disabled={busy}
                    onChange={(event) => void handleRoleChange(account, event.target.value as LocalAppRole)}
                    className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  >
                    {Object.entries(ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="password"
                    value={passwordChanges[account.username] || ''}
                    onChange={(event) =>
                      setPasswordChanges((previous) => ({
                        ...previous,
                        [account.username]: event.target.value
                      }))
                    }
                    minLength={8}
                    placeholder="New password (8+ characters)"
                    autoComplete="new-password"
                    className="w-full lg:max-w-64 px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={busy || (passwordChanges[account.username] || '').length < 8}
                    onClick={() => void handlePasswordChange(account)}
                    title="Reset password"
                    className="p-2 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy || (account.role === 'admin' && accounts.filter((item) => item.role === 'admin').length <= 1)}
                  onClick={() => void handleDelete(account)}
                  title="Delete app account"
                  className="p-2 rounded border border-rose-200 dark:border-rose-900 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
