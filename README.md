# AlloCat — Resource & Capacity Planner

AlloCat is a 12-month resource planning application for teams that manage people, departments, clients, projects, allocations, and leave. It combines an interactive React matrix, an in-browser SQLite relational database, optional Supabase synchronization, and PWA/offline packaging.

## Current Architecture

AlloCat is a client-side React 19 application built with TypeScript and Vite. The planning state is owned by `App.tsx`, while focused components handle matrices, editors, reports, administration, import/export, and collaboration.

### Data and persistence

- A normalized SQLite 3 database runs in the browser through `sql.js` with foreign-key enforcement.
- The SQLite binary is persisted to IndexedDB as `allocat_sqlite_idb` and mirrored to `localStorage` as `allocat_sqlite_b64_v1`.
- Legacy browser payloads are migrated into the relational mirror.
- React state remains the application model; SQLite synchronization keeps the browser database and backup/export system aligned.
- Optional Supabase Postgres and Realtime synchronization mirrors the workspace entities and workspace metadata. Supabase configuration is not required for local in-browser use.

### Main SQLite tables

| Area | Tables and purpose |
| --- | --- |
| People | `people`: roster, role, department, contract type, capacity, avatar, status, and notes |
| Accounts and scope | `departments`, `leave_types`, `planning_years`, `workspace_meta` |
| Work | `clients`, `projects`, `allocations`, `leaves` |
| Analytics | `v_allocation_months`, `v_person_annual_summary` |

`people.is_active` controls whether a person participates in active workspace views. Existing and imported records default to active when no status is supplied.

### Allocation model

Each allocation belongs to a person, project, and planning year. It stores monthly percentages for January through December plus a status for each month:

- `unknown`: commitment is not yet classified
- `planned`: tentative allocation
- `confirmed`: committed allocation

The app uses allocation and leave records to calculate effective monthly capacity, utilization, bench capacity, overtime, and reporting summaries.

---

## Planning Views

### Clients and projects

The default matrix groups active staff allocations beneath client organizations and deliverable projects. It shows monthly project staffing, assigned headcount, FTE equivalents, and allocation status. Projects and clients can be expanded or sorted without leaving the main workspace.

### People

The people matrix presents active staff by last name and first name, contract type, annual utilization, monthly capacity, and allocation status. Rows can be expanded to edit individual project allocations month by month.

Inactive people remain in stored state and in the Admin Panel for reactivation, but are excluded from planning matrices, reports, assignment dialogs, leave scheduling, overtime alerts, and capacity calculations.

### Availability and leave

The availability matrix tracks scheduled leave across a 12-month year. Built-in and custom leave types support configurable impact percentages. Effective capacity is calculated from base capacity minus scheduled leave impact.

### Bench

The bench matrix identifies unallocated capacity for active staff. It supports quick filters and one-click navigation into staff assignment flows.

## Editing and Capacity Tools

- Add and edit people, departments, clients, projects, and leave entries.
- Activate or deactivate people through the edit dialog.
- Assign a person to a project for one month or across a month range.
- Adjust allocation percentages with sliders and presets.
- Cycle monthly allocation status between unknown, planned, and confirmed.
- Open a workload popover showing project-by-project assignments, leave reductions, total workload, and capacity.
- Filter by department, contract type, client, project, utilization, search text, and visible months.
- Expand or collapse matrix rows and customize which months are visible.
- Edit staffing notes and inline comments for people, projects, allocations, and leave entries.
- View person-grouped overtime alerts and cap an over-allocation month or all affected months.

---

## Reports and Analytics

The reporting modal provides department utilization trends, billable versus internal effort, client and project distribution, overtime, bench capacity, and leave impact. Reports can be filtered by planning year, department, and contract type (`Internal`, `External`, `B2B`).

- Export the active report tab as CSV.
- Export the complete analytical report pack as JSON.
- Use the reporting view to audit under-allocation, over-allocation, bench headroom, and effective leave capacity.

## Import, Export, and Backup

The Admin Panel provides relational backup and data-transfer tools:

- Export the live workspace as a binary SQLite `.sqlite`/`.db` file or a complete SQL dump.
- Import SQLite databases and SQL scripts.
- Export or import tables and analytical views as CSV or JSON.
- Use merge/upsert or full-replace import behavior.
- Download CSV and JSON templates for the normalized tables.
- Inspect SQLite DDL and run read-only `SELECT`, `WITH`, `PRAGMA`, and `EXPLAIN` queries.
- Generate a self-contained portable offline HTML bundle containing the app and an embedded SQLite snapshot.

