"""Tests for RefreshModelStatsUseCase."""

from __future__ import annotations

from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest

from py.services.errors import RateLimitError
from py.services.use_cases.refresh_model_stats_use_case import (
    FETCH_CONCURRENCY,
    HASH_BATCH_SIZE,
    PROGRESS_TYPE,
    RefreshModelStatsUseCase,
)


class MockProgressReporter:
    """Collect progress payloads for assertions."""

    def __init__(self):
        self.payloads: List[Dict[str, Any]] = []

    async def on_progress(self, payload: Dict[str, Any]) -> None:
        self.payloads.append(payload)

    @property
    def statuses(self) -> List[str]:
        return [payload["status"] for payload in self.payloads]


def make_model(sha256: str, name: str = "model") -> Dict[str, Any]:
    return {
        "file_path": f"/models/{name}.safetensors",
        "file_name": name,
        "model_name": name,
        "folder": "",
        "sha256": sha256,
        "civitai": {"id": 1, "modelId": 2},
    }


def make_version(sha256: str, thumbs_up: int, *, primary: bool = True) -> Dict[str, Any]:
    return {
        "id": 99,
        "modelId": 2,
        "stats": {"thumbsUpCount": thumbs_up, "downloadCount": thumbs_up * 10},
        "files": [
            {
                "type": "Model",
                "primary": primary,
                "hashes": {"SHA256": sha256.upper()},
            }
        ],
    }


@pytest.fixture
def mock_cache():
    cache = MagicMock()
    cache.resort = AsyncMock()
    return cache


@pytest.fixture
def mock_service(mock_cache):
    scanner = MagicMock()
    scanner.reset_cancellation = MagicMock()
    scanner.is_cancelled = MagicMock(return_value=False)
    scanner.sync_cache_from_metadata = AsyncMock(return_value=True)
    scanner.update_single_model_cache = AsyncMock(return_value=True)
    scanner.get_cached_data = AsyncMock(return_value=mock_cache)

    service = MagicMock()
    service.scanner = scanner
    service.model_type = "lora"
    return service


@pytest.fixture
def mock_metadata_manager():
    manager = MagicMock()

    async def hydrate(model_data):
        return model_data

    manager.hydrate_model_data = AsyncMock(side_effect=hydrate)
    manager.save_metadata = AsyncMock(return_value=True)
    return manager


@pytest.fixture
def use_case(mock_service, mock_metadata_manager):
    return RefreshModelStatsUseCase(
        service=mock_service,
        metadata_manager=mock_metadata_manager,
    )


def make_provider(versions_by_call):
    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(side_effect=versions_by_call)
    return provider


@pytest.mark.asyncio
async def test_stats_are_persisted_and_cache_updated(
    use_case, mock_service, mock_metadata_manager
):
    models = [make_model("aa" * 32, "alpha")]
    provider = make_provider([[make_version("aa" * 32, 42)]])
    reporter = MockProgressReporter()

    result = await use_case.execute(
        models=models, metadata_provider=provider, progress_callback=reporter
    )

    assert result["success"] is True
    assert result["updated"] == 1
    assert result["processed"] == 1

    saved_path, saved_payload = mock_metadata_manager.save_metadata.await_args.args
    assert saved_path == "/models/alpha.safetensors"
    assert saved_payload["civitai"]["stats"] == {
        "thumbsUpCount": 42,
        "downloadCount": 420,
    }
    # The sidecar never stores the folder, which is a cache-only concept.
    assert "folder" not in saved_payload

    # The targeted sync path is used, not the full-library re-save.
    mock_service.scanner.sync_cache_from_metadata.assert_awaited_once()
    mock_service.scanner.update_single_model_cache.assert_not_awaited()
    # The per-model resort is deferred; see test_resort_happens_once.
    assert (
        mock_service.scanner.sync_cache_from_metadata.await_args.kwargs["defer_resort"]
        is True
    )


@pytest.mark.asyncio
async def test_progress_reports_started_and_completed(use_case):
    models = [make_model("bb" * 32, "beta")]
    provider = make_provider([[make_version("bb" * 32, 7)]])
    reporter = MockProgressReporter()

    await use_case.execute(
        models=models, metadata_provider=provider, progress_callback=reporter
    )

    assert reporter.statuses[0] == "started"
    assert reporter.statuses[-1] == "completed"
    # Every payload is tagged so other consumers of the shared socket ignore it.
    assert all(payload["type"] == PROGRESS_TYPE for payload in reporter.payloads)


