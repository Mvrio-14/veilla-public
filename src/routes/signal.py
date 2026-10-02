"""
Signal and Monitors routes, under `/me`: the reader's monitors, their
context, their watchers, and what the watchers decided.

Writing the context or a watcher is authoring, so it takes the pro plan
(src/write_access.py); reading is open to every signed-in reader.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from src import signal
from src.auth import AuthContext, get_required_auth, resolve_user_id
from src.db import get_connection
from src.loaders.monitors import load_reader_monitor, load_reader_monitors
from src.routes._shared import DATA_CACHE_PRIVATE

router = APIRouter(prefix="/me", tags=["signal"])

CONTEXT_MAX = 4000
REQUEST_MAX = 2000


def _reader(conn, auth: AuthContext) -> str:
    user_id = resolve_user_id(conn, auth)
    if user_id is None:
        raise HTTPException(status_code=403, detail="No account linked")
    return user_id


# ── Monitors ────────────────────────────────────────────────────────────────
@router.get("/monitors")
def list_monitors(response: Response, auth: AuthContext = Depends(get_required_auth)) -> list[dict]:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        return load_reader_monitors(conn.cursor(), _reader(conn, auth))
    finally:
        conn.close()


@router.get("/monitors/{monitor_id}")
def get_monitor(monitor_id: int, response: Response,
                auth: AuthContext = Depends(get_required_auth)) -> dict:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        detail = load_reader_monitor(conn.cursor(), _reader(conn, auth), monitor_id)
    finally:
        conn.close()
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Monitor {monitor_id} not found")
    return detail


# ── Context ─────────────────────────────────────────────────────────────────
class ContextBody(BaseModel):
    body: str = Field(max_length=CONTEXT_MAX)


@router.get("/signal/context")
def get_context(response: Response, auth: AuthContext = Depends(get_required_auth)) -> dict:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        return signal.load_context(conn.cursor(), _reader(conn, auth))
    finally:
        conn.close()


@router.put("/signal/context")
def put_context(body: ContextBody, auth: AuthContext = Depends(get_required_auth)) -> dict:
    conn = get_connection()
    try:
        saved = signal.save_context(conn.cursor(), _reader(conn, auth), body.body)
        conn.commit()
        return saved
    finally:
        conn.close()


# ── Watchers ──────────────────────────────────────────────────────────────────
class WatcherCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    request: str = Field(min_length=1, max_length=REQUEST_MAX)
    # Empty: every monitor the reader follows, including later ones.
    monitor_ids: list[int] = Field(default_factory=list)


class WatcherUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    request: str | None = Field(default=None, min_length=1, max_length=REQUEST_MAX)
    status: Literal["active", "paused"] | None = None
    monitor_ids: list[int] | None = None


@router.get("/signal/watchers")
def list_watchers(response: Response, auth: AuthContext = Depends(get_required_auth)) -> list[dict]:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        return signal.load_watchers(conn.cursor(), _reader(conn, auth))
    finally:
        conn.close()


@router.post("/signal/watchers", status_code=201)
def create_watcher(body: WatcherCreate, auth: AuthContext = Depends(get_required_auth)) -> dict:
    if not body.name.strip() or not body.request.strip():
        raise HTTPException(status_code=422, detail="Name and request cannot be blank")
    conn = get_connection()
    try:
        watcher = signal.create_watcher(conn.cursor(), _reader(conn, auth),
                                    body.name, body.request, body.monitor_ids)
        conn.commit()
        return watcher
    finally:
        conn.close()


@router.get("/signal/watchers/{watcher_id}")
def get_watcher(watcher_id: int, response: Response,
              auth: AuthContext = Depends(get_required_auth)) -> dict:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        watcher = signal.load_watcher(conn.cursor(), _reader(conn, auth), watcher_id)
    finally:
        conn.close()
    if watcher is None:
        raise HTTPException(status_code=404, detail=f"Watcher {watcher_id} not found")
    return watcher


@router.patch("/signal/watchers/{watcher_id}")
def patch_watcher(watcher_id: int, body: WatcherUpdate,
                auth: AuthContext = Depends(get_required_auth)) -> dict:
    if (body.name is not None and not body.name.strip()) or \
       (body.request is not None and not body.request.strip()):
        raise HTTPException(status_code=422, detail="Name and request cannot be blank")
    conn = get_connection()
    try:
        watcher = signal.update_watcher(conn.cursor(), _reader(conn, auth), watcher_id,
                                    name=body.name, request=body.request,
                                    status=body.status, monitor_ids=body.monitor_ids)
        if watcher is None:
            raise HTTPException(status_code=404, detail=f"Watcher {watcher_id} not found")
        conn.commit()
        return watcher
    finally:
        conn.close()


@router.delete("/signal/watchers/{watcher_id}")
def delete_watcher(watcher_id: int, auth: AuthContext = Depends(get_required_auth)) -> dict:
    """Idempotent: deleting a watcher that is not there, or not the
    caller's, changes nothing."""
    conn = get_connection()
    try:
        signal.delete_watcher(conn.cursor(), _reader(conn, auth), watcher_id)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Decisions ───────────────────────────────────────────────────────────────
@router.get("/signal/decisions")
def list_decisions(response: Response, auth: AuthContext = Depends(get_required_auth)) -> list[dict]:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        user_id = _reader(conn, auth)
        cur.execute("SELECT output_lang FROM users WHERE id = %s", (user_id,))
        (lang,) = cur.fetchone()
        return signal.load_decisions(cur, user_id, lang)
    finally:
        conn.close()
