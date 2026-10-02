"""
Who the MCP server acts as: one Veilla user.

The server is single-identity for now, because the transport carries no
identity of its own. Claude Desktop speaks over stdio to a process the
person launched themselves, and the HTTP mount is guarded by a single
shared token, so there is nobody else a request could be coming from.

That will change — per-request tokens are the obvious next step — and
when it does, `current_user_slug` is the only place to change. Tools ask
"who am I acting for?" instead of reading a constant, so the answer can
start depending on the request without any of them being touched.

## Why the environment and not the source

A slug baked into published code makes the repository look unfinished
and makes the server useless to anyone else who runs it, in exchange
for nothing: an env var is one line in an MCP client config.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

USER_ENV_VAR = "VEILLA_MCP_USER_SLUG"


def _require(env_var: str, what: str) -> str:
    """Read a required slug, or explain precisely which setting is missing.

    Raises rather than falling back to a default. A default would be a
    silent wrong answer — the tools would report an empty result, or
    somebody else's data, with nothing in the output to say why. An
    exception names the variable to set instead.
    """
    value = (os.environ.get(env_var) or "").strip()
    if not value:
        raise RuntimeError(
            f"{env_var} is not set. The Veilla MCP server acts on behalf of "
            f"a single {what}; set this to that {what}'s slug — in the `env` "
            f"block of your MCP client config, or in the project's .env."
        )
    return value


def current_user_slug() -> str:
    """The user every per-user tool acts on behalf of."""
    return _require(USER_ENV_VAR, "user")

