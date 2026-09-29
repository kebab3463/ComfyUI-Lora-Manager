import { api } from "../../scripts/api.js";
import { createMenuItem } from "./loras_widget_components.js";
import { showToast } from "./loras_widget_utils.js";
import { trackJob, trackSync } from "./nvme_progress.js";

/**
 * NVMe cache actions for the LoRA widgets, backed by the `nvme_cache` custom
 * node's HTTP API. Mirrors static/js/utils/nvmeCache.js, which does the same
 * job for the LoRA Manager tab; the two live in separately served bundles and
 * each uses its own toast, so the logic is kept local to each rather than
 * shared across the root boundary.
 *
 * Widgets only know a LoRA by the name stored in the workflow, so this takes
 * two lookups: the name resolves to an absolute file path via LoRA Manager's
 * cache, and that path resolves to an nvme_cache "rel" plus its current cache
 * status — which keeps the cache roots configured in exactly one place.
 *
 * Both items are toggles: a LoRA already on NVMe offers Demote instead of
 * Promote, and a pinned one offers Unpin instead of Pin.
 */

const NVME_API = "/nvme_cache/api";

// How many evicted files to name in the confirmation before summarising.
const EVICT_PREVIEW_LIMIT = 8;

// Statuses meaning the file currently lives on NVMe, so promote flips to
// demote. Mirrors the `demotable` set in nvme_cache's own UI.
const ON_NVME = new Set(["nvme", "pinned", "nvme-only"]);

const promoteIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="14" width="20" height="7" rx="2"></rect><circle cx="6.5" cy="17.5" r="1"></circle><path d="M12 10V3"></path><path d="M8.5 6.5 12 3l3.5 3.5"></path></svg>';

const demoteIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="14" width="20" height="7" rx="2"></rect><circle cx="6.5" cy="17.5" r="1"></circle><path d="M12 3v7"></path><path d="M8.5 6.5 12 10l3.5-3.5"></path></svg>';

const pinIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"></path><path d="M9 2h6l-1 6 3 3v2H7v-2l3-3-1-6z"></path></svg>';

const unpinIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"></path><path d="M9 2h6l-1 6 3 3v2H7v-2l3-3-1-6z"></path><line x1="3" y1="3" x2="21" y2="21"></line></svg>';

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/**
 * Resolve a workflow LoRA name to its absolute file path.
 *
 * The favorite endpoint is the one lookup that already maps a widget-visible
 * name onto a file_path in a single request from LoRA Manager's in-memory
 * model cache, which is exactly what we need here.
 */
async function loraNameToFilePath(loraName) {
  const response = await api.fetchApi(
    `/lm/loras/favorite?name=${encodeURIComponent(loraName)}`
  );
  if (!response.ok) {
    throw new Error(`"${loraName}" was not found in the LoRA Manager cache`);
  }
  const data = await response.json();
  if (!data.success || !data.file_path) {
    throw new Error(data.error || `Could not resolve a file path for "${loraName}"`);
  }
  return data.file_path;
}

/**
 * POST to an nvme_cache endpoint. Returns {status, ok, data} rather than
 * throwing on 409, because 409 is a normal part of the promote flow.
 */
async function nvmePost(endpoint, body) {
  let response;
  try {
    response = await fetch(`${NVME_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Could not reach the NVMe cache service: ${error.message}`);
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // Non-JSON body (e.g. ComfyUI's 404 page when nvme_cache isn't loaded)
  }

  if (response.status === 404 && !data) {
    throw new Error("NVMe cache service not available (is the nvme_cache node installed?)");
  }
  return { status: response.status, ok: response.ok, data };
}

/** Resolve a LoRA name all the way to {rel, status}, or null if unmanaged. */
async function resolveNvme(loraName) {
  const filePath = await loraNameToFilePath(loraName);
  const { ok, data } = await nvmePost("/resolve", { paths: [filePath] });
  if (!ok) {
    throw new Error(data?.error || "Could not resolve this model path");
  }
  return data?.results?.[filePath] ?? null;
}

function confirmEviction(plan, detail) {
  const shown = plan.to_evict.slice(0, EVICT_PREVIEW_LIMIT);
  const remainder = plan.to_evict.length - shown.length;
  const preview = shown.join("\n") + (remainder > 0 ? `\n…and ${remainder} more` : "");
  return window.confirm(
    `${detail}\n\n` +
      `${plan.to_evict.length} file(s) (${formatBytes(plan.total_freed)}) ` +
      `will be demoted to make room for ${formatBytes(plan.promotion_size)}:\n\n${preview}`
  );
}

async function runWithEvictionPrompt(op, rel, detail) {
  let result = await nvmePost(op, { rel });
  if (result.status === 409 && result.data?.eviction_required) {
    if (!confirmEviction(result.data, detail)) return null;
    result = await nvmePost(op, { rel, allow_evict: result.data.to_evict });
  }
  if (!result.ok) {
    throw new Error(result.data?.error || `Request failed (HTTP ${result.status})`);
  }
  return result;
}

