"""
Shared filter helpers for Veilla MCP tools.

Module-private (the leading underscore signals it's not a Tool to expose
via MCP — tools live in non-underscore files and get registered in
`server.py`).

Currently exposes:

  - `resolve_country_filter(country=None, region=None)` — translate a
    country code (exact match) OR a regional code (broad scope) into the
    list of `sources.country` values that should match.

Reuses the canonical taxonomy from `src/taxonomy.py` so we don't drift
from the rest of the project.
"""

from src.taxonomy import (
    GLOBAL_CODE,
    REGION_MEMBERS,
    REGIONAL_CODES,
    VALID_COUNTRY_CODES,
)


def resolve_country_filter(
    country: str | None = None,
    region:  str | None = None,
) -> list[str] | None:
    """Resolve a country OR region filter into the list of codes for a
    SQL `sources.country = ANY(...)` clause.

    Mutually exclusive — pass at most one of `country` or `region`.

    Args:
        country: exact-match filter. Accepts:
            - ISO 3166-1 alpha-2: 'FR', 'US', 'JP', 'DE', ...
            - Regional code as a TAG: 'EUR' matches sources tagged
              specifically at the regional level (e.g. Euronews), NOT
              the country members. To pull every European source, use
              the `region` argument instead.
            - 'GLB' for global sources (IMF, OECD, ...).
        region: broad-scope filter. Accepts one of 'EUR', 'MID', 'ASI',
            'AFR', 'LAT', 'OCE'. Matches every source from a member
            country PLUS sources tagged at that regional level. Use this
            when the user wants "all European sources", "all African
            sources", etc.

    Returns:
        - None when both args are None (= no filter).
        - A list of country codes to match against `sources.country`.

    Raises:
        ValueError if both args are set, or if a code isn't recognized.

    Examples:
        resolve_country_filter()                    # → None
        resolve_country_filter(country='FR')        # → ['FR']
        resolve_country_filter(country='EUR')       # → ['EUR']  (= tag exact)
        resolve_country_filter(country='GLB')       # → ['GLB']
        resolve_country_filter(region='EUR')        # → ['AD', 'AL', 'AT', ..., 'EUR']
    """
    if country is not None and region is not None:
        raise ValueError(
            "Provide either `country` or `region`, not both. "
            "`country='EUR'` matches sources tagged exactly 'EUR'; "
            "`region='EUR'` expands to all European country codes."
        )

    if country is not None:
        normalized = country.strip().upper()
        if not normalized:
            return None
        if normalized not in VALID_COUNTRY_CODES:
            raise ValueError(
                f"Unknown country code {country!r}. Expected an ISO "
                f"2-letter country code (e.g. 'FR', 'US', 'JP'), a "
                f"regional tag ({', '.join(REGIONAL_CODES)}), or "
                f"{GLOBAL_CODE!r} for global sources."
            )
        # Exact match on the tag, no expansion.
        return [normalized]

    if region is not None:
        normalized = region.strip().upper()
        if not normalized:
            return None
        if normalized not in REGIONAL_CODES:
            raise ValueError(
                f"Unknown region code {region!r}. Expected one of "
                f"{', '.join(REGIONAL_CODES)}."
            )
        # Expanded match: every member country + the regional tag itself.
        return list(REGION_MEMBERS[normalized]) + [normalized]

    return None
