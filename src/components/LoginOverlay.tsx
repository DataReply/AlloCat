import React, { useState } from 'react';
import {
  Cat,
  LogIn,
  AlertCircle,
  KeyRound,
  Send,
  LogOut,
  Users,
  CheckCircle2,
  Loader2,
  Cloud
} from 'lucide-react';
import type { User } from 'firebase/auth';
import { signInWithGoogle, signOutUser } from '../firebase';
import {
  WorkspaceJoinRequest,
  joinWorkspaceWithCode,
  submitJoinRequest
} from '../utils/firestoreSync';

interface LoginOverlayProps {
  firebaseUser: User | null;
  accessDeniedReason?: string | null;
  existingRequest?: WorkspaceJoinRequest | null;
  initialInviteCode?: string;
  onAccessGranted: () => void;
}

export const LoginOverlay: React.FC<LoginOverlayProps> = ({
  firebaseUser,
  accessDeniedReason,
  existingRequest,
  initialInviteCode = '',
  onAccessGranted
}) => {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [unauthorizedHost, setUnauthorizedHost] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [isJoiningByCode, setIsJoiningByCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const [requestNote, setRequestNote] = useState('');
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);
  const [submittedRequest, setSubmittedRequest] = useState<WorkspaceJoinRequest | null>(
    existingRequest || null
  );
  const [requestError, setRequestError] = useState<string | null>(null);

  const activeRequest = submittedRequest || existingRequest || null;

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setUnauthorizedHost(null);
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      const message = err instanceof Error ? err.message : String(err);

      if (code === 'auth/unauthorized-domain' || message.includes('unauthorized-domain')) {
        const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
        setUnauthorizedHost(host);
        setAuthError(
          `Domain "${host}" is not yet authorized for Google Sign-In in Firebase Authentication.`
        );
      } else if (code === 'auth/popup-blocked') {
        setAuthError('Sign-in popup was blocked by your browser. Please allow popups and try again.');
      } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError('Sign-in popup was closed before completing.');
      } else {
        setAuthError(message || 'Unable to sign in with Google.');
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleJoinWithCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !inviteCode.trim()) return;
    setCodeError(null);
    setIsJoiningByCode(true);
    try {
      await joinWorkspaceWithCode(firebaseUser, inviteCode.trim());
      onAccessGranted();
    } catch (err) {
      setCodeError(
        err instanceof Error ? err.message : 'Invalid or inactive invite code.'
      );
    } finally {
      setIsJoiningByCode(false);
    }
  };

  const handleSendJoinRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setRequestError(null);
    setIsSubmittingRequest(true);
    try {
      const req = await submitJoinRequest(firebaseUser, requestNote);
      setSubmittedRequest(req);
    } catch (err) {
      setRequestError(
        err instanceof Error ? err.message : 'Failed to send access request.'
      );
    } finally {
      setIsSubmittingRequest(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/45 dark:bg-slate-950/70 backdrop-blur-xs">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Top header banner */}
        <div className="px-6 pt-7 pb-5 bg-slate-100/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-center">
          <div className="w-12 h-12 rounded-xl bg-indigo-600 text-white flex items-center justify-center mx-auto shadow-md mb-3">
            <Cat className="w-7 h-7" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {firebaseUser ? 'Join AlloCat Team Workspace' : 'Sign in to AlloCat'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {firebaseUser
              ? 'Enter a team invite code or request collaborator access'
              : 'Real-time collaborative Resource & Capacity Planner'}
          </p>
        </div>

        {!firebaseUser ? (
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800/70 text-xs text-indigo-800 dark:text-indigo-200">
              <Cloud className="w-4 h-4 shrink-0 mt-0.5 text-indigo-600 dark:text-indigo-400" />
              <span>
                Changes are saved to a shared cloud database and synced live across every team member—including on GitHub Pages.
              </span>
            </div>

            {authError && (
              <div className="space-y-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
                  <span>{authError}</span>
                </div>
                {unauthorizedHost && (
                  <div className="pl-6 text-[11px] text-rose-600 dark:text-rose-300/90 space-y-1">
                    <p>
                      To enable Google Sign-In on this host, open{' '}
                      <strong>Firebase Console → Authentication → Settings → Authorized domains</strong>{' '}
                      and add:
                    </p>
                    <code className="block px-2 py-1 rounded bg-rose-100 dark:bg-rose-900/60 font-mono font-semibold">
                      {unauthorizedHost}
                    </code>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold text-xs shadow-sm transition-colors cursor-pointer"
            >
              {isSigningIn ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
              <span>{isSigningIn ? 'Signing in...' : 'Continue with Google'}</span>
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-5 text-xs">
            {/* Signed in badge */}
            <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                  Signed in as
                </div>
                <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {firebaseUser.displayName || firebaseUser.email}
                </div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  {firebaseUser.email}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 text-[11px] font-medium cursor-pointer shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Switch</span>
              </button>
            </div>

            {accessDeniedReason && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{accessDeniedReason}</span>
              </div>
            )}

            {/* Option 1: Join via Invite Code */}
            <form onSubmit={handleJoinWithCode} className="space-y-2.5">
              <label className="block font-semibold text-slate-700 dark:text-slate-300">
                Have a Team Invite Code?
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => {
                      setInviteCode(e.target.value);
                      if (codeError) setCodeError(null);
                    }}
                    placeholder="e.g. team-ab12cd34"
                    className="w-full pl-8 pr-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isJoiningByCode || !inviteCode.trim()}
                  className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold transition-colors cursor-pointer shrink-0"
                >
                  {isJoiningByCode ? 'Joining...' : 'Join Now'}
                </button>
              </div>
              {codeError && (
                <div className="text-[11px] text-rose-600 dark:text-rose-400">
                  {codeError}
                </div>
              )}
            </form>

            <div className="relative flex items-center py-1">
              <div className="grow border-t border-slate-200 dark:border-slate-800" />
              <span className="shrink mx-3 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                or
              </span>
              <div className="grow border-t border-slate-200 dark:border-slate-800" />
            </div>

            {/* Option 2: Request Admin Approval */}
            {activeRequest && activeRequest.status === 'pending' ? (
              <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Access Request Sent</span>
                </div>
                <p className="text-[11px] text-emerald-700 dark:text-emerald-300/90 leading-relaxed">
                  Your workspace administrator can approve you in{' '}
                  <strong>Admin Panel → Team & Collaboration</strong>. This page will unlock automatically once approved.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSendJoinRequest} className="space-y-2.5">
                <label className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
                  <Users className="w-3.5 h-3.5 text-indigo-500" />
                  <span>Request Access from Workspace Admin</span>
                </label>
                <input
                  type="text"
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  placeholder="Optional note (e.g. role or team)"
                  maxLength={250}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                />
                {requestError && (
                  <div className="text-[11px] text-rose-600 dark:text-rose-400">
                    {requestError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmittingRequest}
                  className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 font-semibold transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5 text-indigo-500" />
                  <span>
                    {isSubmittingRequest ? 'Sending Request...' : 'Request Collaborator Access'}
                  </span>
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
