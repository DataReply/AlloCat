# Supabase setup

The app uses browser-local username/password accounts and Supabase Postgres/Realtime. Google sign-in and automatic data migration are not used. Existing data must be imported manually through the app's Import / Export tools. An Admin can create local Admin, Editor, and Viewer accounts in **Admin Panel → App Accounts**; those accounts are stored only in the current browser.

## Configure a Supabase project

1. Create a Supabase project and run [`migrations/20261123000000_initial_schema.sql`](./migrations/20261123000000_initial_schema.sql) in the Supabase SQL Editor.
2. Enable **Anonymous Sign-Ins** under **Authentication → Providers**. The app creates an anonymous Supabase identity after the local login so Realtime and database requests have a Supabase user ID. No Google provider or OAuth redirect configuration is needed.
3. For GitHub Pages, add these repository-level Actions variables under **Settings → Secrets and variables → Actions → Variables**:
   - `VITE_SUPABASE_URL`: the Supabase project URL.
   - `VITE_SUPABASE_ANON_KEY`: the public anon/publishable key.
4. Run or rerun the Pages deployment workflow. The values are embedded in the public frontend build, so every user shares this configuration and does not need to enter credentials. In Admin Panel, the values are read-only and can be tested with **Test Connection**.
5. For a local build, copy `.env.example` to `.env.local` and set those same two `VITE_` variables, or configure them through **Admin Panel → Years & System**. Local Admin Panel settings are stored in that browser's local storage.
6. Import workspace data yourself using **Admin Panel → Import / Export**.

## Security warning

The initial schema grants public read/write access to the workspace tables. Local app accounts and roles are only a browser-side UI gate; they do not secure the Supabase database and are not shared across devices. Anyone who can access the deployed app and its public key can read and modify database contents, regardless of the app role. Use this setup only if that exposure is acceptable.

Only use the project's public anon/publishable key in the app. **Never use a service-role or secret key** in browser settings, source code, environment variables prefixed with `VITE_`, or GitHub Pages. GitHub Actions variables are appropriate for the public key and URL because both are included in the frontend bundle.

## Local checks

```sh
bun install --frozen-lockfile
bun run lint
bun run build
```
