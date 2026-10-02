"""Every model the pipeline calls has a price, so its calls are not logged
at zero cost."""
import importlib

import pytest

from src.llm_costs import PRICES

STEPS = (
    "article_translator", "embedder", "entity_disambiguator", "extractor",
    "normalizer", "story_state", "story_translator",
)


@pytest.mark.parametrize("module", STEPS)
def test_every_step_model_has_a_price(module) -> None:
    assert importlib.import_module(f"src.{module}").MODEL in PRICES
