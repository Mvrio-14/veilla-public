"""
Admin surface — endpoints, domain logic, and audit log for the /admin/* API.

Gated by `ADMIN_EMAILS` env var: comma-separated list of email addresses
authorized to access any /admin/* endpoint. Anything not on the list gets
a 403 even if it has a valid Supabase JWT.

Layout:
  src/admin/auth.py            require_admin FastAPI dependency
  src/admin/audit.py           log_action() helper + log shape
  src/admin/feeds_sources.py   CRUD for the unified Sources + Feeds surface
  src/admin/users.py           CRUD for users, including their plan
  src/admin/probe.py           dry-run fetch of a candidate feed URL
  src/admin/validation.py      field validators shared by the endpoints

Why a dedicated module: keeps the admin code path visually + structurally
separated from the user-app API. Easier to grep, easier to audit, easier
to later split into its own subdomain app if needed.
"""
