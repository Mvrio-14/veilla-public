"""
Catalog -> DB sync (sources + catalog tables).

Reads `config/catalog.json`, the seed list of sources and their feeds,
and writes:
  - sources       (upsert by domain)
  - catalog (upsert by slug, then by URL; every entry is an `rss`
                   template, and a feed marked `"starter": true` is what
                   a new account follows — set when the entry is created,
                   then left to /admin)

Called at FastAPI app startup (src/api.py lifespan), but only seeds an
empty database — see `CLAUDE.md`. Also runnable as a CLI via
scripts/sync_catalog.py.

Nothing is fetched and nobody is subscribed here: an entry gets its
monitor when someone first follows it.

Idempotent. Fails fast on duplicate URLs in config.
"""
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from src.admin.feeds_sources import sync_public_monitor
from src.db import get_connection
from src.taxonomy import assert_valid_country_code
from src.templates import prepare as prepare_template

ROOT    = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "config" / "catalog.json"


# ── Slug generation ─────────────────────────────────────────────────────────
def slugify(name: str) -> str:
    """Deterministic ASCII slug from a feed name.

    Strips accents (NFD decompose + ASCII drop), removes apostrophes
    (so "L'Usine Nouvelle" becomes "lusine-...", not "l-usine-..."),
    lowercases, and replaces every other run of non-alphanumeric
    characters with a single dash. Trimmed.

    Used for feeds added to catalog.json without an explicit `slug`
    field (= safety net so we never insert a row without an identity).

    Examples:
        "Le Monde - Économie"           → "le-monde-economie"
        "BFMTV - Politique"             → "bfmtv-politique"
        "L'Usine Nouvelle (Google News)" → "lusine-nouvelle-google-news"
        "WSJ - Markets"                 → "wsj-markets"
    """
    s = unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"[’‘'`]", "", s)  # strip apostrophes (don't dash-ify)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


# ── Loaders ─────────────────────────────────────────────────────────────────
def _load_catalog() -> list[dict]:
    """Read catalog.json. Validates country codes and auto-fills missing
    feed slugs (safety net — every catalog feed should have an explicit
    `slug` field but we don't want a crash if one is forgotten).

    Mutates the in-memory dicts (adds `slug` where absent) — callers can
    then rely on `f["slug"]` being present without further checks.
    """
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    for source in catalog:
        country = source.get("country")
        if country is not None:
            assert_valid_country_code(country, context=source.get("domain", "<unknown>"))

        for f in source.get("feeds", []):
            if not f.get("slug"):
                f["slug"] = slugify(f["name"])

    # Detect catalog slug collisions early. Same name -> same slug is fine
    # (= explicit duplicate, blocked elsewhere), but two DIFFERENT names
    # producing the same slug means we'd silently merge two feeds in DB.
    seen: dict[str, str] = {}  # slug -> name
    collisions: list[tuple[str, str, str]] = []
    for source in catalog:
        for f in source.get("feeds", []):
            s = f["slug"]
            if s in seen and seen[s] != f["name"]:
                collisions.append((s, seen[s], f["name"]))
            else:
                seen[s] = f["name"]
    if collisions:
        lines = ["catalog slug collisions detected — two feeds slugify to the same value:"]
        for s, a, b in collisions:
            lines.append(f"  slug={s!r} from {a!r} and {b!r}")
        lines.append("Pick distinct names, or set explicit `slug` fields in catalog.json.")
        raise ValueError("\n".join(lines))

    return catalog


