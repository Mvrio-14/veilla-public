"""Veilla MCP tools — one file per tool.

Each tool is a small Python function exposed via `@mcp.tool()` in
`mcp_server/server.py`. Keeping tools in separate files keeps the
orchestrator thin and makes each tool readable in isolation.
"""
from mcp_server.tools.follow_story import follow_story, unfollow_story
from mcp_server.tools.get_article import get_article
from mcp_server.tools.get_story import get_story
from mcp_server.tools.list_user_sources import list_user_sources
from mcp_server.tools.search_stories import search_stories

__all__ = [
    "list_user_sources",
    "search_stories",
    "get_story",
    "get_article",
    "follow_story",
    "unfollow_story",
]
