import React from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Plus, Trash2, Pencil, MessageSquare, ArrowDownAZ, ArrowUpZA, EyeOff } from 'lucide-react';
import {
  MONTH_NAMES,
  Person,
  Project,
  Client,
  Allocation,
  AllocationStatus,
  ALLOCATION_STATUSES,
  ALLOCATION_STATUS_CONFIG,
  getNextAllocationStatus,
  LeaveEntry,
  EmploymentType,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_BADGE_CONFIG,
  PeopleSortOrder
} from '../types';
import {
  getPersonCapacitySummary,
  getPersonMonthStatusSummary,
  getUtilizationColorClass,
  formatPersonTableName
} from '../utils/allocationMath';
import { CommentCell } from './CommentCell';

interface PeopleMatrixViewProps {
  people: Person[];
  clients: Client[];
  projects: Project[];
  allocations: Allocation[];
  leaves?: LeaveEntry[];
  selectedYear: number;
  expandedPersonIds: Set<string>;
  onTogglePersonExpand: (personId: string) => void;
  onOpenCellEditor: (personId: string, projectId: string, monthIndex: number) => void;
  onUpdateAllocationStatus?: (
    allocationId: string,
    monthIndex: number,
    nextStatus: AllocationStatus
  ) => void;
  onOpenPersonMonth?: (personId: string, monthIndex: number) => void;
  onOpenAssignModalForPerson: (personId: string) => void;
  onDeleteAllocation: (allocationId: string) => void;
  onEditPerson?: (person: Person) => void;
  onEditProject?: (project: Project) => void;
  onDeletePerson?: (personId: string) => void;
  onUpdatePersonNotes?: (personId: string, notes: string) => void;
  onUpdatePersonEmployment?: (personId: string, employmentType: EmploymentType) => void;
  onUpdateAllocationNotes?: (allocationId: string, notes: string) => void;
  peopleSort?: PeopleSortOrder;
  onTogglePeopleSort?: () => void;
  visibleMonths?: boolean[];
  onToggleMonthVisibility?: (monthIdx: number) => void;
}

