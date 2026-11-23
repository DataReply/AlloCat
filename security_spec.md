# Security Notes

## Current access model

- The app login (`admin` / `admin` by default) is a client-side gate, not server-enforced authentication.
- Supabase anonymous Auth provides the browser with a database identity; it does not verify the local username or password.
- The initial Supabase schema grants `anon` and `authenticated` roles public read/write access to workspace tables. Anyone with the deployed app and its public anon/publishable key can read, change, or delete workspace data.
- Email invites, join codes, and local login do not restrict access to the database under these policies.
- Only a Supabase anon/publishable key may be entered in Admin Panel. A service-role or secret key must never be exposed to browser code.

Use this configuration only when public database access is acceptable. For private data or enforceable user roles, replace the public policies and use a trusted backend with server-side authentication before deploying.
