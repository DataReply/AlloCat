# Security Notes

## Current access model

- App accounts (`admin` / `admin` by default) are stored in browser local storage. Passwords are salted and hashed, but account records and role assignments are under browser-user control and are not server-enforced.
- Admin, Editor, and Viewer roles apply only to UI behavior in that browser. They do not authenticate a user or protect Supabase data.
- Supabase anonymous Auth provides the browser with a database identity; it does not verify the local username or password.
- The initial Supabase schema grants `anon` and `authenticated` roles public read/write access to workspace tables. Anyone with the deployed app and its public anon/publishable key can read, change, or delete workspace data.
- Email invites, join codes, and local login do not restrict access to the database under these policies.
- Only a Supabase anon/publishable key may be entered in Admin Panel. A service-role or secret key must never be exposed to browser code.

Use this configuration only when public database access is acceptable. For private data or enforceable user roles, replace the public policies and use a trusted backend with server-side authentication before deploying. Browser-local app accounts are not shared across browsers or devices.
