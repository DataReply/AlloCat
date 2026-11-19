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
  HardDrive,
  Table2,
  KeyRound,
  Link2
} from 'lucide-react';
import { ViewMode, DEFAULT_LEAVE_TYPE_CONFIG } from '../types';
import { AppState } from '../data/seedData';
import {
  ExportScope,
  ImportMergeMode,
  SQLITE_TABLE_SCHEMAS,
  SQLiteTableName,
  isTableScope,
  tableScopeToTableName,
  generateViewCSV,
  generateViewJSON,
  generateTemplateCSV,
  generateTemplateJSON,
  importDataFromFileContent,
  triggerFileDownload,
  triggerBinaryDownload
} from '../utils/importExportUtils';
import {
  SQLITE_RELATIONAL_SCHEMA_DDL,
  SQLiteDatabaseStats,
  getSQLiteDatabaseStats,
  syncAppStateToSQLite,
  exportSQLiteBinaryFile,
  exportSQLDumpScript,
  buildStandalonePortableHtml,
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

const VIEW_SCOPE_TABS: Array<{
  id: Exclude<ExportScope, `table_${string}`>;
  label: string;
  shortLabel: string;
  description: string;
  csvColumnsHint: string;
  icon: React.FC<{ className?: string }>;
}> = [
  {
    id: 'all',
    label: 'Full Workspace (All 8 Tables)',
    shortLabel: 'All Tables',
    description:
      'Complete relational export & import across planning_years, departments, leave_types, clients, projects, people, allocations, and leaves with preserved PK/FK IDs.',
    csvColumnsHint:
      'table_name, id, year, is_selected, sort_order, person_id, first_name, last_name, full_name, role, department, employment_type, max_capacity_percent, client_id, client_name, project_id, project_name, code, billable, jan..dec, jan_status..dec_status, leave_type, start_month (0..11), end_month (0..11), impact_percent, notes',
    icon: Layers
  },
  {
    id: 'clients',
    label: 'Clients & Projects Matrix',
    shortLabel: 'Clients & Projects',
    description:
      'Client portfolios, project_summary totals, and staff allocation rows with monthly statuses (unknown, planned, confirmed) keyed by client_id, project_id, and person_id.',
    csvColumnsHint:
      'table_name, id, year, client_id, client_name, industry, project_id, project_name, code, project_status, billable (1/0), person_id, first_name, last_name, full_name, role, department, employment_type, annual_avg_pct, jan..dec, jan_status..dec_status, notes',
    icon: Briefcase
  },
  {
    id: 'people',
    label: 'People & Assignments Matrix',
    shortLabel: 'By People',
    description:
      'Person monthly capacity & status summaries (unknown, planned, confirmed, mixed) alongside project allocation rows keyed by person_id and project_id.',
    csvColumnsHint:
      'table_name, id, year, person_id, first_name, last_name, full_name, role, department, employment_type, email, max_capacity_percent, client_id, client_name, project_id, project_name, code, annual_avg_pct, jan..dec, jan_status..dec_status, notes',
    icon: Users
  },
  {
    id: 'availability',
    label: 'Availability & Leaves Matrix',
    shortLabel: 'Availability & Leaves',
    description:
      'Configured leave_types, effective monthly working capacities, and scheduled leave rows using 0-based start_month/end_month (0..11).',
    csvColumnsHint:
      'table_name, id, year, person_id, first_name, last_name, full_name, leave_type, label, badge_class, icon_name, default_impact, title, start_month (0..11), end_month (0..11), impact_percent, jan..dec, notes',
    icon: CalendarOff
  },
  {
    id: 'bench',
    label: 'Bench Availability View',
    shortLabel: 'Bench',
    description:
      'Unallocated monthly bench percentages, free months counts, and person_id roster metadata.',
    csvColumnsHint:
      'table_name, id, year, person_id, first_name, last_name, full_name, role, department, employment_type, email, max_capacity_percent, avg_bench_pct, free_months_count, jan..dec, notes',
    icon: Armchair
  },
  {
    id: 'admin',
    label: 'Admin Directories (No Matrix Facts)',
    shortLabel: 'Admin Directories',
    description:
      'Core relational directories without monthly allocation rows: planning_years, departments, leave_types, clients, projects, people, and leaves.',
    csvColumnsHint:
      'table_name, id, year, is_selected, sort_order, person_id, first_name, last_name, full_name, department, client_id, client_name, project_id, code, billable, leave_type, label, badge_class, start_month, end_month, impact_percent, notes',
    icon: ShieldCheck
  }
];

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
  const [scopeGroup, setScopeGroup] = useState<'tables' | 'views'>(() =>
    initialScope && isTableScope(initialScope) ? 'tables' : 'tables'
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
    `SELECT person_name, project_code, jan, jan_status, feb, feb_status, annual_avg_pct\nFROM v_allocation_months\nWHERE year = ${appState.selectedYear}\nORDER BY annual_avg_pct DESC\nLIMIT 12;`
  );
  const [sqlQueryResult, setSqlQueryResult] = useState<{
    columns: string[];
    rows: unknown[][];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      const nextInitial = initialScope || activeViewMode || 'all';
      setSelectedScope(nextInitial);
      setScopeGroup(isTableScope(nextInitial) ? 'tables' : 'views');
      setStatus(null);
      setSqlQueryResult(null);
      syncAppStateToSQLite(appState).then((stats) => setSqliteStats(stats));
    }
  }, [isOpen, initialScope, activeViewMode, appState]);

  if (!isOpen) return null;

  const isSelectedTable = isTableScope(selectedScope);
  const activeTableSchema = isSelectedTable
    ? SQLITE_TABLE_SCHEMAS.find((t) => t.scope === selectedScope) || SQLITE_TABLE_SCHEMAS[0]
    : null;
  const activeViewConfig = !isSelectedTable
    ? VIEW_SCOPE_TABS.find((t) => t.id === selectedScope) || VIEW_SCOPE_TABS[0]
    : null;

  const activeScopeTitle = activeTableSchema
    ? `Table: ${activeTableSchema.tableName}`
    : activeViewConfig?.label || 'Full Workspace';
  const activeScopeShort = activeTableSchema
    ? activeTableSchema.tableName
    : activeViewConfig?.shortLabel || 'All Tables';
  const activeScopeDescription = activeTableSchema
    ? activeTableSchema.description
    : activeViewConfig?.description || '';
  const activeColumnsHint = activeTableSchema
    ? activeTableSchema.columns.join(', ')
    : activeViewConfig?.csvColumnsHint || '';

  const dateStr = new Date().toISOString().slice(0, 10);
  const leaveTypesCount = Object.keys(
    appState.leaveTypes || DEFAULT_LEAVE_TYPE_CONFIG
  ).length;

  const formattedSizeKb =
    sqliteStats.byteSize > 0
      ? `${(sqliteStats.byteSize / 1024).toFixed(1)} KB`
      : 'Syncing...';

  const getRowCountForTable = (tableName: SQLiteTableName): number => {
    const stat = sqliteStats.tables.find((t) => t.tableName === tableName);
    if (stat) return stat.rowCount;
    switch (tableName) {
      case 'people':
        return appState.people.length;
      case 'clients':
        return appState.clients.length;
      case 'projects':
        return appState.projects.length;
      case 'allocations':
        return appState.allocations.length;
      case 'leaves':
        return appState.leaves.length;
      case 'departments':
        return appState.departments.length;
      case 'leave_types':
        return leaveTypesCount;
      case 'planning_years':
        return appState.availableYears.length;
    }
  };

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

  const handleDownloadStandaloneHTML = async () => {
    setIsBundlingHtml(true);
    setStatus(null);
    try {
      const standaloneHtml = await buildStandalonePortableHtml(appState);

      triggerFileDownload(
        standaloneHtml,
        `AlloCat-Browser-App-${dateStr}.html`,
        'text/html;charset=utf-8'
      );

      setStatus({
        type: 'success',
        message:
          'Standalone browser app downloaded! Double-click that .html file to run AlloCat directly in any browser with your current SQLite database embedded.'
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

  const getScopeFileSlug = (scope: ExportScope): string => {
    if (isTableScope(scope)) {
      return `table-${tableScopeToTableName(scope)}`;
    }
    if (scope === 'all') return 'all-tables-master';
    if (scope === 'clients') return 'clients-projects';
    if (scope === 'availability') return 'availability-leaves';
    if (scope === 'admin') return 'admin-directories';
    return scope;
  };

  const handleExportScopeCSV = (scope: ExportScope) => {
    const yr = appState.selectedYear;
    const csv = generateViewCSV(appState, scope);
    const slug = getScopeFileSlug(scope);
    triggerFileDownload(
      csv,
      `allocat-${slug}-${yr}-${dateStr}.csv`,
      'text/csv;charset=utf-8;'
    );
    if (isTableScope(scope)) {
      const tbl = tableScopeToTableName(scope);
      setStatus({
        type: 'success',
        message: `Exported SQLite table "${tbl}" (${getRowCountForTable(tbl)} rows) with exact schema columns to CSV.`
      });
    } else {
      const tabCfg = VIEW_SCOPE_TABS.find((t) => t.id === scope);
      setStatus({
        type: 'success',
        message: `Exported "${tabCfg?.shortLabel || scope}" relational CSV (${yr}).`
      });
    }
  };

  const handleExportScopeJSON = (scope: ExportScope) => {
    const yr = appState.selectedYear;
    const json = generateViewJSON(appState, scope);
    const slug = getScopeFileSlug(scope);
    const filename =
      scope === 'all'
        ? `allocat-full-workspace-${dateStr}.json`
        : `allocat-${slug}-${yr}-${dateStr}.json`;

    triggerFileDownload(json, filename, 'application/json');
    setStatus({
      type: 'success',
      message: isTableScope(scope)
        ? `Exported SQLite table "${tableScopeToTableName(scope)}" JSON (schemaVersion: 2).`
        : `Exported "${activeScopeShort}" SQLite-aligned JSON backup (schemaVersion: 2).`
    });
  };

  const handleDownloadTemplateCSV = (
    scope: ExportScope,
    includeExampleRows: boolean = true
  ) => {
    const yr = appState.selectedYear;
    const csv = generateTemplateCSV(scope, yr, includeExampleRows);
    const suffix = includeExampleRows ? 'example-template' : 'empty-schema';
    const slug = getScopeFileSlug(scope);

    triggerFileDownload(
      csv,
      `allocat-${slug}-${suffix}-${yr}.csv`,
      'text/csv;charset=utf-8;'
    );
    const targetName = isTableScope(scope)
      ? `table "${tableScopeToTableName(scope)}"`
      : VIEW_SCOPE_TABS.find((t) => t.id === scope)?.shortLabel || scope;

    setStatus({
      type: 'success',
      message: includeExampleRows
        ? `Downloaded SQLite-aligned example CSV template for ${targetName}. Edit rows and upload below.`
        : `Downloaded blank CSV schema headers for ${targetName}.`
    });
  };

  const handleDownloadTemplateJSON = (scope: ExportScope) => {
    const yr = appState.selectedYear;
    const json = generateTemplateJSON(scope, yr);
    const slug = getScopeFileSlug(scope);
    triggerFileDownload(
      json,
      `allocat-${slug}-template-${yr}.json`,
      'application/json'
    );
    const targetName = isTableScope(scope)
      ? `table "${tableScopeToTableName(scope)}"`
      : VIEW_SCOPE_TABS.find((t) => t.id === scope)?.shortLabel || scope;
    setStatus({
      type: 'success',
      message: `Downloaded SQLite-aligned JSON template for ${targetName} (schemaVersion: 2).`
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
                Normalized SQLite 3 relational tables with aligned CSV templates, JSON schemas, and SQL dumps
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

        {/* Scope Mode Switcher (SQLite Tables vs Matrix Views) */}
        <div className="px-5 pt-3 pb-3 bg-slate-50/60 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 bg-slate-200/70 dark:bg-slate-800 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                onClick={() => {
                  setScopeGroup('tables');
                  if (!isTableScope(selectedScope)) {
                    setSelectedScope('table_people');
                  }
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                  scopeGroup === 'tables'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span>SQLite Tables (Normalized)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setScopeGroup('views');
                  if (isTableScope(selectedScope)) {
                    setSelectedScope('all');
                  }
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                  scopeGroup === 'views'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Views & Full Workspace</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.people.length} people
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.clients.length} clients
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.projects.length} projects
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800">
                {appState.allocations.length} allocations
              </span>
              <span className="px-1.5 py-0.5 rounded bg-purple-100/80 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300">
                {appState.leaves.length} leaves
              </span>
            </div>
          </div>

          {scopeGroup === 'tables' ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {SQLITE_TABLE_SCHEMAS.map((tbl) => {
                const isActive = selectedScope === tbl.scope;
                const count = getRowCountForTable(tbl.tableName);
                return (
                  <button
                    key={tbl.scope}
                    type="button"
                    onClick={() => {
                      setSelectedScope(tbl.scope);
                      setStatus(null);
                    }}
                    className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer border ${
                      isActive
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs font-semibold'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-indigo-400'
                    }`}
                  >
                    <span className="font-mono text-[11px] truncate">{tbl.tableName}</span>
                    <span
                      className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded ${
                        isActive
                          ? 'bg-indigo-500 text-white'
                          : 'bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {VIEW_SCOPE_TABS.map((tab) => {
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
          )}
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
                  All changes synchronize into 10 normalized relational tables persisted in IndexedDB. Click any data table below to inspect, export CSV/JSON, or download its template.
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

            {/* Live Clickable Table Row Counts */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {sqliteStats.tables.map((t) => {
                const matchingSchema = SQLITE_TABLE_SCHEMAS.find(
                  (s) => s.tableName === t.tableName
                );
                const isSelected = Boolean(
                  matchingSchema && selectedScope === matchingSchema.scope
                );
                return (
                  <button
                    key={t.tableName}
                    type="button"
                    disabled={!matchingSchema}
                    onClick={() => {
                      if (matchingSchema) {
                        setScopeGroup('tables');
                        setSelectedScope(matchingSchema.scope);
                        setStatus(null);
                      }
                    }}
                    className={`px-2.5 py-1.5 rounded-lg border text-left flex flex-col transition-all ${
                      matchingSchema ? 'cursor-pointer' : 'cursor-default opacity-80'
                    } ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/70 border-indigo-400 dark:border-indigo-600'
                        : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-700/70 hover:border-indigo-400/70'
                    }`}
                    title={
                      matchingSchema
                        ? `Select "${t.tableName}" table for CSV/JSON export & templates`
                        : 'Internal SQLite system table'
                    }
                  >
                    <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                      {t.tableName}
                    </span>
                    <span className="text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {t.rowCount}
                    </span>
                  </button>
                );
              })}
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
                            `SELECT person_name, project_code, jan, jan_status, feb, feb_status, annual_avg_pct\nFROM v_allocation_months\nWHERE year = ${appState.selectedYear}\nORDER BY annual_avg_pct DESC\nLIMIT 12;`
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

          {/* Selected Table or View Export Actions */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide flex flex-wrap items-center gap-2">
                  <span>Export: {activeScopeTitle}</span>
                  <span className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
                    {appState.selectedYear}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  {activeScopeDescription}
                </p>
              </div>

              {activeTableSchema && (
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                  <span className="px-2 py-0.5 rounded bg-amber-100/80 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800 flex items-center gap-1">
                    <KeyRound className="w-2.5 h-2.5" />
                    <span>PK: {activeTableSchema.primaryKey}</span>
                  </span>
                  {activeTableSchema.foreignKeys.map((fk) => (
                    <span
                      key={fk}
                      className="px-2 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center gap-1"
                    >
                      <Link2 className="w-2.5 h-2.5" />
                      <span>FK: {fk}</span>
                    </span>
                  ))}
                </div>
              )}
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
                    Export {activeScopeShort} (.CSV)
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    SQLite-aligned CSV with exact primary/foreign keys for spreadsheet round-trips.
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
                    Export {activeScopeShort} (.JSON)
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Normalized schemaVersion 2 JSON payload aligned with SQLite column names.
                  </p>
                </div>
              </button>
            </div>

            {/* Quick 1-click CSV export strip for all 8 SQLite tables */}
            <div className="pt-2 border-t border-slate-200/80 dark:border-slate-700/70">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
                Quick-export individual SQLite table (.CSV):
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {SQLITE_TABLE_SCHEMAS.map((tbl) => (
                  <button
                    key={tbl.scope}
                    type="button"
                    onClick={() => handleExportScopeCSV(tbl.scope)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-500 text-slate-700 dark:text-slate-300 flex items-center justify-between gap-1.5 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span className="truncate">{tbl.tableName}.csv</span>
                    </span>
                    <span className="text-[10px] text-slate-400 tabular-nums">
                      {getRowCountForTable(tbl.tableName)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Unified Import & Aligned Templates Section */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  Unified Import & Aligned Templates (.SQLITE / .DB / .SQL / .CSV / .JSON)
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Auto-detects SQLite binaries, SQL dumps, per-table CSVs, or multi-table exports into{' '}
                  <span className="font-medium font-mono text-slate-700 dark:text-slate-300">
                    {activeScopeShort}
                  </span>{' '}
                  with foreign-key validation.
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
                  title="Upsert matching primary/foreign key rows and add new records without removing unrelated rows"
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
                  title="Replace target table or workspace records with imported file contents and enforce FK integrity"
                >
                  Replace Existing
                </button>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-700/70 text-[11px] text-slate-500 dark:text-slate-400 font-mono leading-relaxed">
              <span className="font-semibold text-slate-700 dark:text-slate-300 font-sans">
                Aligned Database Columns ({activeScopeShort}):{' '}
              </span>
              {activeColumnsHint}
            </div>

            {/* Aligned Import Templates (CSV Example, CSV Empty Schema, JSON Template) */}
            <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>SQLite-Aligned Import Templates ({activeScopeShort})</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Pre-built CSV & JSON templates matching the exact SQLite table columns and ID relationships.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplateCSV(selectedScope, true)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80 flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Download CSV template populated with realistic SQLite example rows"
                  >
                    <Download className="w-3 h-3" />
                    <span>Example (.CSV)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadTemplateCSV(selectedScope, false)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Download blank CSV template containing only exact SQLite column headers"
                  >
                    <Download className="w-3 h-3" />
                    <span>Empty Headers (.CSV)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadTemplateJSON(selectedScope)}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/70 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80 flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Download schemaVersion 2 JSON template aligned with SQLite column names"
                  >
                    <FileJson className="w-3 h-3" />
                    <span>Schema (.JSON)</span>
                  </button>
                </div>
              </div>

              {/* Quick table & view template strip */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mr-1">
                    SQLite table templates:
                  </span>
                  {SQLITE_TABLE_SCHEMAS.map((tbl) => (
                    <button
                      key={tbl.scope}
                      type="button"
                      onClick={() => handleDownloadTemplateCSV(tbl.scope, true)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer flex items-center gap-1 ${
                        selectedScope === tbl.scope
                          ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700'
                          : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-indigo-400'
                      }`}
                      title={`Download ${tbl.tableName} SQLite CSV example template`}
                    >
                      <Download className="w-2.5 h-2.5" />
                      <span>{tbl.tableName}</span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mr-1">
                    Matrix view templates:
                  </span>
                  {VIEW_SCOPE_TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleDownloadTemplateCSV(t.id, true)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer flex items-center gap-1 ${
                        selectedScope === t.id
                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
                          : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-blue-400'
                      }`}
                      title={`Download ${t.label} CSV example template`}
                    >
                      <Download className="w-2.5 h-2.5" />
                      <span>{t.shortLabel}</span>
                    </button>
                  ))}
                </div>
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
                  Bundle AlloCat and your current SQLite workspace into a single self-contained{' '}
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
