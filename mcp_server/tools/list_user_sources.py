"""
list_user_sources — MCP tool.

Lists the sources the current user subscribes to, one row per source
however many of its feeds they follow. A new account follows the
catalogue entries flagged `starter`; subscriptions are not changed
through MCP.

Acts as the single user named by VEILLA_MCP_USER_SLUG (see
mcp_server/_identity.py).
"""
from mcp_server._identity import current_user_slug
from mcp_server.tools._filters import resolve_country_filter
from src.db import get_connection


def list_user_sources(
    country: str | None = None,
    region:  str | None = None,
) -> dict:
    """List the sources the current user subscribes to.

    A source appears here once the user subscribes to at least one of its
    feeds. For feed-level detail, or to browse the whole catalogue, use
    `list_feeds`.

    Args:
        country: Exact-match country filter. Accepts:
              - ISO 3166-1 alpha-2 code: 'FR', 'US', 'JP', 'DE', ...
              - Regional code as a TAG: 'EUR' matches sources tagged
                specifically at the regional level (e.g. Euronews), NOT
                European country members. Use `region='EUR'` for that.
              - 'GLB' for global sources.
        region: Broad-scope region filter. Accepts 'EUR', 'MID', 'ASI',
            'AFR', 'LAT', 'OCE'. Matches every source from a member
            country PLUS sources tagged at the regional level. Use this
            when the user wants "all European sources", etc.

        `country` and `region` are mutually exclusive — pass at most one.

    Returns:
        A dict with:
          - n_sources:  int — number of sources after filters
          - user_slug:  str — which user these are scoped to
          - filters:    dict of the filters applied
          - sources:    list of {name, domain, country}

    Use this when the user asks about:
      - "Which sources do I personally follow?"
      - "Show me my European subscriptions." → region='EUR'
      - "Am I subscribed to any French source?" → country='FR'
    """
    country_codes = resolve_country_filter(country=country, region=region)

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT DISTINCT s.name, s.domain, s.country
              FROM sources s
              JOIN monitors      m   ON m.source_id    = s.id
              JOIN subscriptions sub ON sub.monitor_id = m.id
              JOIN users         u   ON u.id           = sub.user_id
             WHERE u.slug = %s
               AND (%s::text[] IS NULL OR s.country = ANY(%s::text[]))
             ORDER BY s.name
            """,
            (current_user_slug(), country_codes, country_codes),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    sources = [
        {"name": r[0], "domain": r[1], "country": r[2]}
        for r in rows
    ]

    return {
        "n_sources": len(sources),
        "user_slug": current_user_slug(),
        "filters":   {"country": country, "region": region},
        "sources":   sources,
    }
