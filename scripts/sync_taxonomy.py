"""
Codegen: regenerate `webapp/lib/taxonomy.generated.ts` from
`src/taxonomy.py`.

Run this after editing taxonomy.py:

    python -m scripts.sync_taxonomy

The generated TypeScript file is committed to the repo (deterministic
output, no build-time step). The CI / a pre-commit hook can re-run this
and diff to refuse out-of-sync commits.

Why codegen vs writing the same data twice: keeping the
country→region map in both the Python worker and
`webapp/lib/format.ts` makes drift inevitable (an ME/AS/AF/EU
code collision bug was a symptom). Single source in
Python, mechanical projection to TS, zero drift surface.
"""
from __future__ import annotations

import json
from pathlib import Path

from src.taxonomy import (
    COUNTRY_CODES,
    COUNTRY_TO_BROAD,
    COUNTRY_TO_REGION,
    GLOBAL_CODE,
    GLOBAL_LABELS,
    REGION_BUCKET_LABELS,
    REGION_BUCKETS,
    REGION_MEMBERS,
    REGIONAL_CODES,
    REGIONAL_LABELS,
    VALID_COUNTRY_CODES,
)

HEADER = """\
// AUTO-GENERATED FROM src/taxonomy.py — DO NOT EDIT BY HAND.
// Re-run `python -m scripts.sync_taxonomy` after changing the source.
//
// The taxonomy lives in Python because the worker (the normalizer and
// extractor prompts) needs it at runtime. The TypeScript projection
// here is consumed by the SPA (filter expansion, country labels,
// sidebar grouping). Both must agree — codegen guarantees that.

"""

OUTPUT = Path("webapp/lib/taxonomy.generated.ts")


def emit_record(name: str, value: dict | list, value_type: str) -> str:
    """Emit a `const NAME: TYPE = JSON;` declaration with stable
    formatting. We re-serialize via json.dumps for deterministic output
    (sorted keys for dicts, no trailing whitespace). 2-space indent
    matches the rest of the webapp's TS style."""
    serialized = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=isinstance(value, dict))
    return f"export const {name}: {value_type} = {serialized} as const;\n\n"


def main() -> None:
    parts: list[str] = [HEADER]

    parts.append("// ── Regional codes ──\n")
    parts.append(emit_record("REGIONAL_CODES", REGIONAL_CODES, "readonly string[]"))
    parts.append(emit_record(
        "REGIONAL_LABELS",
        REGIONAL_LABELS,
        "Record<string, { fr: string; en: string }>",
    ))

    parts.append("// ── Global placeholder (replaces old `INT`) ──\n")
    parts.append(f'export const GLOBAL_CODE = "{GLOBAL_CODE}" as const;\n\n')
    parts.append(emit_record(
        "GLOBAL_LABELS",
        GLOBAL_LABELS,
        "{ fr: string; en: string }",
    ))

    parts.append("// ── Country ↔ broad region ──\n")
    parts.append(emit_record(
        "REGION_MEMBERS",
        REGION_MEMBERS,
        "Record<string, readonly string[]>",
    ))
    parts.append(emit_record(
        "COUNTRY_TO_BROAD",
        COUNTRY_TO_BROAD,
        "Record<string, string>",
    ))

    parts.append("// ── UI bucket grouping (sidebar Pays section) ──\n")
    parts.append(emit_record(
        "REGION_BUCKETS",
        REGION_BUCKETS,
        "readonly string[]",
    ))
    parts.append(emit_record(
        "REGION_BUCKET_LABELS",
        REGION_BUCKET_LABELS,
        "Record<string, Record<string, string>>",
    ))
    parts.append(emit_record(
        "COUNTRY_TO_REGION",
        COUNTRY_TO_REGION,
        "Record<string, string>",
    ))

    parts.append("// ── Curated dropdown list ──\n")
    parts.append(emit_record(
        "COUNTRY_CODES",
        COUNTRY_CODES,
        "readonly string[]",
    ))

    parts.append("// ── Validation set (every value legally storable in sources.country) ──\n")
    parts.append(emit_record(
        "VALID_COUNTRY_CODES",
        sorted(VALID_COUNTRY_CODES),
        "readonly string[]",
    ))

    OUTPUT.write_text("".join(parts), encoding="utf-8")
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