/** Resolve and reject the statuses no action can handle. */
async function prepare(loraName) {
  const info = await resolveNvme(loraName);
  if (!info) {
    showToast(`"${loraName}" is not managed by the NVMe cache`, "error");
    return null;
  }
  if (info.status === "missing") {
    showToast(`${info.rel.split("/").pop()} was not found on disk`, "error");
    return null;
  }
  if (info.status === "unadopted") {
    showToast(
      `${info.rel.split("/").pop()} is not tracked by the cache yet — adopt it in the NVMe Cache tab`,
      "warning"
    );
    return null;
  }
  return info;
}

/** Copy a LoRA onto NVMe, or remove it again if it is already there. */
async function togglePromote(loraName) {
  try {
    const info = await prepare(loraName);
    if (!info) return;
    const { rel, status } = info;
    const name = rel.split("/").pop();

    if (ON_NVME.has(status)) {
      // Demoting an nvme-only file copies it back to the HDD first, which is
      // slow and worth agreeing to.
      if (
        status === "nvme-only" &&
        !window.confirm(
          `"${rel}" has no HDD copy.\n\n` +
            "It will be backed up to the HDD first, then removed from NVMe."
        )
      ) {
        return;
      }
      // Demote is synchronous server-side, so there is no job to poll — the
      // row runs for as long as the request does.
      await trackSync("Demoting", name, (async () => {
        const { ok, data } = await nvmePost("/demote", { rel });
        if (!ok) throw new Error(data?.error || "Demote failed");
      })());
      showToast(`Demoted ${name} from NVMe`, "success");
      return;
    }

    const result = await runWithEvictionPrompt(
      "/promote", rel, `Promoting ${name} needs more space than the cache has free.`
    );
    if (!result) return;
    showToast(`Promoting ${name} to NVMe`, "info");
    if (result.data?.job_id) {
      const ok = await trackJob(result.data.job_id, "Promoting", name);
      showToast(
        ok ? `Promoted ${name} to NVMe` : `Promoting ${name} failed`,
        ok ? "success" : "error"
      );
    }
  } catch (error) {
    console.error("NVMe promote/demote failed:", error);
    showToast(error.message || "NVMe action failed", "error");
  }
}

/** Pin a LoRA so it is never evicted, or unpin it if it already is. */
async function togglePin(loraName) {
  try {
    const info = await prepare(loraName);
    if (!info) return;
    const { rel, status } = info;
    const name = rel.split("/").pop();

    if (status === "pinned") {
      await trackSync("Unpinning", name, (async () => {
        const { ok, data } = await nvmePost("/unpin", { rel });
        if (!ok) throw new Error(data?.error || "Unpin failed");
      })());
      showToast(`Unpinned ${name} — it can be evicted again`, "success");
      return;
    }

    const result = await runWithEvictionPrompt(
      "/pin", rel, `Pinning ${name} has to promote it first, and the cache is full.`
    );
    if (!result) return;

    // Already-cached files are pinned by a synchronous flag flip; files still
    // on the HDD have to be copied first, which returns a job id.
    if (result.data?.job_id) {
      showToast(`Pinning ${name} — promoting it to NVMe first`, "info");
      const ok = await trackJob(result.data.job_id, "Pinning", name);
      showToast(
        ok ? `Pinned ${name} to NVMe` : `Pinning ${name} failed`,
        ok ? "success" : "error"
      );
    } else {
      showToast(`Pinned ${name} to NVMe`, "success");
    }
  } catch (error) {
    console.error("NVMe pin/unpin failed:", error);
    showToast(error.message || "NVMe action failed", "error");
  }
}

/** Swap a menu item's label and icon in place. */
function relabel(item, text, icon) {
  item.querySelector("span").textContent = text;
  item.querySelector(".lm-lora-menu-item-icon").innerHTML = icon;
}

/**
 * Build the two NVMe menu items for a LoRA.
 *
 * The correct labels depend on state we do not have when the menu opens, and
 * a context menu has to appear instantly. So the items render as Promote/Pin
 * and correct themselves to Demote/Unpin when the lookup lands — and hide
 * altogether for a LoRA the cache does not manage.
 *
 * @param {string} loraName Name as stored in the workflow.
 * @param {Function} onActivate Called before the action runs, to close the menu.
 * @returns {HTMLElement[]} The promote/demote and pin/unpin items.
 */
export function createNvmeMenuItems(loraName, onActivate) {
  const promoteOption = createMenuItem("Promote to NVMe", promoteIcon, () => {
    onActivate();
    togglePromote(loraName);
  });

  const pinOption = createMenuItem("Pin to NVMe", pinIcon, () => {
    onActivate();
    togglePin(loraName);
  });

  resolveNvme(loraName)
    .then((info) => {
      if (!info) {
        promoteOption.style.display = "none";
        pinOption.style.display = "none";
        return;
      }
      if (ON_NVME.has(info.status)) {
        relabel(promoteOption, "Demote from NVMe", demoteIcon);
      }
      if (info.status === "pinned") {
        relabel(pinOption, "Unpin from NVMe", unpinIcon);
      }
    })
    .catch(() => {
      // Stay silent: the items keep their default labels, and if the user
      // clicks one the action reports the failure properly.
    });

  return [promoteOption, pinOption];
}
