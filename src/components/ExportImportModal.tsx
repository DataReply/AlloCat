import React, { useRef, useState, useEffect } from 'react';
import {
  X,
  Download,
  Upload,
  FileSpreadsheet,
  FileJson,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Globe,
  Sparkles,
  Users,
  Briefcase,
  CalendarOff,
  Armchair,
  Layers,
  ShieldCheck,
  MonitorDown,
  Database,
  FileCode2,
  ChevronDown,
  ChevronUp,
  Play,
  HardDrive
} from 'lucide-react';
import { ViewMode, DEFAULT_LEAVE_TYPE_CONFIG } from '../types';
import { AppState } from '../data/seedData';
import {
  ExportScope,
  ImportMergeMode,
  generatePeopleViewCSV,
  generateClientsViewCSV,
  generateAvailabilityViewCSV,
  generateBenchViewCSV,
  generateAdminDirectoriesCSV,
  generateAllViewsCSV,
  generateViewJSON,
  generateTemplateCSV,
  importDataFromFileContent,
  triggerFileDownload
} from '../utils/importExportUtils';
import {
  SQLITE_RELATIONAL_SCHEMA_DDL,
  SQLiteDatabaseStats,
  getSQLiteDatabaseStats,
  syncAppStateToSQLite,
  exportSQLiteBinaryFile,
  exportSQLiteBase64Snapshot,
  exportSQLDumpScript,
  importSQLiteBinaryFile,
  importSQLDumpScript,
  isSQLiteBinaryHeader,
  runReadOnlySQLQuery
} from '../utils/sqliteDatabase';

interface ExportImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  appState: AppState;
  activeViewMode?: ViewMode;
  initialScope?: ExportScope;
  onImportState: (newState: AppState) => void;
  onResetToDefault: () => void;
  onOpenStandaloneModal?: () => void;
}

const SCOPE_TABS: Array<{
  id: ExportScope;
  label: string;
  shortLabel: string;
  description: string;
  csvColumnsHint: string;
  icon: React.FC<{ className?: string }>;
}> = [
  {
    id: 'all',
    label: 'All Tabs (Full Workspace)',
    shortLabel: 'All Tabs',
    description:
      'Complete workspace backup and multi-view master spreadsheet covering Clients, Projects, People, Allocations, Custom Leave Types, Scheduled Leaves, Departments, and Years.',
    csvColumnsHint:
      'Year, Record Type (Department / Leave Type / Client / Project / Person / Allocation / Leave), First Name, Last Name, Role, Department, Employment, Client, Client Status, Project, Leave Category, Leave Type Label, Badge Theme, Impact %, Jan..Dec',
    icon: Layers
  },
  {
    id: 'clients',
    label: 'By Clients & Projects View',
    shortLabel: 'Clients & Projects',
    description:
      'Client portfolios, deliverable projects, scope notes, monthly FTE totals, and assigned staff breakdowns.',
    csvColumnsHint:
      'Year, Row Type, Client, Industry, Project, Project Code, Project Status, Billable, Project Scope Comment, First Name, Last Name, Role, Department, Employment, Assignment Note, Jan..Dec',
    icon: Briefcase
  },
  {
    id: 'people',
    label: 'By People View',
    shortLabel: 'By People',
    description:
      'Team member capacity summaries, employment type, staffing comments, and project allocation rows across all 12 months.',
    csvColumnsHint:
      'Year, Row Type, First Name, Last Name, Role, Department, Employment (Internal/External/B2B), Max Capacity %, Person Comment, Client, Project, Project Code, Assignment Note, Jan..Dec',
    icon: Users
  },
  {
    id: 'availability',
    label: 'Availability & Leaves View',
    shortLabel: 'Availability & Leaves',
    description:
      'Custom & default Time Off / Leave Type definitions, effective monthly working capacities, and scheduled leave entries.',
    csvColumnsHint:
      'Year, Row Type (Leave Type / Effective Capacity / Leave Entry), First Name, Last Name, Role, Department, Employment, Max Capacity %, Leave Category, Leave Type Label, Badge Theme, Leave Title, Start Month, End Month, Impact %, Leave Note, Jan..Dec',
    icon: CalendarOff
  },
  {
    id: 'bench',
    label: 'Bench View',
    shortLabel: 'Bench',
    description:
      'Unallocated bench capacity percentages, free months count, and team member skills / bench notes.',
    csvColumnsHint:
      'Year, Row Type, First Name, Last Name, Role, Department, Employment (Internal/External/B2B), Email, Max Capacity %, Skills & Bench Comment, Avg Bench %, Free Months, Jan..Dec',
    icon: Armchair
  },
  {
    id: 'admin',
    label: 'Admin Panel & Directories',
    shortLabel: 'Admin & Directories',
    description:
      'Centralized Admin Control Panel directories: Departments, Custom Time Off & Leave Types, Client Companies, Deliverable Projects, Team Members, and Scheduled Leaves.',
    csvColumnsHint:
      'Year, Record Type (Department / Leave Type / Client / Project / Person / Leave), First Name, Last Name, Role, Department, Employment, Email, Max Capacity %, Client, Industry, Client Status, Project, Project Code, Leave Category, Leave Type Label, Badge Theme, Impact %',
    icon: ShieldCheck
  }
];