export const PeopleMatrixView: React.FC<PeopleMatrixViewProps> = ({
  people,
  clients,
  projects,
  allocations,
  leaves = [],
  selectedYear,
  expandedPersonIds,
  onTogglePersonExpand,
  onOpenCellEditor,
  onUpdateAllocationStatus,
  onOpenPersonMonth,
  onOpenAssignModalForPerson,
  onDeleteAllocation,
  onEditPerson,
  onEditProject,
  onDeletePerson,
  onUpdatePersonNotes,
  onUpdatePersonEmployment,
  onUpdateAllocationNotes,
  peopleSort = 'lastName-asc',
  onTogglePeopleSort,
  visibleMonths = Array(12).fill(true),
  onToggleMonthVisibility
}) => {
  const getProject = (id: string) => projects.find((p) => p.id === id);
  const getClient = (id: string) => clients.find((c) => c.id === id);
  const visibleMonthCount = visibleMonths.filter(Boolean).length;

  if (people.length === 0) {
    return (
      <div className="p-12 text-center text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 m-6">
        <p className="font-medium text-sm">No team members match the selected filters.</p>
        <p className="text-xs mt-1">Try adjusting the department, employment type, search keyword, or capacity status.</p>
      </div>
    );
  }

  return (
    <div className="w-full flex-1 min-h-0 flex flex-col bg-slate-100 dark:bg-slate-900 border-b border-slate-300 dark:border-slate-800 shadow-xs">
      <div className="px-4 py-1.5 bg-slate-100 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-600 dark:text-slate-300">
            Allocation Month Status:
          </span>
          {ALLOCATION_STATUSES.map((st) => {
            const cfg = ALLOCATION_STATUS_CONFIG[st];
            return (
              <span
                key={st}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium ${cfg.cellBg} ${cfg.cellText} border-slate-300/70 dark:border-slate-700/70`}
              >
                <span className={`w-2 h-2 rounded-full ${cfg.dotClass}`} />
                <span>{cfg.label}</span>
              </span>
            );
          })}
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium bg-slate-200/75 dark:bg-[#333a47] text-slate-800 dark:text-slate-100 border-slate-300/70 dark:border-slate-600/80"
            title="Multiple projects in the same month have different statuses"
          >
            <span className="inline-flex items-center gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 dark:bg-yellow-400" />
              <span className="w-1.5 h-1.5 rounded-full bg-green-600 dark:bg-emerald-400" />
            </span>
            <span>Mixed</span>
          </span>
        </div>
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          Click any cell to edit % & status · Click status pill to cycle · Expand a person for per-project statuses
        </span>
      </div>

      <div className="w-full flex-1 min-h-0 overflow-auto">
        <table
          className="w-full text-left border-collapse"
          style={{ minWidth: `${540 + visibleMonthCount * 72}px` }}
        >
        <thead>
          <tr className="bg-slate-200/90 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 border-b border-slate-300 dark:border-slate-800 sticky top-0 z-20">
            <th className="py-2.5 px-4 w-[320px] min-w-[320px] sticky left-0 z-30 bg-slate-200 dark:bg-slate-800 border-r border-slate-300 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span>Team Member & Assigned Projects</span>
                  {onTogglePeopleSort && (
                    <button
                      type="button"
                      onClick={onTogglePeopleSort}
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                        peopleSort !== 'default'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-bold'
                          : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300/60 dark:hover:bg-slate-700/60'
                      }`}
                      title="Sort team members alphabetically (A–Z / Z–A)"
                    >
                      {peopleSort.endsWith('-desc') ? (
                        <ArrowUpZA className="w-3 h-3" />
                      ) : (
                        <ArrowDownAZ className="w-3 h-3" />
                      )}
                      <span>{peopleSort.endsWith('-desc') ? 'Z–A' : 'A–Z'}</span>
                    </button>
                  )}
                </div>
                <span className="text-[11px] font-mono font-normal text-slate-500 dark:text-slate-400">Avg %</span>
              </div>
            </th>

            <th className="py-2.5 px-3 w-[220px] min-w-[200px] max-w-[260px] bg-slate-200/90 dark:bg-slate-800 border-r border-slate-300 dark:border-slate-800">
              <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
                <span>Comments & Staffing Notes</span>
              </div>
            </th>

            {MONTH_NAMES.map((month, idx) => {
              if (!visibleMonths[idx]) return null;
              return (
                <th
                  key={month}
                  className="group/mth relative py-2.5 px-2 text-center font-mono w-[72px] min-w-[72px] border-r border-slate-200/60 dark:border-slate-800/60 last:border-r-0"
                >
                  <div className="flex flex-col items-center">
                    <span>{month}</span>
                    <span className="text-[10px] text-slate-400 font-normal">M{idx + 1}</span>
                  </div>
                  {onToggleMonthVisibility && (
                    <button
                      type="button"
                      onClick={() => onToggleMonthVisibility(idx)}
                      className="opacity-0 group-hover/mth:opacity-100 absolute top-1 right-1 p-0.5 rounded bg-slate-300/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 transition-opacity cursor-pointer"
                      title={`Hide ${month} (M${idx + 1})`}
                    >
                      <EyeOff className="w-2.5 h-2.5" />
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
          {people.map((person) => {
            const isExpanded = expandedPersonIds.has(person.id);
            const empType: EmploymentType = person.employmentType || 'Internal';
            const empBadge = EMPLOYMENT_BADGE_CONFIG[empType];
            const capacitySummary = getPersonCapacitySummary(
              person.id,
              selectedYear,
              allocations,
              person.maxCapacityPercent,
              leaves
            );

            const personAllocations = allocations.filter(
              (a) => a.personId === person.id && a.year === selectedYear
            );

            return (
              <React.Fragment key={person.id}>
                <tr className="group bg-slate-50/95 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                  <td className="py-3 px-4 sticky left-0 z-10 bg-inherit border-r border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <button
                          type="button"
                          onClick={() => onTogglePersonExpand(person.id)}
                          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded transition-colors"
                          title={isExpanded ? 'Collapse projects' : 'Expand projects'}
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>

                        <div
                          className="w-7 h-7 rounded-full text-white font-semibold text-[11px] flex items-center justify-center shrink-0 shadow-xs"
                          style={{ backgroundColor: person.avatarColor }}
                        >
                          {person.initials}
                        </div>

                        <div className="min-w-0 truncate">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {formatPersonTableName(person)}
                            </span>
                            {onUpdatePersonEmployment ? (
                              <select
                                value={empType}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) =>
                                  onUpdatePersonEmployment(
                                    person.id,
                                    e.target.value as EmploymentType
                                  )
                                }
                                title="Change employment type (Internal, External, B2B)"
                                className={`px-1.5 py-0.2 text-[9px] font-mono font-semibold rounded border cursor-pointer focus:outline-hidden ${empBadge.badgeClass}`}
                              >
                                {EMPLOYMENT_TYPES.map((t) => (
                                  <option
                                    key={t}
                                    value={t}
                                    className="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                                  >
                                    {t}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span
                                className={`px-1.5 py-0.2 text-[9px] font-mono font-semibold rounded border ${empBadge.badgeClass}`}
                              >
                                {empType}
                              </span>
                            )}
                            {capacitySummary.hasOvertime && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.2 text-[10px] font-mono font-bold bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 rounded border border-rose-300 dark:border-rose-800"
                                title="Contains overbooked months exceeding capacity limit"
                              >
                                <AlertTriangle className="w-3 h-3 text-rose-600" />
                                Overtime
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate flex items-center gap-1.5 mt-0.5">
                            <span className="truncate">{person.role}</span>
                            <span>·</span>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                              {person.department}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-1">
                        <span
                          className={`font-mono font-bold text-xs tabular-nums px-1.5 py-0.5 rounded ${
                            getUtilizationColorClass(capacitySummary.annualAverage).badge
                          }`}
                        >
                          {capacitySummary.annualAverage}%
                        </span>

                        {onEditPerson && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditPerson(person);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded transition-all cursor-pointer"
                            title={`Edit ${person.name}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {onDeletePerson && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeletePerson(person.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded transition-all cursor-pointer"
                            title={`Remove ${person.name} from team`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="py-2.5 px-2 bg-inherit border-r border-slate-200 dark:border-slate-800 align-middle">
                    <CommentCell
                      value={person.notes}
                      onSave={(newNotes) => onUpdatePersonNotes?.(person.id, newNotes)}
                      placeholder="Add staffing note..."
                    />
                  </td>

                  {capacitySummary.totals.map((totalPct, monthIdx) => {
                    if (!visibleMonths[monthIdx]) return null;
                    const effCap = capacitySummary.effectiveCapacities[monthIdx];
                    const isOver = totalPct > effCap;
                    const excess = totalPct - effCap;
                    const activeLeaves = capacitySummary.monthLeaves[monthIdx];
                    const styling = getUtilizationColorClass(totalPct);

                    const { activeAllocs, orderedStatuses, uniformStatus } =
                      getPersonMonthStatusSummary(personAllocations, monthIdx);
                    const summaryStatusCfg = uniformStatus
                      ? ALLOCATION_STATUS_CONFIG[uniformStatus]
                      : null;
                    const nextMonthStatus: AllocationStatus = uniformStatus
                      ? getNextAllocationStatus(uniformStatus)
                      : 'confirmed';

                    const statusBreakdownText = activeAllocs
                      .map((a) => {
                        const proj = getProject(a.projectId);
                        const st = (a.monthlyStatus?.[monthIdx] || 'unknown') as AllocationStatus;
                        return `${proj?.name || 'Project'}: ${a.monthlyPercentage[monthIdx]}% (${ALLOCATION_STATUS_CONFIG[st].label})`;
                      })
                      .join(', ');

                    const cellBgClass =
                      activeAllocs.length > 0
                        ? summaryStatusCfg
                          ? summaryStatusCfg.cellBg
                          : 'bg-slate-200/75 dark:bg-[#333a47]'
                        : isOver
                        ? 'bg-rose-50 dark:bg-rose-950/40'
                        : styling.bg;

                    const cellTextClass =
                      activeAllocs.length > 0
                        ? summaryStatusCfg
                          ? `${summaryStatusCfg.cellText} font-semibold`
                          : 'text-slate-900 dark:text-slate-100 font-semibold'
                        : isOver
                        ? 'text-rose-700 dark:text-rose-400 font-bold'
                        : styling.text;

                    return (
                      <td
                        key={monthIdx}
                        onClick={() => onOpenPersonMonth?.(person.id, monthIdx)}
                        className={`p-1 text-center font-mono tabular-nums border-r border-slate-200/60 dark:border-slate-800/60 last:border-r-0 cursor-pointer transition-all hover:ring-2 hover:ring-blue-500/60 ${cellBgClass} ${
                          isOver ? 'ring-1 ring-inset ring-rose-500/80' : ''
                        }`}
                        title={
                          activeAllocs.length > 0
                            ? `Click to edit ${person.name}'s ${MONTH_NAMES[monthIdx]} workload (${totalPct}% — ${statusBreakdownText})`
                            : `Click to view and edit ${person.name}'s ${MONTH_NAMES[monthIdx]} workload (${totalPct}%) and project allocations`
                        }
                      >
                        <div className="flex flex-col items-center justify-center py-0.5 gap-0.5">
                          <span className={`text-xs ${cellTextClass}`}>
                            {totalPct > 0 ? `${totalPct}%` : '—'}
                          </span>

                          {activeAllocs.length > 0 && (
                            onUpdateAllocationStatus ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  activeAllocs.forEach((a) => {
                                    onUpdateAllocationStatus(a.id, monthIdx, nextMonthStatus);
                                  });
                                }}
                                title={
                                  uniformStatus
                                    ? `Status: ${ALLOCATION_STATUS_CONFIG[uniformStatus].label} — Click to change to ${ALLOCATION_STATUS_CONFIG[nextMonthStatus].label}`
                                    : `Mixed statuses (${statusBreakdownText}) — Click to mark all as Confirmed`
                                }
                                className="inline-flex items-center gap-1 px-1 py-0.2 rounded text-[8px] font-sans font-medium bg-white/80 dark:bg-black/35 text-slate-800 dark:text-white/95 hover:bg-white dark:hover:bg-black/55 border border-black/10 dark:border-white/20 cursor-pointer transition-colors"
                              >
                                {summaryStatusCfg ? (
                                  <>
                                    <span className={`w-1.5 h-1.5 rounded-full ${summaryStatusCfg.dotClass}`} />
                                    <span>{summaryStatusCfg.shortLabel}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="inline-flex items-center gap-0.5">
                                      {orderedStatuses.map((st) => (
                                        <span
                                          key={st}
                                          className={`w-1.5 h-1.5 rounded-full ${ALLOCATION_STATUS_CONFIG[st].dotClass}`}
                                        />
                                      ))}
                                    </span>
                                    <span>Mix</span>
                                  </>
                                )}
                              </button>
                            ) : (
                              <span
                                className={`inline-flex items-center gap-1 text-[8px] font-sans ${
                                  summaryStatusCfg
                                    ? summaryStatusCfg.cellText
                                    : 'text-slate-700 dark:text-slate-200'
                                }`}
                              >
                                {summaryStatusCfg ? (
                                  <>
                                    <span className={`w-1.5 h-1.5 rounded-full ${summaryStatusCfg.dotClass}`} />
                                    <span>{summaryStatusCfg.shortLabel}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="inline-flex items-center gap-0.5">
                                      {orderedStatuses.map((st) => (
                                        <span
                                          key={st}
                                          className={`w-1.5 h-1.5 rounded-full ${ALLOCATION_STATUS_CONFIG[st].dotClass}`}
                                        />
                                      ))}
                                    </span>
                                    <span>Mix</span>
                                  </>
                                )}
                              </span>
                            )
                          )}

                          {activeLeaves.length > 0 && (
                            <span
                              className="px-1 py-0.2 text-[8px] font-semibold rounded bg-purple-100/90 text-purple-800 dark:bg-purple-950/90 dark:text-purple-200 truncate max-w-[64px]"
                              title={`${activeLeaves.map((l) => l.title).join(', ')} (-${capacitySummary.leaveReductions[monthIdx]}% cap)`}
                            >
                              {activeLeaves[0].type.slice(0, 4)}
                            </span>
                          )}

                          {isOver && (
                            <span
                              className="px-1 py-0.2 text-[9px] font-bold rounded bg-rose-600 text-white tracking-tight"
                              title={`Allocated ${totalPct}% against ${effCap}% available capacity (+${excess}% over)`}
                            >
                              +{excess}%
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>

                {isExpanded && (
                  <>
                    {personAllocations.map((alloc) => {
                      const proj = getProject(alloc.projectId);
                      const client = proj ? getClient(proj.clientId) : undefined;
                      if (!proj) return null;

                      return (
                        <tr
                          key={alloc.id}
                          className="bg-slate-100/90 dark:bg-slate-800/30 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors group/sub"
                        >
                          <td className="py-2 px-4 pl-12 sticky left-0 z-10 bg-inherit border-r border-slate-200 dark:border-slate-800">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: proj.color }}
                                />
                                <div className="min-w-0 truncate">
                                  <div className="font-medium text-slate-800 dark:text-slate-200 truncate text-[11px]">
                                    {proj.name}
                                  </div>
                                  <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                                    {client?.name || 'Internal'} · {proj.code}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                {onEditProject && (
                                  <button
                                    type="button"
                                    onClick={() => onEditProject(proj)}
                                    className="opacity-0 group-hover/sub:opacity-100 p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 rounded transition-all cursor-pointer"
                                    title={`Edit project ${proj.name}`}
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => onDeleteAllocation(alloc.id)}
                                  className="opacity-0 group-hover/sub:opacity-100 p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded transition-all cursor-pointer"
                                  title="Remove assignment"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </td>

                          <td className="py-1.5 px-2 bg-inherit border-r border-slate-200 dark:border-slate-800 align-middle">
                            <CommentCell
                              value={alloc.notes || proj.notes || ''}
                              onSave={(newNotes) => onUpdateAllocationNotes?.(alloc.id, newNotes)}
                              placeholder="Add role note..."
                            />
                          </td>

                          {alloc.monthlyPercentage.map((pct, monthIdx) => {
                            if (!visibleMonths[monthIdx]) return null;
                            const cellStatus: AllocationStatus =
                              alloc.monthlyStatus?.[monthIdx] || 'unknown';
                            const statusCfg = ALLOCATION_STATUS_CONFIG[cellStatus];
                            const nextStatus = getNextAllocationStatus(cellStatus);

                            return (
                              <td
                                key={monthIdx}
                                onClick={() =>
                                  onOpenCellEditor(person.id, proj.id, monthIdx)
                                }
                                className={`p-1 text-center font-mono tabular-nums border-r border-slate-200/70 dark:border-slate-800/70 last:border-r-0 cursor-pointer transition-all hover:ring-2 hover:ring-blue-500/60 ${statusCfg.cellBg}`}
                                title={`Click to edit ${person.name}'s ${MONTH_NAMES[monthIdx]} allocation on ${proj.name} (${pct}%, Status: ${statusCfg.label})`}
                              >
                                <div className="py-0.5 flex flex-col items-center justify-center gap-0.5">
                                  <span
                                    className={`text-[11px] font-semibold ${statusCfg.cellText} ${
                                      pct > 0 ? '' : 'opacity-60'
                                    }`}
                                  >
                                    {pct > 0 ? `${pct}%` : '—'}
                                  </span>
                                  {onUpdateAllocationStatus ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onUpdateAllocationStatus(
                                          alloc.id,
                                          monthIdx,
                                          nextStatus
                                        );
                                      }}
                                      title={`Status: ${statusCfg.label} — Click to change to ${ALLOCATION_STATUS_CONFIG[nextStatus].label}`}
                                      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[13px] leading-none font-sans font-medium whitespace-nowrap bg-white/80 dark:bg-black/35 text-slate-800 dark:text-white/95 hover:bg-white dark:hover:bg-black/55 border border-black/10 dark:border-white/20 cursor-pointer transition-colors"
                                    >
                                      <span className={`w-2.5 h-2.5 rounded-full ${statusCfg.dotClass}`} />
                                      <span>{statusCfg.shortLabel}</span>
                                    </button>
                                  ) : (
                                    <span className={`inline-flex items-center gap-1 text-[8px] font-sans ${statusCfg.cellText}`}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dotClass}`} />
                                      <span>{statusCfg.shortLabel}</span>
                                    </span>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}

                    <tr className="bg-slate-50/30 dark:bg-slate-800/20 border-b border-slate-200/60 dark:border-slate-800/60">
                      <td
                        colSpan={2 + visibleMonthCount}
                        className="py-1.5 px-4 pl-12 text-xs sticky left-0 z-10"
                      >
                        <button
                          type="button"
                          onClick={() => onOpenAssignModalForPerson(person.id)}
                          className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 font-medium py-1 px-2 rounded-md hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Assign {person.name.split(' ')[0]} to another project</span>
                        </button>
                      </td>
                    </tr>
                  </>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
};
