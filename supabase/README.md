# Supabase setup and Firebase migration

The browser app now uses Supabase Auth (Google OAuth), Postgres, and Realtime. SQLite in IndexedDB remains a local mirror. The Firebase project is only used as the read-only migration source.

## Configure Supabase

1. Create a Supabase project and run [`migrations/20261123000000_initial_schema.sql`](./migrations/20261123000000_initial_schema.sql) in the Supabase SQL Editor.
2. In **Authentication → Providers**, enable Google. Configure the OAuth callback URL shown by Supabase in the Google OAuth client.
3. In **Authentication → URL Configuration**, set the site URL and add redirect URLs for the local app and deployed GitHub Pages URL, for example:
   - `http://localhost:3000/**`
   - `https://<owner>.github.io/<repository>/**`
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in a local environment file, using the Supabase Project URL and anon/publishable key. These two values are used by the browser app; never put the service-role key in a `VITE_` variable.
5. Add GitHub Actions repository secrets named `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` so the Pages workflow can build a configured app.

## Migrate the live workspace

The migration is non-destructive to Firebase and upserts records into Supabase. It exports a private JSON backup to the system temporary directory (or `MIGRATION_BACKUP_PATH` if set). Keep that backup secure.

1. Apply the Supabase schema above before running the migration.
2. Create a Firebase service-account JSON file with read access to Firestore and list/read access to Firebase Authentication. Keep it outside the repository.
3. Set these environment variables in the local shell (do not commit them):
   - `FIREBASE_SERVICE_ACCOUNT_PATH=/secure/path/to/firebase-service-account.json`
   - `SUPABASE_URL=https://<project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=<private service role key>`
   - Optionally, `SUPABASE_WORKSPACE_ID=default` and `MIGRATION_BACKUP_PATH=/secure/path/backup.json`
4. Run `bun run migrate:supabase` for a dry run. Review the counts and backup location.
5. Run `bun run migrate:supabase --apply` to migrate, or add `--confirm-overwrite` if the target workspace already contains records.

The migration creates corresponding Supabase Auth users by email where needed. Passwords and Firebase UIDs are not portable; configure Google OAuth in Supabase and have users sign in with their existing Google accounts. Membership and audit references are remapped to the new Supabase user IDs. Firebase data is not deleted.

## Local checks

Copy `.env.example` to `.env.local` and fill in the two public Supabase app values. Then use:

```sh
bun run lint
bun run build
```