Before workspace data is selectively or fully cleared, AlloCat requires a complete SQLite backup to be created and downloaded. Changing the clear selection invalidates the backup approval, preventing a stale backup from authorizing a different deletion scope.

---

## Authentication and Administration

AlloCat has two separate access layers:

1. **Browser-local app accounts** control the sign-in overlay and Admin/Editor/Viewer UI behavior.
2. **Optional Supabase Auth and database access** synchronize workspace data and support collaboration.

On a fresh browser, the initial local account is `admin` / `admin`. Local accounts, password hashes, and roles are stored in browser storage and are not shared across devices. Viewer mode hides or disables editing, but local roles are not security enforcement.

The Admin Panel manages:

- Active and inactive people
- Departments and leave types
- Planning years
- Clients and projects
- Scheduled leaves
- Local app accounts and roles
- Supabase connection settings and workspace collaboration
- SQLite import/export and SQL inspection
- Selective or complete workspace clearing
- Workspace reset and backup-first data deletion

Supabase uses anonymous sign-in to create an authenticated identity for Realtime and Postgres access. Collaboration support includes workspace members, join codes, invitations, join requests, role updates, and Realtime state subscriptions. Google OAuth is not used.

## Security Boundary

The included migration grants public access to the workspace entities under the documented current configuration. The browser-local username/password system is a UI gate and does not secure the Supabase database or prevent direct API access. Use this deployment only if public workspace reads and writes are acceptable, or replace the policies with your own authenticated authorization model before production use.

Only the Supabase public anon/publishable key belongs in browser configuration. Never add a service-role or secret key to `VITE_*` variables, repository variables, source code, or browser settings.

See [Supabase setup](./supabase/README.md) for configuration and the complete public-access warning.

---

## Interface and Display

- Responsive desktop and mobile layouts
- Dark mode by default with a light-mode toggle
- Pinned headers and scrollable matrix areas
- Planning-year and view-mode selectors
- Consolidated add menu and batch-assignment workflow
- Visible-month controls for quarters, halves, custom ranges, or the full year
- Last-name sorting for people and alphabetical sorting for clients and projects
- Employment badges for Internal, External, and B2B staff
- High-contrast allocation status colors in both themes
- Inline notes and comments
- Person-grouped overtime alerts with per-month and bulk auto-cap actions

## Offline and Standalone Use

AlloCat is installable as a PWA and includes Workbox service-worker caching and a standalone app workflow.

- The PWA can be installed through supported Chromium browsers or directly from the Windows & Offline App modal.
- The portable HTML bundle embeds the compiled app and a live SQLite snapshot.
- The Electron wrapper can package a native desktop build with Electron Builder.
- Production builds are copied into `docs/` for GitHub Pages deployment and synchronized with `public/` assets where applicable.

---

## Repository Layout

- `src/App.tsx`: application state, data mutation, synchronization, and routing between matrix views
- `src/components/`: matrix views, dialogs, toolbar, admin panel, reports, and standalone/PWA UI
- `src/types/`: shared domain types and allocation/leave configuration
- `src/data/seedData.ts`: defaults and browser-payload normalization
- `src/utils/allocationMath.ts`: capacity, utilization, overtime, and bench calculations
- `src/utils/sqliteDatabase.ts`: SQLite schema, migrations, persistence, SQL, and binary export
- `src/utils/importExportUtils.ts`: CSV/JSON/SQL import and export utilities
- `src/utils/supabaseSync.ts`: Realtime subscriptions and workspace delta synchronization
- `src/supabase.ts`: browser auth, account storage, and Supabase configuration
- `supabase/migrations/`: Postgres schema for optional collaboration
- `electron/main.cjs`: optional desktop wrapper
- `docs/`: GitHub Pages build output

## Local Development

Requirements: Node.js and npm.

```bash
npm install
npm run dev
npm run lint
npm run build
npm run preview
```

The development server runs on `http://localhost:3000`.

```bash
npx electron-builder --win --x64
```

Run the Electron package command only after installing Electron and Electron Builder for the project and creating a production build.

## Supabase Configuration

For optional shared synchronization, follow [Supabase setup](./supabase/README.md). It covers the migration, anonymous sign-in, environment variables, GitHub Pages configuration, and security warnings.

AlloCat does not automatically migrate an existing local database into Supabase. Use the Import/Export tools to move workspace data explicitly.
