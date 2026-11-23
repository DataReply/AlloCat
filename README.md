# AlloCat — Resource & Capacity Planner

**AlloCat** is an interactive annual resource allocation and capacity planning application designed for engineering, product, design, and delivery teams. It provides a unified 12-month matrix workspace backed by Supabase Auth and Postgres, with a local in-browser relational **SQLite WebAssembly (`sql.js`)** mirror for browser persistence and import/export.

---

## Relational SQLite Storage Architecture

The local workspace mirror runs in an in-memory **SQLite 3** engine compiled to WebAssembly (`sql.js`), with foreign-key enforcement (`PRAGMA foreign_keys = ON`) and automatic binary persistence:

- **Primary Persistence**: Binary `.sqlite` database stored in browser **IndexedDB** (`allocat_sqlite_idb`), mirrored to a base64 backup in `localStorage` (`allocat_sqlite_b64_v1`), with automatic one-time migration from legacy `localStorage` payloads.
- **Normalized Relational Schema (9 Tables + 2 Analytical Views)**:
  - **Master Tables**: `people` (`id`, `first_name`, `last_name`, `full_name`, `role`, `department`, `employment_type`, `email`, `max_capacity_percent`, `avatar_color`, `initials`, `notes`), `clients` (`id`, `name`, `industry`, `color`, `status`), `projects` (`id`, `client_id`, `name`, `code`, `status`, `color`, `billable`, `notes`)
  - **Fact Tables**: `allocations` (`id`, `person_id`, `project_id`, `year`, `jan`–`dec`, `jan_status`–`dec_status`, `notes`), `leaves` (`id`, `person_id`, `leave_type`, `title`, `year`, `start_month`, `end_month`, `impact_percent`, `notes`)
  - **Config & System Tables**: `departments`, `leave_types`, `planning_years`, `workspace_meta`. The local app login is stored separately in browser storage.
  - **Analytical SQL Views**: `v_allocation_months` (monthly percentages + statuses), `v_person_annual_summary`

---

## Core Views & Perspectives

AlloCat lets you inspect and edit your organization's staffing plan from four synchronized perspectives, with a pinned header and KPI/filter toolbar so only the matrix table scrolls:

1. **By Clients & Projects (`ClientProjectMatrixView` — Default View)**
   - Opens with deliverable projects expanded under their respective client organizations, sorted alphabetically **`A → Z`**.
   - Tracks monthly total project staffing (`%` and `FTE` equivalents) and headcount assigned to each initiative.
   - Displays color-coded **per-month allocation statuses** (**Unknown** gray, **Planned** yellow, **Confirmed** green) with one-click inline status cycling and a color legend above the matrix.

2. **By People (`PeopleMatrixView`)**
   - Displays every team member in **`Last Name, First Name`** format (sorted **`A → Z`** by Last Name by default) alongside their employment type badge (`Internal`, `External`, `B2B`), annual average utilization, and monthly capacity totals (`Jan` – `Dec`).
   - Displays color-coded monthly allocation statuses on person summary rows (**Unknown**, **Planned**, **Confirmed**, or **Mixed** when multiple projects differ in the same month) with one-click status cycling directly on the summary cell.
   - Expand any person's row (or click **Expand All Rows**) to view and edit individual project allocations and per-month statuses (**Unknown**, **Planned**, **Confirmed**) month by month.
   - Click any monthly project cell to open the **Total Workload & Allocation Popover**, showing an itemized breakdown, a multi-segment capacity bar, active leave reductions, month status selector, and quick project switching.

3. **Availability & Leaves (`AvailabilityMatrixView`)**
   - Tracks scheduled vacations, PTO, sick leave, parental leave, sabbaticals, and custom leave types across the 12-month timeline.
   - Automatically calculates each person's **effective monthly capacity** (`Base Capacity − Leave Impact`) and flags months where project bookings exceed reduced availability.

4. **Bench (`BenchMatrixView`)**
   - Highlights unallocated working capacity (`Effective Capacity − Booked Projects`) for every team member each month.
   - Includes a quick capacity filter (`≥ 10%`, `≥ 20%`, `≥ 50%`, `100% free`) so resource managers can immediately identify available staff and assign them to projects in one click.

---

## Reporting & Capacity Analytics

