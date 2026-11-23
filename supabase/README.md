# Supabase setup

The app uses local username/password sign-in and Supabase Postgres/Realtime. Google sign-in and automatic data migration are not used. Existing data must be imported manually through the app's Import / Export tools.

## Configure a Supabase project

1. Create a Supabase project and run [`migrations/20261123000000_initial_schema.sql`](./migrations/20261123000000_initial_schema.sql) in the Supabase SQL Editor.
2. Enable **Anonymous Sign-Ins** under **Authentication → Providers**. The app creates an anonymous Supabase identity after the local login so Realtime and database requests have a Supabase user ID. No Google provider or OAuth redirect configuration is needed.
3. In the app, sign in with the local browser credentials and open **Admin Panel → Years & System**.
4. Enter the Supabase **Project URL** and **anon/publishable key**, save them, and select **Test Connection**. The settings are stored in that browser's local storage; enter them separately in other browsers.
5. Import workspace data yourself using **Admin Panel → Import / Export**.

## Security warning

The initial schema grants public read/write access to the workspace tables. The local `admin` / `admin` login is only a browser-side app gate; it does not secure the Supabase database. Anyone who can access the deployed app and its public key can read and modify database contents. Use this setup only if that exposure is acceptable.

Only enter the project's public anon/publishable key in the app. **Never use a service-role or secret key** in browser settings, source code, environment variables prefixed with `VITE_`, or GitHub Pages.

## Local checks

```sh
bun install --frozen-lockfile
bun run lint
bun run build
```