# ── Sources ─────────────────────────────────────────────────────────────────
def _sync_sources(conn, catalog: list[dict]) -> dict:
    """Upsert sources from catalog. Returns {domain: source_id} + add/update lists.

    Also propagates the enrichment-related fields:
      - `paywall_policy` ∈ {'paywall', 'mixed', 'free'} (nullable)
      - `robots_skip`    bool (default FALSE)
    Both are optional in catalog.json — when omitted, the DB row defaults
    to NULL / FALSE. They are curation metadata, editable from /admin;
    nothing in the pipeline reads them today.
    """
    cursor  = conn.cursor()
    now     = datetime.now(timezone.utc).isoformat()
    added   = []
    updated = []

    domain_to_id = {}

    for source in catalog:
        name           = source["name"]
        domain         = source["domain"]
        country        = source.get("country")
        paywall_policy = source.get("paywall_policy")  # None when absent
        robots_skip    = bool(source.get("robots_skip", False))

        cursor.execute(
            "SELECT id, name, country, paywall_policy, robots_skip "
            "FROM sources WHERE domain = %s",
            (domain,),
        )
        row = cursor.fetchone()

        if row:
            src_id, db_name, db_country, db_policy, db_robots_skip = row
            changes = []
            if db_name != name:
                changes.append(f"name: {db_name} -> {name}")
            if db_country != country:
                changes.append(f"country: {db_country} -> {country}")
            if db_policy != paywall_policy:
                changes.append(f"paywall_policy: {db_policy} -> {paywall_policy}")
            if bool(db_robots_skip) != robots_skip:
                changes.append(f"robots_skip: {db_robots_skip} -> {robots_skip}")
            if changes:
                cursor.execute(
                    "UPDATE sources SET name = %s, country = %s, "
                    "paywall_policy = %s, robots_skip = %s WHERE id = %s",
                    (name, country, paywall_policy, robots_skip, src_id),
                )
                updated.append(f"{name}  " + ", ".join(changes))
        else:
            cursor.execute(
                "INSERT INTO sources (name, domain, country, "
                "paywall_policy, robots_skip, added_at) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (name, domain, country, paywall_policy, robots_skip, now),
            )
            src_id = cursor.fetchone()[0]
            added.append(name)

        domain_to_id[domain] = src_id

    conn.commit()
    return {"domain_to_id": domain_to_id, "added": added, "updated": updated}


# ── Catalog feeds ───────────────────────────────────────────────────────────
def _sync_catalog(conn, catalog: list[dict], domain_to_id: dict,
                        remove: bool = False) -> dict:
    """Upsert catalog entries from catalog.json.

    An entry is matched by slug, its stable identity, then by URL. When
    its URL changes, its public monitor — if anyone follows it — moves
    with it and starts from a clean slate: the new address may work where
    the old one failed, and the old conditional-GET headers mean nothing
    to it.
    """
    cursor = conn.cursor()

    wanted = []
    for source in catalog:
        for f in source.get("feeds", []):
            _, config, identity_key = prepare_template("rss", {"url": f["url"]})
            wanted.append({
                "slug":         f["slug"],  # ensured present by _load_catalog
                "name":         f["name"],
                "config":       config,
                "identity_key": identity_key,
                "feed_type":    f.get("feed_type"),
                "source_id":    domain_to_id.get(source["domain"]),
                "country":      source.get("country"),
                "starter":      bool(f.get("starter", False)),
            })

    # Fail fast on duplicate URLs — a copy-paste typo would otherwise crash
    # a later INSERT with an opaque UNIQUE violation.
    first_by_key: dict[str, dict] = {}
    duplicates: list[tuple[str, str, str]] = []
    for f in wanted:
        if f["identity_key"] in first_by_key:
            duplicates.append(
                (f["config"]["url"], first_by_key[f["identity_key"]]["name"], f["name"])
            )
        else:
            first_by_key[f["identity_key"]] = f
    if duplicates:
        lines = ["duplicate URLs detected in config — fix catalog.json:"]
        for url, first_name, second_name in duplicates:
            lines.append(f"  {url}")
            lines.append(f"    seen as : {first_name!r}")
            lines.append(f"    again as: {second_name!r}")
        raise ValueError("\n".join(lines))

    cursor.execute(
        "SELECT id, slug, identity_key, name, feed_type, source_id, country "
        "FROM catalog"
    )
    db_rows = cursor.fetchall()
    db_by_slug = {row[1]: row for row in db_rows}
    db_by_key  = {row[2]: row for row in db_rows}

    added, updated, skipped = [], [], []
    matched_ids: set[int] = set()

    for f in wanted:
        existing = db_by_slug.get(f["slug"]) or db_by_key.get(f["identity_key"])
        if existing is None:
            cursor.execute(
                """INSERT INTO catalog (
                       slug, name, template, config, identity_key,
                       feed_type, source_id, country, starter
                   ) VALUES (%s, %s, 'rss', %s::jsonb, %s, %s, %s, %s, %s)""",
                (
                    f["slug"], f["name"], json.dumps(f["config"]), f["identity_key"],
                    f["feed_type"], f["source_id"], f["country"], f["starter"],
                ),
            )
            added.append(f["name"])
            continue

        db_id, db_slug, db_key, *db_fields = existing
        matched_ids.add(db_id)

        # Caught here rather than as an opaque UniqueViolation: the entry
        # matched by slug wants a URL another entry already has.
        holder = db_by_key.get(f["identity_key"])
        if holder is not None and holder[0] != db_id:
            raise ValueError(
                f"catalog feed {f['slug']!r} (id={db_id}) wants url "
                f"{f['config']['url']!r}, which catalog feed {holder[1]!r} "
                f"(id={holder[0]}) already has. Reconcile the two in /admin."
            )

        # `starter` is only seeded: once an entry exists, /admin owns it.
        fields = ("name", "feed_type", "source_id", "country")
        changes = [
            f"{field}: {old} -> {f[field]}"
            for field, old in zip(fields, db_fields)
            if old != f[field]
        ]
        if db_slug != f["slug"]:
            changes.append(f"slug: {db_slug} -> {f['slug']}")
        if db_key != f["identity_key"]:
            changes.append(f"url -> {f['config']['url']}")
        if not changes:
            skipped.append(f["name"])
            continue

        cursor.execute(
            """UPDATE catalog
                  SET slug = %s, name = %s, config = %s::jsonb, identity_key = %s,
                      feed_type = %s, source_id = %s, country = %s
                WHERE id = %s""",
            (
                f["slug"], f["name"], json.dumps(f["config"]), f["identity_key"],
                f["feed_type"], f["source_id"], f["country"], db_id,
            ),
        )
        sync_public_monitor(cursor, db_id)
        updated.append(f"{f['name']}  " + ", ".join(changes))

    orphans = [row for row in db_rows if row[0] not in matched_ids]
    if remove and orphans:
        cursor.execute(
            "DELETE FROM catalog WHERE id = ANY(%s)",
            ([row[0] for row in orphans],),
        )

    conn.commit()
    return {
        "added": added, "updated": updated, "removed": [row[3] for row in orphans],
        "skipped": skipped, "remove_executed": remove,
    }