Click **Reports** in the top header (or open **AlloCat Logo Menu → Reporting & Analytics**) to launch the multi-perspective analytics suite, filterable by **Year**, **Department**, and **Contract Type** (`Internal`, `External`, `B2B`):

- **Dept Utilization & Trends**: Monthly and annual department capacity vs. bookings, headroom, and utilization trends.
- **Billable vs. Internal**: FTE and percentage split between billable client work and internal initiatives across the organization and by department.
- **Client & Project Effort**: Portfolio FTE distribution across clients and deliverable projects.
- **Overtime, Bench & Leaves**: Over-allocation risk audit, unbooked bench capacity, and scheduled leave impact.
- **Report Exports**: Download the active report tab as `.csv` or export the complete multi-tab analytical pack as `.json`.

---

## SQLite-Aligned Import, Export, Templates & SQL Inspector

Open **Import / Export** from the **Admin Panel** (accessible via the **AlloCat Logo Menu → Open Admin Panel**) to back up, inspect, query, or bulk-edit workspace data:

- **SQLite Binary & SQL Dump (`.sqlite` / `.sql`)**:
  - Export or import the live relational **SQLite 3** database file (`.sqlite` / `.db`) or a complete `DDL + INSERT` script (`.sql`) compatible with DB Browser for SQLite and standard SQLite CLI tooling.
  - Built-in **SQLite Schema & Query Inspector** to browse the full `CREATE TABLE` / `CREATE VIEW` DDL and run read-only `SELECT`, `WITH`, `PRAGMA`, or `EXPLAIN` queries directly against live tables and views.
- **Per-Table & View-Scoped CSV / JSON Export & Import**:
  - **SQLite Tables**: Export, import, or download empty/example `.csv` and `.json` templates mapped 1:1 to normalized columns—including `jan_status`–`dec_status` (`unknown`, `planned`, `confirmed`) on `allocations`—with preserved primary/foreign keys for `people`, `clients`, `projects`, `allocations`, `leaves`, `departments`, `leave_types`, and `planning_years`.
  - **Views & Full Workspace**: Export or import synchronized relational snapshots for `All Tables`, `Clients & Projects`, `By People` (including `person_summary` monthly statuses: `unknown`, `planned`, `confirmed`, `mixed`), `Availability & Leaves`, `Bench`, or `Admin Directories`, supporting both **Merge / Upsert** and **Full Replace** import modes.
- **Standalone Offline HTML App**: Bundle the compiled app and a live base64-encoded SQLite database snapshot (`window.__ALLOCAT_EMBEDDED_SQLITE__`) into a single self-contained `.html` file.

---

## Authentication, Logo Menu & Admin Control Panel

Before signing in, the workspace is locked behind a sign-in overlay.

App sign-in uses browser-local username/password accounts (`admin` / `admin` on a fresh browser). Admins can create accounts and assign Admin, Editor, or Viewer roles in **Admin Panel → App Accounts**. Accounts and roles exist only in that browser and are not shared across devices. Viewer mode hides or blocks app editing in the UI, but these browser-stored roles are not security controls. Supabase anonymous Auth supplies an identity for Postgres and Realtime; Google sign-in is not used. For GitHub Pages, configure the Supabase project URL and public anon/publishable key once as GitHub Actions repository variables; local builds can use `.env.local` or per-browser Admin Panel settings. The app does not copy data between databases; import it yourself with the existing Import / Export tools. See [Supabase setup](./supabase/README.md) for instructions and the public-access warning.

