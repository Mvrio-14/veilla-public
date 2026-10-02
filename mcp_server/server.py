"""
Veilla MCP server.

Boots a FastMCP server over stdio, registers the tools in
`mcp_server/tools/`, and loads the doctrine markdown as a resource so
connected clients (Claude Desktop / Code) get the Veilla editorial
context automatically.

Run locally:

    python -m mcp_server.server

Connect Claude Desktop by adding to claude_desktop_config.json:

    {
      "mcpServers": {
        "veilla": {
          "command": "python",
          "args": ["-m", "mcp_server.server"],
          "cwd": "/path/to/veilla-news"
        }
      }
    }

See mcp_server/README.md for the full setup walkthrough.

# Why FastMCP

FastMCP (= `mcp.server.fastmcp.FastMCP`, part of the official `mcp`
SDK since late 2024) gives us decorator-based tool registration similar
to FastAPI. We pin mcp==1.15 in requirements.txt because newer versions
bump starlette to 1.x which breaks our FastAPI 0.115 API server.
"""
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from mcp_server.tools.create_google_news_query import create_google_news_query
from mcp_server.tools.follow_story import follow_story, unfollow_story
from mcp_server.tools.get_article import get_article
from mcp_server.tools.get_story import get_story
from mcp_server.tools.list_feeds import list_feeds
from mcp_server.tools.list_user_sources import list_user_sources
from mcp_server.tools.query_sample import query_sample
from mcp_server.tools.search_entities import search_entities
from mcp_server.tools.search_stories import search_stories

# Server name shown in the MCP client's UI ("Veilla" appears in the
# tool picker / status bar of Claude Desktop).
# `streamable_http_path="/"` so that, mounted under `/mcp` in
# `src/api.py`, the endpoint is `/mcp/` rather than `/mcp/mcp`.
mcp = FastMCP("Veilla", streamable_http_path="/")

# Register the tools. The decorator-style alternative would be
# `@mcp.tool()` next to the function, but we keep tools in their own
# files for readability and register them centrally here — easier to
# see at a glance what the server exposes.
mcp.tool()(list_user_sources)
mcp.tool()(search_stories)
mcp.tool()(search_entities)
mcp.tool()(query_sample)
mcp.tool()(get_story)
mcp.tool()(get_article)
mcp.tool()(follow_story)
mcp.tool()(unfollow_story)
mcp.tool()(list_feeds)
mcp.tool()(create_google_news_query)


# Doctrine resource: a single markdown file with the editorial guidance.
# Loaded once at server start. Clients (Claude Desktop) pick it up
# automatically when they connect and use it as a system-prompt-like
# context for the conversation.
#
# Resource URI: `veilla://doctrine` — the URI scheme is arbitrary, we
# pick `veilla://` to namespace our resources clearly.
_DOCTRINE_PATH = Path(__file__).parent / "prompts" / "veilla_doctrine.md"


@mcp.resource("veilla://doctrine")
def doctrine() -> str:
    """Veilla editorial doctrine — how the assistant should reason about
    sources, queries, and replies. Loaded automatically by MCP
    clients.
    """
    return _DOCTRINE_PATH.read_text(encoding="utf-8")


def main() -> None:
    """Entry point — run the server over stdio.

    This is the local-development path (Claude Desktop launches this
    script as a subprocess and talks to it over stdin/stdout).

    For online access (remote MCP clients), the
    same `mcp` object is mounted on the Veilla FastAPI at `/mcp`
    (see `src/api.py`, `MCP_SHARED_TOKEN` bearer auth). Both
    transports coexist — you can keep running this locally over stdio
    while the API also exposes the network endpoint.
    """
    mcp.run(transport="stdio")


# Publicly re-exported for `src/api.py` to mount as a Starlette sub-app.
# Import it as: `from mcp_server.server import mcp` — the object carries
# every tool + resource registered above.
__all__ = ["mcp", "main"]


if __name__ == "__main__":
    main()
