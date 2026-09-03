"""Tests for the exclusive version-pin endpoint."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest

from py.routes.handlers.model_handlers import ModelManagementHandler


class StubRequest:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload

    async def json(self):
        return self._payload


def make_handler(siblings: List[Dict[str, Any]]):
    """Build a handler whose service reports *siblings* for any file path."""
    writes: List[Dict[str, Any]] = []

    async def save_metadata_updates(*, file_path, updates, metadata_loader, update_cache):
        writes.append({"file_path": file_path, "updates": updates})
        return {}

    metadata_sync = MagicMock()
    metadata_sync.save_metadata_updates = AsyncMock(side_effect=save_metadata_updates)
    metadata_sync.load_local_metadata = AsyncMock(return_value={})

    service = MagicMock()
    service.find_group_siblings = AsyncMock(return_value=siblings)
    service.scanner = SimpleNamespace(update_single_model_cache=AsyncMock())

    handler = ModelManagementHandler(
        service=service,
        logger=logging.getLogger(__name__),
        metadata_sync=metadata_sync,
        preview_service=MagicMock(),
        tag_update_service=MagicMock(),
        lifecycle_service=MagicMock(),
    )
    return handler, writes, service


async def body(response) -> Dict[str, Any]:
    return json.loads(response.text)


@pytest.mark.asyncio
async def test_pinning_clears_a_previously_pinned_sibling():
    """A group must never end up with two competing representatives."""
    siblings = [
        {"file_path": "/m/v1.safetensors", "pinned": True},
        {"file_path": "/m/v2.safetensors", "pinned": False},
    ]
    handler, writes, _ = make_handler(siblings)

    response = await handler.pin_version(
        StubRequest({"file_path": "/m/v2.safetensors", "pinned": True})
    )
    payload = await body(response)

    assert payload["success"] is True
    assert payload["unpinned"] == ["/m/v1.safetensors"]
    assert writes == [
        {"file_path": "/m/v1.safetensors", "updates": {"pinned": False}},
        {"file_path": "/m/v2.safetensors", "updates": {"pinned": True}},
    ]


@pytest.mark.asyncio
async def test_pinning_skips_siblings_that_were_not_pinned():
    """Only the stale pin is rewritten, not every version in the group."""
    siblings = [
        {"file_path": "/m/v1.safetensors", "pinned": False},
        {"file_path": "/m/v2.safetensors", "pinned": False},
        {"file_path": "/m/v3.safetensors", "pinned": False},
    ]
    handler, writes, _ = make_handler(siblings)

    await handler.pin_version(
        StubRequest({"file_path": "/m/v2.safetensors", "pinned": True})
    )

    assert writes == [{"file_path": "/m/v2.safetensors", "updates": {"pinned": True}}]


@pytest.mark.asyncio
async def test_unpinning_leaves_siblings_untouched():
    """Clearing a pin must not disturb the rest of the group."""
    siblings = [
        {"file_path": "/m/v1.safetensors", "pinned": True},
        {"file_path": "/m/v2.safetensors", "pinned": False},
    ]
    handler, writes, service = make_handler(siblings)

    response = await handler.pin_version(
        StubRequest({"file_path": "/m/v1.safetensors", "pinned": False})
    )
    payload = await body(response)

    assert payload["pinned"] is False
    assert payload["unpinned"] == []
    assert writes == [{"file_path": "/m/v1.safetensors", "updates": {"pinned": False}}]
    # No sibling lookup is needed when clearing.
    service.find_group_siblings.assert_not_awaited()


@pytest.mark.asyncio
async def test_pinned_defaults_to_true():
    handler, writes, _ = make_handler([])

    await handler.pin_version(StubRequest({"file_path": "/m/v1.safetensors"}))

    assert writes == [{"file_path": "/m/v1.safetensors", "updates": {"pinned": True}}]


@pytest.mark.asyncio
async def test_missing_file_path_is_rejected():
    handler, writes, _ = make_handler([])

    response = await handler.pin_version(StubRequest({"pinned": True}))

    assert response.status == 400
    assert writes == []


@pytest.mark.asyncio
async def test_ungroupable_model_still_pins_itself():
    """find_group_siblings returns nothing for a standalone model."""
    handler, writes, _ = make_handler([])

    response = await handler.pin_version(
        StubRequest({"file_path": "/m/solo.safetensors", "pinned": True})
    )

    assert (await body(response))["success"] is True
    assert writes == [{"file_path": "/m/solo.safetensors", "updates": {"pinned": True}}]
