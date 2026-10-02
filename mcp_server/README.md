# Veilla MCP server

A small MCP server that lets Claude (Desktop / Code / any compatible
client) interrogate Veilla's editorial data in natural language.

It runs locally over stdio, and is also mounted on the API over HTTP
behind a shared token. It acts as one configured user.

## Structure

```
mcp_server/
├── server.py          entry point + tool registration
├── _identity.py       which user the server acts as
├── tools/             one module per tool (or pair of tools)
├── prompts/
│   └── veilla_doctrine.md   loaded as an MCP resource, not documentation
└── README.md          you are here
```

The tools fall into two groups: **reading** the corpus
(`search_stories`, `get_story`, `get_article`, `query_sample`,
`search_entities`, `list_feeds`, `list_user_sources`), and **acting**
on it (`follow_story`, `unfollow_story`, `create_google_news_query`).

## Local setup

The MCP SDK is already pinned in the project's root `requirements.txt`
(`mcp==1.15.0` + `sse-starlette<2.0`). After a fresh clone:

```bash
pip install -r requirements.txt
```

You also need the project's `.env` set up with the Supabase DB URL —
the same env the API and worker use. The MCP server reuses `src/db.py`
to query the same database.

One more variable is required, because the server acts on behalf of
one user:

```
VEILLA_MCP_USER_SLUG=...    # a slug from public.users
```

Unset, a tool that needs it raises an error naming the variable rather
than guessing. See `_identity.py`.

## Run the server (stdio)

```bash
python -m mcp_server.server
```

The process opens stdin/stdout for MCP protocol traffic. **Don't run
it in a shell where you'll type — Claude Desktop will spawn it as a
subprocess.**

To verify the tool registers correctly without launching a client, you
can do a quick sanity check:

```bash
python -c "from mcp_server.server import mcp; print('OK —', list(mcp._tool_manager.list_tools()))"
```

You should see `search_stories` among the tools listed.

## Connect Claude Desktop

Edit Claude Desktop's config file:

- **macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** : `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux** : `~/.config/Claude/claude_desktop_config.json`

Add (or extend) the `mcpServers` section:

```json
{
  "mcpServers": {
    "veilla": {
      "command": "python",
      "args": ["-m", "mcp_server.server"],
      "cwd": "/absolute/path/to/veilla-news"
    }
  }
}
```

Replace `cwd` with the absolute path to your local Veilla checkout.
Restart Claude Desktop. A "Veilla" entry should appear in the tools
list (small icon at the bottom of the chat).

## Connect Claude Code

In a Claude Code session, add the MCP server via:

```bash
claude mcp add veilla -- python -m mcp_server.server
```

Run that from the project root so Claude Code resolves the working
directory automatically.

## Try it

In Claude Desktop (with the Veilla MCP connected), type any of:

- *"List my European sources"*
- *"Which Japanese sources do I follow?"*
- *"How many feeds are in the catalogue?"*

Claude should call `list_user_sources` or `list_feeds` with the right
`country` or `region` and respond using the Veilla doctrine.

## Identity and auth

- **Identity** : the server acts as one user, set with
  `VEILLA_MCP_USER_SLUG` — in the `env` block of your MCP client config,
  or in the project's `.env`. It is required; a tool that cannot find it
  raises an error naming the variable rather than guessing.
- **Auth** : none over stdio. Anyone running the server gets full
  access to that user's data. Acceptable because it is
  local-only and bound to a single client on the dev machine.
- **Over HTTP** : a shared bearer token — see below.

## Adding a new tool

1. Create `mcp_server/tools/<tool_name>.py` with the function + docstring.
2. Export it in `mcp_server/tools/__init__.py`.
3. Register it in `mcp_server/server.py` via `mcp.tool()(your_tool)`.
4. Update `prompts/veilla_doctrine.md` if the tool changes the workflow.
5. Restart the server (Claude Desktop auto-reconnects).

That's it.

## Over HTTP

The same server is mounted on the API at `/mcp/`, for clients that
cannot spawn a local process. `server.py` sets
`FastMCP(streamable_http_path="/")` so the mount produces `/mcp/` rather
than `/mcp/mcp`. The trailing slash is part of the URL: the API turns
off redirects, so `/mcp` without it is a 404.

**The lifespan has to be chained.** `src/api.py` merges the MCP sub-app's
lifespan into its own; without it, `POST /mcp` fails at runtime with
"Task group is not initialized". It is not optional and it is not
obvious — hence this paragraph.

Authentication is a single shared bearer token, `MCP_SHARED_TOKEN`.
Three forms are accepted, because third-party clients differ in what
they let you configure: `Authorization: Bearer <token>`, a bare
`Authorization: <token>`, and `?token=<token>`. Unset, `/mcp` answers
503 rather than running open.

What that buys, and what it does not: one token means one logical
caller, so there is no per-user attribution and no audit of which tool
was invoked — the request log shows `POST /mcp → 200` and nothing more.
There is no rate limit either. All three are acceptable while the token
is shared with one trusted integration, and all three need solving
before it is shared more widely.
