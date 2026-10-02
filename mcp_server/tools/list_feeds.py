"""
list_feeds — MCP tool (feed-level visibility).

Where `list_user_sources` aggregates to the source level (= the
editorial entity), this tool exposes the FEED level (= the actual RSS
endpoint). One source typically has several feeds (Le Monde →
Politique / Économie / International / …), and a subscription operates
at feed granularity.

# Two scopes

  - `user`     : feeds the user subscribes to. Default.
  - `catalog`  : every feed Veilla knows about, followed or not.

Each returned feed carries a `subscribed` flag whatever the scope, so the
agent can answer "am I subscribed to this?" in a single call.

Acts as the single user named by VEILLA_MCP_USER_SLUG (see
mcp_server/_identity.py).
"""
from mcp_server._identity import current_user_slug
from mcp_server.tools._filters import resolve_country_filter
from src.db import get_connection

SCOPES = ("user", "catalog")
FEED_STATUSES = ("active", "degraded", "dead")


def list_feeds(
    scope:       str         = "user",
    source_name: str | None  = None,
    country:     str | None  = None,
    region:      str | None  = None,
    subscribed:  bool | None = None,
    status:      str | None  = None,
) -> dict:
    """List feeds at the chosen scope, each with a `subscribed` flag.

    Args:
        scope: "user" (your subscriptions, default) or "catalog"
            (everything Veilla knows).
        source_name: exact match on the editorial source name
            (e.g. "Le Figaro"). Case-sensitive.
        country: ISO 3166-1 alpha-2 ("FR"), regional tag ("EUR" for
            Euronews-style), or "GLB" for global.
        region: broad-scope region ("EUR", "MID", "ASI", "AFR", "LAT",
            "OCE"). Expands to all member countries + the regional
            tag. Mutually exclusive with `country`.
        subscribed: with scope="catalog", keep only the feeds the user
            is (True) or is not (False) subscribed to.
        status: filter on the feed lifecycle: 'active' (healthy),
            'degraded' (recent failures), 'dead' (consider removing).

    Returns:
        {
          "scope":     str,
          "n_feeds":   int,
          "user_slug": str,
          "filters":   { ... echoed args ... },
          "feeds": [{
              "slug":        "le-figaro-politique",
              "name":        "Le Figaro — Politique",
              "url":         "https://...",
              "source_name": "Le Figaro",
              "country":     "FR",
              "status":      "active",
              "subscribed":  bool,
          }]
        }

    Use this when the user asks:
      - "Which feeds do I follow?" → scope="user"
      - "Which Le Figaro feeds am I on?" → scope="user",
                                            source_name="Le Figaro"
      - "What else could I follow from Bloomberg?" →
            scope="catalog", source_name="Bloomberg", subscribed=False
    """
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}, got {scope!r}")
    if status is not None and status not in FEED_STATUSES:
        raise ValueError(
            f"status must be one of {FEED_STATUSES} or None, got {status!r}"
        )
    if subscribed is not None and scope != "catalog":
        # Every feed in scope="user" is subscribed by definition.
        raise ValueError("subscribed filter only applies when scope='catalog'")

    country_codes = resolve_country_filter(country=country, region=region)
    scope_sql = "AND sub.user_id IS NOT NULL" if scope == "user" else ""

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT c.slug,
                   c.name,
                   c.config ->> 'url',
                   COALESCE(s.name, '')           AS source_name,
                   COALESCE(s.country, c.country) AS country,
                   COALESCE(m.status, 'active')   AS status,
                   (sub.user_id IS NOT NULL)      AS subscribed
              FROM catalog c
              LEFT JOIN sources  s ON s.id = c.source_id
              LEFT JOIN monitors m ON m.catalog_id = c.id
              LEFT JOIN subscriptions sub
                     ON sub.monitor_id = m.id
                    AND sub.user_id = (SELECT id FROM users WHERE slug = %s)
             WHERE (%s::text IS NULL OR s.name = %s)
               AND (%s::text[] IS NULL
                    OR COALESCE(s.country, c.country) = ANY(%s::text[]))
               {scope_sql}
          ORDER BY source_name, c.name
            """,
            (current_user_slug(), source_name, source_name,
             country_codes, country_codes),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    feeds = [
        {
            "slug":        r[0],
            "name":        r[1],
            "url":         r[2],
            "source_name": r[3] or None,
            "country":     r[4],
            "status":      r[5],
            "subscribed":  bool(r[6]),
        }
        for r in rows
    ]

    # Cheap to apply in Python, and it keeps the SQL shape-stable.
    if subscribed is not None:
        feeds = [f for f in feeds if f["subscribed"] == subscribed]
    if status is not None:
        feeds = [f for f in feeds if f["status"] == status]

    return {
        "scope":     scope,
        "n_feeds":   len(feeds),
        "user_slug": current_user_slug(),
        "filters":   {
            "source_name": source_name,
            "country":     country,
            "region":      region,
            "subscribed":  subscribed,
            "status":      status,
        },
        "feeds":     feeds,
    }