@pytest.mark.asyncio
async def test_hashes_are_batched_at_the_api_limit(use_case):
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(250)]
    calls: List[List[str]] = []

    async def capture(chunk):
        calls.append(list(chunk))
        return []

    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(side_effect=capture)

    await use_case.execute(models=models, metadata_provider=provider)

    assert [len(chunk) for chunk in calls] == [HASH_BATCH_SIZE, HASH_BATCH_SIZE, 50]


@pytest.mark.asyncio
async def test_matches_a_non_primary_file_hash(use_case, mock_metadata_manager):
    """A local model matching a non-primary file must not be skipped."""
    models = [make_model("cc" * 32, "gamma")]
    provider = make_provider([[make_version("cc" * 32, 11, primary=False)]])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["updated"] == 1
    saved_payload = mock_metadata_manager.save_metadata.await_args.args[1]
    assert saved_payload["civitai"]["stats"]["thumbsUpCount"] == 11


@pytest.mark.asyncio
async def test_models_without_a_hash_are_skipped(use_case):
    models = [make_model("", "no_hash"), make_model("dd" * 32, "has_hash")]
    provider = make_provider([[make_version("dd" * 32, 1)]])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["skipped_count"] == 1
    assert result["total"] == 2
    assert result["processed"] == 1


@pytest.mark.asyncio
async def test_unchanged_stats_skip_the_disk_write(use_case, mock_metadata_manager):
    model = make_model("ee" * 32, "delta")
    model["civitai"]["stats"] = {"thumbsUpCount": 5, "downloadCount": 50}
    provider = make_provider([[make_version("ee" * 32, 5)]])

    result = await use_case.execute(models=[model], metadata_provider=provider)

    assert result["updated"] == 0
    mock_metadata_manager.save_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancellation_stops_between_waves(use_case, mock_service):
    """Cancellation is honoured between waves, bounding the overshoot."""
    # 5 chunks spans two waves at FETCH_CONCURRENCY=4.
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(500)]
    mock_service.scanner.is_cancelled = MagicMock(side_effect=[False, True])
    provider = make_provider([[]] * 5)
    reporter = MockProgressReporter()

    result = await use_case.execute(
        models=models, metadata_provider=provider, progress_callback=reporter
    )

    assert result["success"] is False
    assert result["message"] == "Operation cancelled"
    assert "cancelled" in reporter.statuses
    # Only the first wave went out; the trailing chunk was never requested.
    assert provider.get_model_versions_by_hashes.await_count == FETCH_CONCURRENCY


@pytest.mark.asyncio
async def test_rate_limit_aborts_with_rate_limited_status(use_case):
    models = [make_model("ff" * 32, "epsilon")]
    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(
        side_effect=RateLimitError("slow down")
    )
    reporter = MockProgressReporter()

    result = await use_case.execute(
        models=models, metadata_provider=provider, progress_callback=reporter
    )

    assert result["success"] is False
    assert reporter.statuses[-1] == "rate_limited"


@pytest.mark.asyncio
async def test_repeated_batch_failures_abort_the_run(use_case):
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(500)]
    provider = make_provider([None, None, None, [], []])
    reporter = MockProgressReporter()

    result = await use_case.execute(
        models=models, metadata_provider=provider, progress_callback=reporter
    )

    assert result["success"] is False
    assert reporter.statuses[-1] == "error"
    # The breaker trips while processing the first wave's results, so the run
    # stops after one wave instead of issuing all five batches.
    assert provider.get_model_versions_by_hashes.await_count == FETCH_CONCURRENCY


@pytest.mark.asyncio
async def test_isolated_batch_failure_does_not_abort(use_case):
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(250)]
    provider = make_provider([None, [], []])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["success"] is True
    assert provider.get_model_versions_by_hashes.await_count == 3


@pytest.mark.asyncio
async def test_duplicate_hashes_update_every_local_copy(
    use_case, mock_metadata_manager
):
    """Two files sharing a SHA256 both receive the stats."""
    sha = "ab" * 32
    models = [make_model(sha, "copy_a"), make_model(sha, "copy_b")]
    provider = make_provider([[make_version(sha, 3)]])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["updated"] == 2
    assert mock_metadata_manager.save_metadata.await_count == 2


