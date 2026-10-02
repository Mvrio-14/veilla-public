"""
Veilla MCP server.

Exposes a small set of tools and a doctrine that lets Claude (Desktop /
Code / any MCP client) interrogate Veilla's editorial data — stories,
sources, entities — in natural language.

Module is named `mcp_server` rather than `mcp` to avoid shadowing the
PyPI `mcp` SDK package (which we import inside this server).

The user the server acts as comes from VEILLA_MCP_USER_SLUG (see
`mcp_server/_identity.py`). Run over stdio with:

    python -m mcp_server.server

Then connect Claude Desktop via its config (see mcp_server/README.md).
The same tools are served over HTTP at `/mcp/` by the API (src/api.py).
"""
