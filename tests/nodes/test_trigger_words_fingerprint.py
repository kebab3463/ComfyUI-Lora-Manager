"""Nodes that output library trigger words must re-run after a trigger-word edit.

ComfyUI caches a node's outputs while its inputs are unchanged. These nodes read
trigger words from the library instead of their inputs, so they expose the
library's trigger words through IS_CHANGED.
"""

from unittest.mock import AsyncMock

import pytest

from py.nodes.create_hook_lora import CreateHookLoraLM
from py.nodes.lora_loader import LoraLoaderLM, LoraTextLoaderLM
from py.nodes.lora_stacker import LoraStackerLM
from py.nodes.utils import library_trigger_words_fingerprint
from py.nodes.wanvideo_lora_select import WanVideoLoraSelectLM
from py.nodes.wanvideo_lora_select_from_text import WanVideoLoraTextSelectLM
from py.services import service_registry

TRIGGER_WORD_NODES = [
    LoraStackerLM,
    LoraLoaderLM,
    LoraTextLoaderLM,
    CreateHookLoraLM,
    WanVideoLoraSelectLM,
    WanVideoLoraTextSelectLM,
]


def _lora(path, words, **extra):
    return {"file_path": path, "civitai": {"trainedWords": list(words)}, **extra}


@pytest.fixture
def library(mock_scanner, monkeypatch):
    monkeypatch.setattr(
        service_registry.ServiceRegistry,
        "get_lora_scanner",
        AsyncMock(return_value=mock_scanner),
    )
    mock_scanner._cache.raw_data = [
        _lora("/loras/a.safetensors", ["alpha"]),
        _lora("/loras/b.safetensors", ["beta", "gamma"]),
        {"file_path": "/loras/c.safetensors", "civitai": {}},
    ]
    return mock_scanner._cache


@pytest.mark.asyncio
async def test_fingerprint_changes_when_trigger_words_are_edited(library):
    before = await library_trigger_words_fingerprint()

    library.raw_data[1]["civitai"]["trainedWords"] = ["beta", "delta"]

    assert await library_trigger_words_fingerprint() != before


@pytest.mark.asyncio
async def test_fingerprint_changes_when_trigger_words_are_added(library):
    before = await library_trigger_words_fingerprint()

    library.raw_data[2]["civitai"]["trainedWords"] = ["new"]

    assert await library_trigger_words_fingerprint() != before


@pytest.mark.asyncio
async def test_fingerprint_ignores_cache_order_and_other_metadata(library):
    before = await library_trigger_words_fingerprint()

    library.raw_data.reverse()
    library.raw_data[0]["favorite"] = True
    library.raw_data[0]["model_name"] = "Renamed in the UI"

    assert await library_trigger_words_fingerprint() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("node_class", TRIGGER_WORD_NODES, ids=lambda cls: cls.__name__)
async def test_node_reruns_after_a_trigger_word_edit(node_class, library):
    # ComfyUI passes the node's constant inputs; the result must not depend on them.
    before = await node_class.IS_CHANGED(loras={"__value__": []}, text="")
    unchanged = await node_class.IS_CHANGED(loras={"__value__": []}, text="")

    library.raw_data[0]["civitai"]["trainedWords"] = ["alpha", "edited"]
    after = await node_class.IS_CHANGED(loras={"__value__": []}, text="")

    assert before == unchanged
    assert after != before
