"""
HTTP routes, one module per domain.

Each module exposes a single `router` (a FastAPI `APIRouter`) that
`src/api.py` mounts. Splitting by domain rather than by size means a
reader looking for "what can I do to a story" opens `stories.py` and
finds all of it, and nothing else.

Route handlers stay thin on purpose: read the request, call into the
library under `src/`, shape the response. The business logic lives in
`src/admin/`, `src/loaders/`, `src/notifications.py` and their
neighbours — the split here only makes that separation visible in the
file tree.
"""
