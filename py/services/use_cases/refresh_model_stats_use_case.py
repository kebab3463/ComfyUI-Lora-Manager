"""Use case refreshing Civitai version statistics for a scoped set of models."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Protocol, Sequence

from ..errors import RateLimitError
from ...utils.metadata_manager import MetadataManager

# Civitai accepts at most 100 hashes per by-hash batch request.
HASH_BATCH_SIZE = 100

# How many batch requests are in flight at once. Kept modest so a large refresh
# does not look like a burst to Civitai; the provider layer still applies its
# own backoff on top of this.
FETCH_CONCURRENCY = 4

# Abort after this many consecutive batch failures; a healthy run never
# produces more than an isolated failure.
CONSECUTIVE_FAILURE_ABORT_THRESHOLD = 3

# Progress messages share the generic /ws/fetch-progress socket with other bulk
# operations, so every payload carries a discriminator.
PROGRESS_TYPE = "stats_refresh_progress"

# Numeric keys kept from a Civitai version ``stats`` block.
STAT_KEYS = ("thumbsUpCount", "downloadCount", "ratingCount", "rating")


class StatsRefreshProgressReporter(Protocol):
    """Protocol for progress reporters used during a stats refresh."""

    async def on_progress(self, payload: Dict[str, Any]) -> None:
        """Handle a stats refresh progress update."""


def extract_version_stats(version: Any) -> Optional[Dict[str, Any]]:
    """Return the numeric subset of a Civitai version ``stats`` block."""
    if not isinstance(version, dict):
        return None

    stats = version.get("stats")
    if not isinstance(stats, dict):
        return None

    extracted: Dict[str, Any] = {}
    for key in STAT_KEYS:
        value = stats.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        extracted[key] = value

    return extracted or None


def extract_version_hashes(version: Any) -> List[str]:
    """Return every SHA256 hash advertised by a version's files.

    All files are inspected rather than just the primary one: a local model may
    match a non-primary file, and dropping those would silently skip it.
    """
    if not isinstance(version, dict):
        return []

    files = version.get("files")
    if not isinstance(files, list):
        return []

    hashes: List[str] = []
    for file_info in files:
        if not isinstance(file_info, dict):
            continue
        file_hashes = file_info.get("hashes")
        if not isinstance(file_hashes, dict):
            continue
        sha256 = file_hashes.get("SHA256")
        if isinstance(sha256, str) and sha256:
            hashes.append(sha256.lower())
    return hashes


class RefreshModelStatsUseCase:
    """Refresh Civitai ``stats`` for an explicit list of models."""

    def __init__(
        self,
        *,
        service,
        metadata_manager=MetadataManager,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._service = service
        self._metadata_manager = metadata_manager
        self._logger = logger or logging.getLogger(__name__)

    async def execute(
        self,
        *,
        models: Sequence[Dict[str, Any]],
        metadata_provider,
        progress_callback: Optional[StatsRefreshProgressReporter] = None,
    ) -> Dict[str, Any]:
        """Fetch and persist version stats for ``models``.

        ``_apply_stats`` defers the per-model cache resort, so the ordering is
        restored exactly once here — including on the cancel, rate-limit and
        failure paths, which can all return after partial writes.
        """

        try:
            result = await self._execute(
                models=models,
                metadata_provider=metadata_provider,
                progress_callback=progress_callback,
            )
        except Exception:
            # Writes may already have landed; leave the ordering consistent.
            await self._resort_once()
            raise

        if result.get("updated"):
            await self._resort_once()
        return result

    async def _execute(
        self,
        *,
        models: Sequence[Dict[str, Any]],
        metadata_provider,
        progress_callback: Optional[StatsRefreshProgressReporter] = None,
    ) -> Dict[str, Any]:
        total_models = len(models)

        # Group by hash: several files can legitimately share one SHA256.
        hash_to_models: Dict[str, List[Dict[str, Any]]] = {}
        for model in models:
            sha256 = (model.get("sha256") or "").lower()
            if not sha256:
                continue
            hash_to_models.setdefault(sha256, []).append(model)

        hashes = list(hash_to_models.keys())
        total_to_process = sum(len(entries) for entries in hash_to_models.values())
        skipped_count = total_models - total_to_process

        processed = 0
        success = 0
        failures: List[Dict[str, str]] = []
        start_time = time.monotonic()

        self._service.scanner.reset_cancellation()

        async def emit(status: str, **extra: Any) -> None:
            if progress_callback is None:
                return
            payload: Dict[str, Any] = {
                "type": PROGRESS_TYPE,
                "status": status,
                "total": total_models,
                "processed": processed,
                "success": success,
                "failure_count": len(failures),
                "skipped_count": skipped_count,
                "elapsed_seconds": int(time.monotonic() - start_time),
            }
            if failures and status in ("completed", "cancelled", "rate_limited"):
                payload["failures"] = failures
            payload.update(extra)
            await progress_callback.on_progress(payload)

        await emit("started")

        consecutive_failures = 0
        chunks = [
            hashes[start : start + HASH_BATCH_SIZE]
            for start in range(0, len(hashes), HASH_BATCH_SIZE)
        ]

        async def fetch_chunk(chunk: List[str]):
            """Fetch one batch, converting non-rate-limit errors into a miss."""
            try:
                return await metadata_provider.get_model_versions_by_hashes(chunk)
            except RateLimitError:
                raise
            except Exception as exc:  # pragma: no cover - defensive logging
                self._logger.error("Batch stats request failed: %s", exc, exc_info=True)
                return None

        # Batches are fetched a wave at a time: the run is network-bound, and
        # issuing them one by one leaves the connection idle between round
        # trips. Results are applied sequentially afterwards because the write
        # path mutates the shared model cache.
        for wave_start in range(0, len(chunks), FETCH_CONCURRENCY):
            if self._service.scanner.is_cancelled():
                self._logger.info("Civitai stats refresh cancelled by user")
                await emit("cancelled")
                return self._result(
                    success_flag=False,
                    message="Operation cancelled",
                    processed=processed,
                    updated=success,
                    total=total_models,
                    failures=failures,
                    skipped_count=skipped_count,
                    start_time=start_time,
                )

            wave = chunks[wave_start : wave_start + FETCH_CONCURRENCY]
            results = await asyncio.gather(
                *(fetch_chunk(chunk) for chunk in wave), return_exceptions=True
            )

            if any(isinstance(result, RateLimitError) for result in results):
                self._logger.warning("Civitai stats refresh rate limited")
                await emit("rate_limited")
                return self._result(
                    success_flag=False,
                    message="Rate limit detected; remaining models skipped",
                    processed=processed,
                    updated=success,
                    total=total_models,
                    failures=failures,
                    skipped_count=skipped_count,
                    start_time=start_time,
                )

            for chunk, versions in zip(wave, results):
                if isinstance(versions, BaseException) or versions is None:
                    consecutive_failures += 1
                    # The whole batch is unresolved; count it so progress moves.
                    for sha256 in chunk:
                        processed += len(hash_to_models.get(sha256, []))
                    if consecutive_failures >= CONSECUTIVE_FAILURE_ABORT_THRESHOLD:
                        self._logger.warning(
                            "Civitai stats refresh aborted after %d consecutive batch failures",
                            consecutive_failures,
                        )
                        await emit("error", error="Repeated batch failures")
                        return self._result(
                            success_flag=False,
                            message="Repeated batch failures; remaining models skipped",
                            processed=processed,
                            updated=success,
                            total=total_models,
                            failures=failures,
                            skipped_count=skipped_count,
                            start_time=start_time,
                        )
                    continue

                consecutive_failures = 0

                # Map each returned version onto the models that requested it.
                requested = set(chunk)
                stats_by_hash: Dict[str, Dict[str, Any]] = {}
                for version in versions:
                    stats = extract_version_stats(version)
                    if not stats:
                        continue
                    for sha256 in extract_version_hashes(version):
                        if sha256 in requested:
                            stats_by_hash[sha256] = stats

                for sha256 in chunk:
                    entries = hash_to_models.get(sha256, [])
                    stats = stats_by_hash.get(sha256)
                    for model in entries:
                        processed += 1
                        if stats is None:
                            continue
                        try:
                            if await self._apply_stats(model, stats):
                                success += 1
                        except Exception as exc:  # pragma: no cover - defensive logging
                            name = (
                                model.get("model_name")
                                or model.get("file_path")
                                or "Unknown"
                            )
                            failures.append({"name": name, "error": str(exc)})
                            self._logger.error(
                                "Failed to persist stats for %s: %s",
                                model.get("file_path"),
                                exc,
                            )

            await emit("processing")

        await emit("completed")

        return self._result(
            success_flag=True,
            message=(
                f"Updated stats for {success} of {processed} processed "
                f"{self._service.model_type}s (total: {total_models})"
            ),
            processed=processed,
            updated=success,
            total=total_models,
            failures=failures,
            skipped_count=skipped_count,
            start_time=start_time,
        )

    async def _apply_stats(
        self, model: Dict[str, Any], stats: Dict[str, Any]
    ) -> bool:
        """Persist ``stats`` to the model's sidecar and refresh its cache entry."""
        file_path = model.get("file_path")
        if not file_path:
            return False

        # Work on a copy so a mid-way failure never leaves a hydrated payload
        # in the shared cache entry. The copy also preserves the sidecar
        # self-heal path in hydrate_model_data, which falls back to cached keys.
        working = dict(model)
        await self._metadata_manager.hydrate_model_data(working)

        civitai = working.get("civitai")
        if not isinstance(civitai, dict):
            civitai = {}
        if civitai.get("stats") == stats:
            # Nothing changed; skip the disk write entirely.
            return False
        civitai["stats"] = stats
        working["civitai"] = civitai

        data_to_save = working.copy()
        data_to_save.pop("folder", None)
        await self._metadata_manager.save_metadata(file_path, data_to_save)

        # sync_cache_from_metadata applies a targeted in-place update and a
        # single-row SQL write. update_single_model_cache would instead re-save
        # the entire library and re-sort the whole cache for every model, which
        # makes a scoped refresh cost O(models refreshed x library size).
        # defer_resort drops the other per-model full-library cost; _resort_once
        # restores the ordering when the run ends.
        await self._service.scanner.sync_cache_from_metadata(
            file_path, working, defer_resort=True
        )
        return True

    async def _resort_once(self) -> None:
        """Re-sort the cache a single time after a batch of deferred updates."""
        try:
            cache = await self._service.scanner.get_cached_data()
            await cache.resort()
        except Exception:  # pragma: no cover - defensive logging
            self._logger.warning("Post-refresh cache resort failed", exc_info=True)

    @staticmethod
    def _result(
        *,
        success_flag: bool,
        message: str,
        processed: int,
        updated: int,
        total: int,
        failures: List[Dict[str, str]],
        skipped_count: int,
        start_time: float,
    ) -> Dict[str, Any]:
        return {
            "success": success_flag,
            "message": message,
            "processed": processed,
            "updated": updated,
            "total": total,
            "failures": failures,
            "failure_count": len(failures),
            "skipped_count": skipped_count,
            "elapsed_seconds": int(time.monotonic() - start_time),
        }

    async def execute_with_error_handling(
        self,
        *,
        models: Sequence[Dict[str, Any]],
        metadata_provider,
        progress_callback: Optional[StatsRefreshProgressReporter] = None,
    ) -> Dict[str, Any]:
        """Wrapper providing progress notification on unexpected failures."""

        try:
            return await self.execute(
                models=models,
                metadata_provider=metadata_provider,
                progress_callback=progress_callback,
            )
        except Exception as exc:
            if progress_callback is not None:
                await progress_callback.on_progress(
                    {"type": PROGRESS_TYPE, "status": "error", "error": str(exc)}
                )
            raise
