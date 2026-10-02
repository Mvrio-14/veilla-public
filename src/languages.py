"""
The languages Veilla has readers in.

Every translation step in the worker — article titles and summaries,
story labels, syntheses, origins and updates — translates into the same
set of languages: the output language of every active user. Asking one
function keeps the steps agreeing on that set, and a language nobody
reads any more stops costing anything on the next pass.

English is never a target. The pipeline's own text is English — the
normaliser's `title_normalized` and `summary_normalized`, and every
story text — so an English reader is served it as it is.
"""

PIPELINE_LANGUAGE = "en"

_NAMES = {
    "fr": "French", "en": "English", "de": "German",
    "es": "Spanish", "it": "Italian", "pt": "Portuguese",
}


def reader_languages(conn) -> list[str]:
    """Distinct `output_lang` of active users, sorted for a stable order."""
    cur = conn.cursor()
    cur.execute(
        """SELECT DISTINCT output_lang
             FROM users
            WHERE active AND output_lang IS NOT NULL AND output_lang <> ''
         ORDER BY output_lang"""
    )
    return [row[0] for row in cur.fetchall()]


def translation_targets(conn) -> list[str]:
    """The reader languages the pipeline's English must be translated into."""
    return [lang for lang in reader_languages(conn) if lang != PIPELINE_LANGUAGE]


def language_name(code: str) -> str:
    """The English name of a language code, for prompts; the code itself
    when unknown."""
    return _NAMES.get(code, code)