- **Sign-In:** Local browser login. The initial username and password are both `admin`; password hashes and account roles are stored in that browser's local storage.
- **Logo Button Menu & Admin Control Panel**: Once signed in, click the **AlloCat logo button** (top-left header, displaying the active username badge) to open the administrator dropdown menu:
  - **Open Admin Panel (`Manage All`)**: Centralized management modal with account management for Admins and Quick Jump shortcuts:
    1. **People & Team**: Search and browse team members (`A → Z`), inspect roles, departments, contract types, and max capacity, or add, edit, and remove staff.
    2. **Departments**: Create departments, inline-rename existing departments (cascading updates to team members), and remove unused departments.
    3. **Clients**: Search client organizations, create clients with status (`Active`, `Lead`, `Completed`), industry, and brand color, or edit and delete clients with cascading project cleanup.
    4. **Projects**: Search deliverable projects, inspect codes, parent clients, billing status (`Billable` vs. `Internal`), and assigned headcount, or add, edit, and delete projects.
    5. **Time Off & Leaves**: Browse all scheduled leaves, customize leave types and default impacts, schedule new time off, or remove leave entries.
    6. **Team & Collaboration**: View workspace sessions and collaboration settings. Email invitations are unavailable with local-only sign-in.
    7. **App Accounts** (Admin only): Create browser-local accounts, assign Admin/Editor/Viewer roles, reset passwords, or remove accounts. At least one Admin account is required.
    8. **Years & System**: Test the configured Supabase connection, manage planning years, open Import/Export tools, or reset the workspace. Database access is public under the configured policies.
  - **Reporting & Analytics**: Jump straight to the Reporting & Capacity Analytics modal.
  - **Switch to Light / Dark Mode**: Toggle between Dark Mode (default) and balanced Light Mode.
  - **Windows & Offline App**: Open the desktop PWA installer and portable bundle generator.
  - **Log Out / Lock Workspace**: Lock and blur the workspace until signed in again.

---

## Key Workspace Features

- **Header & Toolbar Controls**:
  - **Planning Year Dropdown**: Switch between active planning years (`2025`, `2026`, `2027`, etc.) or open **+ Manage Years...**.
  - **Consolidated `+ Add` Menu & `Assign Staff`**: Create **+ Time Off**, **+ Person**, or **+ Project**, or batch-assign staff across months.
  - **Visible Months Selector**: Focus the matrix on specific quarters, half-years, or custom month subsets (`Jan` – `Dec`).
- **Default `A → Z` Sorting**: Sorts people (`Last Name: A → Z`) and clients/projects (`A → Z`) by default, with quick toggles for `Z–A`, `First Name`, or `Original Order`.
- **Person-Grouped Overtime Alerts Drawer**: Groups all over-allocated months per team member with one-click per-month **Auto-Cap** and **Auto-Cap All Months** actions.
- **Per-Month Allocation Statuses & Theme Contrast**:
  - Track commitment per person, project, and month using three statuses: **Unknown** (gray), **Planned** (yellow), and **Confirmed** (green).
  - Toggle statuses inline directly inside matrix cells, in the **Cell Allocation Popover**, or across a month range via **Assign Staff** (`BatchAssignModal`).
  - Uses opaque, high-contrast status field colors in both **Dark Mode** and **Light Mode** so cells remain clear and legible over dark surfaces.
- **Interactive Cell Popover & Batch Assignment**: Adjust allocations via slider or presets (`0%`, `25%`, `50%`, `75%`, `100%`) and set the month status across a single month, the remainder of the year, or all 12 months.
- **Inline Comments & Staffing Notes**: Edit notes inline for people, projects, assignments, and leaves.

---

## Standalone Desktop & Offline Installation

AlloCat can be installed and run as a **standalone desktop application on Windows 10 / 11** (as well as macOS and Linux) with full offline functionality. Open **AlloCat Logo Menu → Windows & Offline App** to choose from three options:

1. **Native Desktop App (PWA — Recommended)**
   - Click **Install on Windows Now** inside the modal (or use **Microsoft Edge** `⋯ → Apps → Install AlloCat as an app` / **Google Chrome** `⋮ → Cast, save, and share → Install AlloCat...`).
   - Runs in a dedicated standalone desktop window with full offline support via Workbox Service Worker caching.

2. **Portable Offline Bundle (`AlloCat-Standalone.html` + `.bat`)**
   - **`AlloCat-Standalone.html`**: Bundles the compiled application (`JS` + `CSS`) and live SQLite workspace snapshot into a single self-contained `.html` file.
   - **`AlloCat-Windows-Launcher.bat`**: Double-click on Windows to launch `AlloCat-Standalone.html` (or the live site) inside a frameless desktop window (`--app` mode).

3. **Build a Standalone Windows `.exe` Installer (Electron)**
   - Package the included Electron wrapper (`electron/main.cjs`):
     ```bash
     npm install --save-dev electron electron-builder
     npm run build
     npx electron-builder --win --x64
     ```

---

## Local Development & Build

```bash
# Install dependencies
npm install

# Start Vite dev server (http://localhost:3000)
npm run dev

# Type-check with TypeScript
npm run lint

# Build production bundle to dist/ and sync GitHub Pages assets (docs/assets/ & public/assets/)
npm run build
```
