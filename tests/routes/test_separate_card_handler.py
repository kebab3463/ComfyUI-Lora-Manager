"""Tests for the separate-card endpoint (show a version as its own card)."""

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


def make_handler(versions: List[Dict[str, Any]]):
    """Build a handler whose service reports *versions* for any file path."""
    writes: List[Dict[str, Any]] = []

    async def save_metadata_updates(*, file_path, updates, metadata_loader, update_cache):
        writes.append({"file_path": file_path, "updates": updates})
        return {}

    metadata_sync = MagicMock()
    metadata_sync.save_metadata_updates = AsyncMock(side_effect=save_metadata_updates)
    metadata_sync.load_local_metadata = AsyncMock(return_value={})

    service = MagicMock()
    service.find_model_versions = AsyncMock(return_value=versions)
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
async def test_marks_a_single_version_without_touching_siblings():
    handler, writes, service = make_handler(
        [{"file_path": "/m/v1.safetensors"}, {"file_path": "/m/v2.safetensors"}]
    )

    response = await handler.set_separate_card(
        StubRequest({"file_path": "/m/v2.safetensors", "separate": True})
    )
    payload = await body(response)

    assert payload == {"success": True, "separate": True, "file_paths": ["/m/v2.safetensors"]}
    assert writes == [{"file_path": "/m/v2.safetensors", "updates": {"separate_card": True}}]
    service.find_model_versions.assert_not_called()


@pytest.mark.asyncio
async def test_all_versions_splits_every_local_version():
    handler, writes, _ = make_handler(
        [{"file_path": "/m/v1.safetensors"}, {"file_path": "/m/v2.safetensors"}]
    )

    response = await handler.set_separate_card(
        StubRequest({"file_path": "/m/v1.safetensors", "separate": True, "all_versions": True})
    )
    payload = await body(response)

    assert payload["file_paths"] == ["/m/v1.safetensors", "/m/v2.safetensors"]
    assert writes == [
        {"file_path": "/m/v1.safetensors", "updates": {"separate_card": True}},
        {"file_path": "/m/v2.safetensors", "updates": {"separate_card": True}},
    ]


@pytest.mark.asyncio
async def test_all_versions_can_merge_the_group_back():
    handler, writes, _ = make_handler(
        [{"file_path": "/m/v1.safetensors"}, {"file_path": "/m/v2.safetensors"}]
    )

    await handler.set_separate_card(
        StubRequest({"file_path": "/m/v1.safetensors", "separate": False, "all_versions": True})
    )

    assert [w["updates"] for w in writes] == [{"separate_card": False}] * 2


@pytest.mark.asyncio
async def test_requires_a_file_path():
    handler, writes, _ = make_handler([])

    response = await handler.set_separate_card(StubRequest({"separate": True}))

    assert response.status == 400
    assert writes == []
