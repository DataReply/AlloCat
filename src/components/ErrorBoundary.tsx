import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  errorDetail: string | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
      errorDetail: null
    };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const raw = error instanceof Error ? error.message : String(error);
    let parsedMessage = raw;
    let parsedDetail: string | null = null;

    try {
      const json = JSON.parse(raw) as {
        error?: string;
        operationType?: string;
        path?: string | null;
      };
      if (json && typeof json.error === 'string') {
        parsedMessage = json.error;
        parsedDetail = `${json.operationType || 'operation'} on ${json.path || 'database'}`;
      }
    } catch {
      // plain error string
    }

    return {
      hasError: true,
      errorMessage: parsedMessage,
      errorDetail: parsedDetail
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-950 text-slate-100">
          <div className="max-w-lg w-full rounded-2xl border border-rose-800/70 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base font-bold text-slate-100">
                  Workspace Sync Error
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  An unexpected error occurred while syncing collaborative data.
                </p>
              </div>
            </div>

            {this.state.errorDetail && (
              <div className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-mono text-amber-300 break-all">
                {this.state.errorDetail}
              </div>
            )}

            <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-900/60 text-xs text-rose-200 break-words font-mono">
              {this.state.errorMessage || 'Unknown application error'}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reload Workspace</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
