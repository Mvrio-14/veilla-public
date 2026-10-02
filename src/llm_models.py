"""
The OpenAI models the pipeline calls.

Every step that writes or judges text runs on `TEXT_MODEL`, through its
own module-level `MODEL`. A step that should run on something else sets
its `MODEL` to that model instead; the model then needs a line in
`src.llm_costs.PRICES`, which a test checks.

Changing `EMBEDDING_MODEL` is not a one-line change: vectors from two
models cannot be compared, so every stored embedding would have to be
recomputed, and the column dimension may change with it.
"""
TEXT_MODEL      = "gpt-6-luna"
EMBEDDING_MODEL = "text-embedding-3-small"