function triggerBinaryDownload(bytes: Uint8Array, filename: string, mimeType: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const ExportImportModal: React.FC<ExportImportModalProps> = ({
  isOpen,
  onClose,
  appState,
  activeViewMode = 'clients',
  initialScope,
  onImportState,
  onResetToDefault,
  onOpenStandaloneModal
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedScope, setSelectedScope] = useState<ExportScope>(
    initialScope || activeViewMode || 'all'
  );
  const [mergeMode, setMergeMode] = useState<ImportMergeMode>('merge');
  const [status, setStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [isBundlingHtml, setIsBundlingHtml] = useState(false);
  const [isExportingSqlite, setIsExportingSqlite] = useState(false);
  const [sqliteStats, setSqliteStats] = useState<SQLiteDatabaseStats>(() =>
    getSQLiteDatabaseStats(appState)
  );
  const [showSchemaInspector, setShowSchemaInspector] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'ddl' | 'query'>('ddl');
  const [sqlQueryText, setSqlQueryText] = useState<string>(
    `SELECT person_name, department, client_name, project_code, annual_avg_pct\nFROM v_allocation_months\nWHERE year = ${appState.selectedYear}\nORDER BY annual_avg_pct DESC\nLIMIT 12;`
  );
  const [sqlQueryResult, setSqlQueryResult] = useState<{
    columns: string[];
    rows: unknown[][];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedScope(initialScope || activeViewMode || 'all');
      setStatus(null);
      setSqlQueryResult(null);
      syncAppStateToSQLite(appState).then((stats) => setSqliteStats(stats));
    }
  }, [isOpen, initialScope, activeViewMode, appState]);

  if (!isOpen) return null;

  const currentTabConfig =
    SCOPE_TABS.find((t) => t.id === selectedScope) || SCOPE_TABS[0];
  const dateStr = new Date().toISOString().slice(0, 10);
  const leaveTypesCount = Object.keys(
    appState.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG
  ).length;

  const formattedSizeKb =
    sqliteStats.byteSize > 0
      ? `${(sqliteStats.byteSize / 1024).toFixed(1)} KB`
      : 'Syncing...';

  const handleExportSQLiteBinary = async () => {
    setIsExportingSqlite(true);
    setStatus(null);
    try {
      const bytes = await exportSQLiteBinaryFile(appState);
      setSqliteStats(getSQLiteDatabaseStats(appState));
      triggerBinaryDownload(
        bytes,
        `allocat-workspace-${dateStr}.sqlite`,
        'application/vnd.sqlite3'
      );
      setStatus({
        type: 'success',
        message: `Exported binary SQLite 3 database (allocat-workspace-${dateStr}.sqlite, ${(
          bytes.byteLength / 1024
        ).toFixed(1)} KB) with all 10 relational tables and analytical views.`
      });
    } catch (err) {
      setStatus({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to export SQLite database binary.'
      });
    } finally {
      setIsExportingSqlite(false);
    }
  };

  const handleExportSQLDump = () => {
    setStatus(null);
    try {
      const script = exportSQLDumpScript(appState);
      triggerFileDownload(
        script,
        `allocat-database-${dateStr}.sql`,
        'application/sql;charset=utf-8'
      );
      setStatus({
        type: 'success',
        message: `Exported normalized SQLite DDL & INSERT script (allocat-database-${dateStr}.sql) covering all ${appState.people.length} people, ${appState.projects.length} projects, and ${appState.allocations.length} allocations.`
      });
    } catch (err) {
      setStatus({
        type: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to generate .sql script dump.'
      });
    }
  };

  const handleRunInspectorQuery = async () => {
    try {
      const res = await runReadOnlySQLQuery(sqlQueryText);
      setSqlQueryResult({ columns: res.columns, rows: res.rows });
    } catch (err) {
      setSqlQueryResult({
        columns: [],
        rows: [],
        error: err instanceof Error ? err.message : 'Failed to execute SQL query.'
      });
    }
  };

  // Download self-contained single-file HTML browser app with current state embedded
  const handleDownloadStandaloneHTML = async () => {
    setIsBundlingHtml(true);
    setStatus(null);
    try {
      const fetchAssetText = async (paths: string[]) => {
        for (const p of paths) {
          try {
            const res = await fetch(p);
            if (res.ok) {
              const text = await res.text();
              if (text && !text.trim().startsWith('<!DOCTYPE html>')) {
                return text;
              }
            }
          } catch {
            // try next path
          }
        }
        return null;
      };

      const cssText = await fetchAssetText([
        './assets/app.css',
        './docs/assets/app.css',
        '/AlloCat/assets/app.css',
        '/AlloCat/docs/assets/app.css'
      ]);
      const jsText = await fetchAssetText([
        './assets/app.js',
        './docs/assets/app.js',
        '/AlloCat/assets/app.js',
        '/AlloCat/docs/assets/app.js'
      ]);

      if (!jsText) {
        throw new Error('Compiled bundle not found');
      }

      const sqliteBase64 = await exportSQLiteBase64Snapshot(appState);

      const standaloneHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AlloCat — Resource & Capacity Planner (${dateStr})</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${cssText || ''}</style>
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 antialiased selection:bg-indigo-600 selection:text-white">
  <div id="root"></div>
  <script>window.__ALLOCAT_EMBEDDED_SQLITE__ = ${JSON.stringify(sqliteBase64)};</script>
  <script type="module">${jsText}</script>
</body>
</html>`;

      triggerFileDownload(
        standaloneHtml,
        `AlloCat-Browser-App-${dateStr}.html`,
        'text/html;charset=utf-8'
      );

      setStatus({
        type: 'success',
        message:
          'Standalone browser app downloaded! Double-click that .html file to run AlloCat directly in any browser with your current data.'
      });
    } catch {
      setStatus({
        type: 'error',
        message: 'Could not bundle standalone HTML file. Please use SQLite, JSON, or CSV export below.'
      });
    } finally {
      setIsBundlingHtml(false);
    }
  };

  const handleExportScopeCSV = (scope: ExportScope) => {
    const yr = appState.selectedYear;
    if (scope === 'people') {
      const csv = generatePeopleViewCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-by-people-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported "By People" view (${appState.people.length} team members) to CSV.`
      });
    } else if (scope === 'clients') {
      const csv = generateClientsViewCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-by-clients-projects-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported "By Clients & Projects" view (${appState.clients.length} clients, ${appState.projects.length} projects) to CSV.`
      });
    } else if (scope === 'availability') {
      const csv = generateAvailabilityViewCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-availability-leaves-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported "Availability & Leaves" view (${leaveTypesCount} leave types, ${appState.leaves.filter((l) => l.year === yr).length} scheduled leaves) to CSV.`
      });
    } else if (scope === 'bench') {
      const csv = generateBenchViewCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-bench-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported "Bench" availability view (${appState.people.length} team members) to CSV.`
      });
    } else if (scope === 'admin') {
      const csv = generateAdminDirectoriesCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-admin-directories-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported "Admin & Directories" CSV (${appState.departments.length} departments, ${leaveTypesCount} leave types, ${appState.clients.length} clients, ${appState.projects.length} projects, ${appState.people.length} people).`
      });
    } else {
      const csv = generateAllViewsCSV(appState);
      triggerFileDownload(
        csv,
        `allocat-all-views-master-${yr}-${dateStr}.csv`,
        'text/csv;charset=utf-8;'
      );
      setStatus({
        type: 'success',
        message: `Exported All Views Master CSV (${appState.departments.length} departments, ${leaveTypesCount} leave types, ${appState.clients.length} clients, ${appState.projects.length} projects, ${appState.people.length} people, ${appState.allocations.length} allocations, ${appState.leaves.length} leaves).`
      });
    }
  };

  const handleExportScopeJSON = (scope: ExportScope) => {
    const yr = appState.selectedYear;
    const json = generateViewJSON(appState, scope);
    const filename =
      scope === 'all'
        ? `allocat-full-backup-${dateStr}.json`
        : scope === 'admin'
        ? `allocat-admin-directories-${yr}-${dateStr}.json`
        : `allocat-${scope}-${yr}-${dateStr}.json`;

    triggerFileDownload(json, filename, 'application/json');
    setStatus({
      type: 'success',
      message:
        scope === 'all'
          ? 'Exported Full Workspace Backup (.JSON) including all views, departments, and custom leave types.'
          : `Exported "${currentTabConfig.shortLabel}" data (.JSON).`
    });
  };

  const handleDownloadTemplateCSV = (
    scope: ExportScope,
    includeExampleRows: boolean = true
  ) => {
    const yr = appState.selectedYear;
    const csv = generateTemplateCSV(scope, yr, includeExampleRows);
    const tabInfo = SCOPE_TABS.find((t) => t.id === scope) || SCOPE_TABS[0];
    const suffix = includeExampleRows ? 'example-template' : 'empty-template';
    const scopeSlug =
      scope === 'all'
        ? 'all-views'
        : scope === 'clients'
        ? 'clients-projects'
        : scope === 'availability'
        ? 'availability-leaves'
        : scope === 'admin'
        ? 'admin-directories'
        : scope;

    triggerFileDownload(
      csv,
      `allocat-${scopeSlug}-${suffix}-${yr}.csv`,
      'text/csv;charset=utf-8;'
    );
    setStatus({
      type: 'success',
      message: includeExampleRows
        ? `Downloaded pre-built "${tabInfo.shortLabel}" example template (.CSV). Fill in your rows and import it below!`
        : `Downloaded empty "${tabInfo.shortLabel}" template (.CSV) with headers ready to fill.`
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const reader = new FileReader();

    reader.onload = async (event) => {
      try {
        const buffer = event.target?.result as ArrayBuffer;
        if (!buffer) {
          throw new Error('Could not read uploaded file contents.');
        }
        const bytes = new Uint8Array(buffer);

        if (
          lowerName.endsWith('.sqlite') ||
          lowerName.endsWith('.db') ||
          lowerName.endsWith('.sqlite3') ||
          isSQLiteBinaryHeader(bytes)
        ) {
          const result = await importSQLiteBinaryFile(bytes, appState, mergeMode);
          onImportState(result.nextState);
          setSqliteStats(getSQLiteDatabaseStats(result.nextState));
          setStatus({
            type: 'success',
            message: result.summaryMessage
          });
          return;
        }

        const text = new TextDecoder('utf-8').decode(bytes);
        if (lowerName.endsWith('.sql')) {
          const result = await importSQLDumpScript(text, appState, mergeMode);
          onImportState(result.nextState);
          setSqliteStats(getSQLiteDatabaseStats(result.nextState));
          setStatus({
            type: 'success',
            message: result.summaryMessage
          });
          return;
        }

        const result = importDataFromFileContent(
          text,
          file.name,
          appState,
          selectedScope,
          mergeMode
        );
        onImportState(result.nextState);
        const updatedStats = await syncAppStateToSQLite(result.nextState);
        setSqliteStats(updatedStats);
        setStatus({
          type: 'success',
          message: result.summaryMessage
        });
      } catch (err) {
        setStatus({
          type: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to parse file. Upload a valid .SQLITE, .DB, .SQL, .CSV, or .JSON file.'
        });
      }
    };

    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-4xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                SQLite Database, Import & Export Center ({appState.selectedYear})
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Normalized in-browser SQLite 3 relational storage alongside CSV spreadsheets and JSON backups
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scope Selector Tabs */}
        <div className="px-5 pt-3 pb-2.5 bg-slate-50/60 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Select Module / View for CSV & JSON:
            </span>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.clients.length} Clients
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.projects.length} Projects
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.people.length} People
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.departments.length} Depts
              </span>
              <span className="px-1.5 py-0.5 rounded bg-purple-100/80 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300">
                {leaveTypesCount} Leave Types
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SCOPE_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = selectedScope === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setSelectedScope(tab.id);
                    setStatus(null);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                    isActive
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs font-semibold'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.shortLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {status && (
            <div
              className={`p-3 rounded-lg border flex items-start gap-2.5 text-xs ${
                status.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                  : 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-200'
              }`}
            >
              {status.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              )}
              <span className="font-medium">{status.message}</span>
            </div>
          )}

          {/* SQLite Relational Database Engine & Schema Hub */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/80 space-y-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                    <span>SQLite Relational Storage Engine</span>
                  </h3>
                  <span className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800">
                    {sqliteStats.engineLabel}
                  </span>
                  <span className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center gap-1">
                    <HardDrive className="w-2.5 h-2.5" />
                    <span>{formattedSizeKb}</span>
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  All edits automatically synchronize into 10 normalized relational tables persisted locally in IndexedDB and compatible with standard SQLite 3 desktop tools.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowSchemaInspector((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-500 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <FileCode2 className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>Schema & SQL Inspector</span>
                {showSchemaInspector ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {/* Live Table Row Counts */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {sqliteStats.tables.map((t) => (
                <div
                  key={t.tableName}
                  className="px-2 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700/70 flex flex-col"
                >
                  <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {t.tableName}
                  </span>
                  <span className="text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {t.rowCount}
                  </span>
                </div>
              ))}
            </div>

            {/* Expandable Schema DDL & Live Read-Only Query Inspector */}
            {showSchemaInspector && (
              <div className="rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div className="px-3 py-2 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setInspectorTab('ddl')}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
                        inspectorTab === 'ddl'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                      }`}
                    >
                      Relational Schema (DDL + Views)
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectorTab('query')}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
                        inspectorTab === 'query'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
                      }`}
                    >
                      SQL Query Console
                    </button>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                    PRAGMA foreign_keys = ON
                  </span>
                </div>

                {inspectorTab === 'ddl' ? (
                  <pre className="p-3 text-[11px] font-mono leading-relaxed text-slate-700 dark:text-slate-300 overflow-x-auto max-h-60 overflow-y-auto">
                    {SQLITE_RELATIONAL_SCHEMA_DDL}
                  </pre>
                ) : (
                  <div className="p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                        Presets:
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSqlQueryText(
                            `SELECT person_name, department, client_name, project_code, annual_avg_pct\nFROM v_allocation_months\nWHERE year = ${appState.selectedYear}\nORDER BY annual_avg_pct DESC\nLIMIT 12;`
                          )
                        }
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-500 border border-slate-200 dark:border-slate-700 cursor-pointer"
                      >
                        v_allocation_months
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSqlQueryText(
                            `SELECT full_name, department, employment_type, avg_allocated_pct, max_capacity_percent\nFROM v_person_annual_summary\nWHERE year = ${appState.selectedYear}\nORDER BY avg_allocated_pct DESC;`
                          )
                        }
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-500 border border-slate-200 dark:border-slate-700 cursor-pointer"
                      >
                        v_person_annual_summary
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSqlQueryText(
                            `SELECT c.name AS client, COUNT(p.id) AS projects\nFROM clients c\nLEFT JOIN projects p ON p.client_id = c.id\nGROUP BY c.id\nORDER BY projects DESC;`
                          )
                        }
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-500 border border-slate-200 dark:border-slate-700 cursor-pointer"
                      >
                        clients_summary
                      </button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <textarea
                        value={sqlQueryText}
                        onChange={(e) => setSqlQueryText(e.target.value)}
                        rows={4}
                        className="flex-1 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-mono text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-500"
                        placeholder="SELECT * FROM people LIMIT 10;"
                      />
                      <button
                        type="button"
                        onClick={handleRunInspectorQuery}
                        className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer shrink-0 self-start"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Run SELECT</span>
                      </button>
                    </div>

                    {sqlQueryResult?.error && (
                      <div className="p-2 rounded bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-[11px] text-rose-700 dark:text-rose-200 font-mono">
                        {sqlQueryResult.error}
                      </div>
                    )}

                    {sqlQueryResult && !sqlQueryResult.error && (
                      <div className="overflow-x-auto max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                        {sqlQueryResult.columns.length === 0 ? (
                          <div className="p-2.5 text-[11px] text-slate-500 dark:text-slate-400">
                            Query returned 0 rows.
                          </div>
                        ) : (
                          <table className="w-full text-left border-collapse text-[11px] font-mono tabular-nums">
                            <thead className="bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300">
                              <tr>
                                {sqlQueryResult.columns.map((col) => (
                                  <th
                                    key={col}
                                    className="px-2.5 py-1.5 border-b border-slate-200 dark:border-slate-800 font-semibold whitespace-nowrap"
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sqlQueryResult.rows.map((row, idx) => (
                                <tr
                                  key={idx}
                                  className="odd:bg-white even:bg-slate-50/70 dark:odd:bg-slate-950 dark:even:bg-slate-900/50"
                                >
                                  {row.map((val, cIdx) => (
                                    <td
                                      key={cIdx}
                                      className="px-2.5 py-1 border-b border-slate-100 dark:border-slate-800/60 text-slate-700 dark:text-slate-300 whitespace-nowrap"
                                    >
                                      {val === null || val === undefined ? 'NULL' : String(val)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* SQLite Binary & SQL Script Export Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isExportingSqlite}
                onClick={handleExportSQLiteBinary}
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-500 disabled:opacity-50 text-left transition-all cursor-pointer group"
              >
                <div className="w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <Database className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {isExportingSqlite
                      ? 'Building Binary Database...'
                      : 'Export SQLite Database (.SQLITE)'}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Native SQLite 3 binary file compatible with DB Browser, DBeaver, and CLI.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={handleExportSQLDump}
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-violet-500 dark:hover:border-violet-500 text-left transition-all cursor-pointer group"
              >
                <div className="w-9 h-9 rounded-lg bg-violet-100 dark:bg-violet-950 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <FileCode2 className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Export SQL Script Dump (.SQL)
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Human-readable DDL schema + INSERT statements for Git diffs & audits.
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Selected Scope Banner & Export Actions (CSV + JSON) */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide flex items-center gap-2">
                  <span>Export: {currentTabConfig.label}</span>
                  <span className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
                    {appState.selectedYear}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  {currentTabConfig.description}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleExportScopeCSV(selectedScope)}
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-500 text-left transition-all cursor-pointer group"
              >
                <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Export {currentTabConfig.shortLabel} (.CSV)
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Spreadsheet table ready for Excel, Google Sheets, or re-importing.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleExportScopeJSON(selectedScope)}
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-500 text-left transition-all cursor-pointer group"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  <FileJson className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Export {currentTabConfig.shortLabel} (.JSON)
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Structured JSON data for {currentTabConfig.shortLabel.toLowerCase()}.
                  </p>
                </div>
              </button>
            </div>

            {/* Quick 1-click CSV buttons for all individual modules when on "All Tabs" */}
            {selectedScope === 'all' && (
              <div className="pt-2 border-t border-slate-200/80 dark:border-slate-700/70">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
                  Or quick-export individual module spreadsheets (.CSV):
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {(
                    [
                      { id: 'clients', label: 'Clients & Projects' },
                      { id: 'people', label: 'By People' },
                      { id: 'availability', label: 'Leaves & Types' },
                      { id: 'bench', label: 'Bench View' },
                      { id: 'admin', label: 'Admin Directories' }
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleExportScopeCSV(item.id)}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-500 text-slate-700 dark:text-slate-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Unified Import Section (.SQLITE, .DB, .SQL, .CSV, .JSON) */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Unified Import (.SQLITE / .DB / .SQL / .CSV / .JSON)
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Upload any SQLite binary (<code className="font-mono">.sqlite</code>,{' '}
                  <code className="font-mono">.db</code>), <code className="font-mono">.sql</code> dump script,{' '}
                  <code className="font-mono">.csv</code> spreadsheet, or <code className="font-mono">.json</code> backup into{' '}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {currentTabConfig.shortLabel}
                  </span>
                  .
                </p>
              </div>

              {/* Merge vs Replace toggle */}
              <div className="flex items-center bg-white dark:bg-slate-900 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMergeMode('merge')}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    mergeMode === 'merge'
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                  title="Update matching rows and add new ones without deleting unrelated records"
                >
                  Merge & Update
                </button>
                <button
                  type="button"
                  onClick={() => setMergeMode('replace')}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    mergeMode === 'replace'
                      ? 'bg-amber-600 text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                  title="Replace existing records with the imported database or file"
                >
                  Replace Existing
                </button>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-700/70 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              <span className="font-semibold text-slate-700 dark:text-slate-300 font-sans">
                Supported CSV columns:{' '}
              </span>
              {currentTabConfig.csvColumnsHint}
            </div>

            {/* Pre-built CSV Template Downloads inside Import Section */}
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Pre-built CSV Import Templates ({currentTabConfig.shortLabel})</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Download a ready-to-fill CSV template with the exact column headers for this module.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplateCSV(selectedScope, true)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80 flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Download CSV template pre-populated with example rows showing the format"
                  >
                    <Download className="w-3 h-3" />
                    <span>Example Template (.CSV)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadTemplateCSV(selectedScope, false)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Download blank CSV template containing only the column headers"
                  >
                    <Download className="w-3 h-3" />
                    <span>Empty Headers (.CSV)</span>
                  </button>
                </div>
              </div>

              {/* Quick links for all tab templates */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mr-1">
                  All module templates:
                </span>
                {SCOPE_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleDownloadTemplateCSV(t.id, true)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer flex items-center gap-1 ${
                      selectedScope === t.id
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
                        : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-blue-400'
                    }`}
                    title={`Download ${t.label} example CSV template`}
                  >
                    <Download className="w-2.5 h-2.5" />
                    <span>{t.shortLabel}</span>
                  </button>
                ))}
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".sqlite,.db,.sqlite3,.sql,.csv,.json,text/csv,application/json"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 px-4 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-400 bg-white/50 dark:bg-slate-900/40 flex items-center justify-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer transition-colors"
            >
              <Upload className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>
                Select .SQLITE, .DB, .SQL, .CSV, or .JSON File to Import ({mergeMode === 'merge' ? 'Merge & Update' : 'Replace Existing'})
              </span>
            </button>
          </div>

          {/* Standalone Single-File Browser App & Windows Desktop App Center */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 text-white border border-indigo-500/30 shadow-md">
            <div className="flex items-start gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/20 border border-indigo-400/30 text-indigo-300 flex items-center justify-center shrink-0">
                <Globe className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">
                    Portable Offline Browser File & Windows Desktop App
                  </h3>
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-200 border border-indigo-400/30 flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" /> Standalone
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                  Bundle AlloCat and your current workspace state (including custom leave types and departments) into a single self-contained{' '}
                  <code className="text-indigo-200 font-mono">.html</code> file, or open the Windows Desktop App installer center.
                </p>
              </div>
            </div>

            <div className="mt-3.5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={isBundlingHtml}
                onClick={handleDownloadStandaloneHTML}
                className="py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>
                  {isBundlingHtml
                    ? 'Bundling Standalone HTML...'
                    : 'Download Single-File App (.html)'}
                </span>
              </button>

              {onOpenStandaloneModal && (
                <button
                  type="button"
                  onClick={onOpenStandaloneModal}
                  className="py-2.5 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-200 border border-indigo-400/30 font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <MonitorDown className="w-4 h-4 text-indigo-400" />
                  <span>Windows Desktop App Center</span>
                </button>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                onResetToDefault();
                setStatus({
                  type: 'success',
                  message: 'Workspace and SQLite database reset to default demo data.'
                });
              }}
              className="text-xs font-medium text-slate-500 hover:text-rose-600 flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset to Default Demo Data</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