@pytest.mark.asyncio
async def test_versions_without_stats_are_ignored(use_case, mock_metadata_manager):
    models = [make_model("ba" * 32, "zeta")]
    version = make_version("ba" * 32, 0)
    version.pop("stats")
    provider = make_provider([[version]])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["updated"] == 0
    assert result["processed"] == 1
    mock_metadata_manager.save_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_error_handling_wrapper_emits_error_status(use_case):
    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(side_effect=RuntimeError("boom"))
    reporter = MockProgressReporter()

    # A bare RuntimeError inside a batch is absorbed as a batch failure, so
    # trigger the wrapper via a failure in the pre-flight scan instead.
    use_case._service.scanner.reset_cancellation = MagicMock(
        side_effect=RuntimeError("boom")
    )

    with pytest.raises(RuntimeError):
        await use_case.execute_with_error_handling(
            models=[make_model("bc" * 32)],
            metadata_provider=provider,
            progress_callback=reporter,
        )

    assert reporter.payloads[-1]["status"] == "error"
    assert reporter.payloads[-1]["type"] == PROGRESS_TYPE


@pytest.mark.asyncio
async def test_batches_within_a_wave_are_fetched_concurrently(use_case):
    """Batches must overlap; issuing them serially leaves the network idle."""
    import asyncio

    models = [make_model(f"{index:064x}", f"m{index}") for index in range(400)]
    in_flight = 0
    peak_in_flight = 0

    async def slow_fetch(chunk):
        nonlocal in_flight, peak_in_flight
        in_flight += 1
        peak_in_flight = max(peak_in_flight, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return []

    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(side_effect=slow_fetch)

    await use_case.execute(models=models, metadata_provider=provider)

    assert provider.get_model_versions_by_hashes.await_count == 4
    assert peak_in_flight == FETCH_CONCURRENCY


@pytest.mark.asyncio
async def test_resort_happens_once_regardless_of_model_count(use_case, mock_cache):
    """A per-model resort would cost O(models x library size log library size)."""
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(50)]
    provider = make_provider(
        [[make_version(f"{index:064x}", index + 1) for index in range(50)]]
    )

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["updated"] == 50
    mock_cache.resort.assert_awaited_once()


@pytest.mark.asyncio
async def test_no_resort_when_nothing_changed(use_case, mock_cache):
    """An unchanged library must not pay for a resort at all."""
    model = make_model("ee" * 32, "delta")
    model["civitai"]["stats"] = {"thumbsUpCount": 5, "downloadCount": 50}
    provider = make_provider([[make_version("ee" * 32, 5)]])

    result = await use_case.execute(models=[model], metadata_provider=provider)

    assert result["updated"] == 0
    mock_cache.resort.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancellation_after_partial_writes_still_resorts(
    use_case, mock_service, mock_cache
):
    """Deferred resorts must not be stranded by an early return."""
    models = [make_model(f"{index:064x}", f"m{index}") for index in range(500)]
    # Wave one writes, then the user cancels before wave two.
    mock_service.scanner.is_cancelled = MagicMock(side_effect=[False, True])
    provider = make_provider([[make_version("0" * 64, 9)], [], [], [], []])

    result = await use_case.execute(models=models, metadata_provider=provider)

    assert result["success"] is False
    assert result["updated"] == 1
    mock_cache.resort.assert_awaited_once()


@pytest.mark.asyncio
async def test_unexpected_failure_still_resorts(use_case, mock_service, mock_cache):
    """An escaping exception must not leave a stale cache ordering behind."""
    mock_service.scanner.reset_cancellation = MagicMock(side_effect=RuntimeError("boom"))

    with pytest.raises(RuntimeError):
        await use_case.execute(
            models=[make_model("bd" * 32)], metadata_provider=make_provider([[]])
        )

    mock_cache.resort.assert_awaited_once()


@pytest.mark.asyncio
async def test_concurrency_is_capped_at_the_wave_size(use_case):
    """More chunks than the limit must not all be issued at once."""
    import asyncio

    models = [make_model(f"{index:064x}", f"m{index}") for index in range(1000)]
    in_flight = 0
    peak_in_flight = 0

    async def slow_fetch(chunk):
        nonlocal in_flight, peak_in_flight
        in_flight += 1
        peak_in_flight = max(peak_in_flight, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return []

    provider = MagicMock()
    provider.get_model_versions_by_hashes = AsyncMock(side_effect=slow_fetch)

    await use_case.execute(models=models, metadata_provider=provider)

    assert provider.get_model_versions_by_hashes.await_count == 10
    assert peak_in_flight == FETCH_CONCURRENCY