# ── Public entrypoint ───────────────────────────────────────────────────────
def sync_catalog_to_db(remove: bool = False, *, verbose: bool = True) -> dict:
    """
    Run the full catalog -> DB sync. Idempotent.

    Args:
        remove:  if True, delete catalog entries absent from catalog.json
        verbose: print one-line summary (default True; set False to silence)

    Returns: {"sources": {...}, "feeds": {...}} stats from the two
    sub-steps, `feeds` being the catalog entries.

    Raises:
        ValueError: on duplicate URLs in config (fail fast — don't write to DB)
    """
    conn = get_connection()
    try:
        catalog = _load_catalog()

        if verbose:
            n_catalog_feeds = sum(len(s.get("feeds", [])) for s in catalog)
            print(f"[catalog_sync] catalog: {len(catalog)} sources, "
                  f"{n_catalog_feeds} feeds")

        src_result  = _sync_sources(conn, catalog)
        feed_result = _sync_catalog(
            conn, catalog, src_result["domain_to_id"], remove=remove
        )

        if verbose:
            n_changes = (
                len(src_result["added"])  + len(src_result["updated"])
                + len(feed_result["added"]) + len(feed_result["updated"])
                + (len(feed_result["removed"]) if feed_result["remove_executed"] else 0)
            )
            if n_changes == 0:
                print("[catalog_sync] already in sync")
            else:
                print(
                    f"[catalog_sync] sources: +{len(src_result['added'])} "
                    f"~{len(src_result['updated'])}  "
                    f"feeds: +{len(feed_result['added'])} "
                    f"~{len(feed_result['updated'])}  "
                    f"orphans={len(feed_result['removed'])}"
                    f"{' (deleted)' if feed_result['remove_executed'] else ''}"
                )

        return {"sources": src_result, "feeds": feed_result}
    finally:
        conn.close()
