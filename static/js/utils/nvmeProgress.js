/**
 * Progress panel for NVMe cache operations.
 *
 * Promotes and HDD-side pins run as background jobs on the nvme_cache server,
 * so a click returns long before the copy finishes. This polls /jobs and shows
 * a compact panel with live byte progress, so the work is visible wherever it
 * was started rather than only in the NVMe Cache tab.
 *
 * Synchronous operations (demote, unpin) have no job to poll, so they get an
 * indeterminate row that lasts as long as the request — a demote of an
 * nvme-only file copies it back to the HDD first and is not always quick.
 *
 * Deliberately self-contained: no imports and its own injected styles, so the
 * same implementation serves both the LoRA Manager tab and the ComfyUI graph
 * widgets, which are separately served bundles with no shared CSS.
 */

const JOBS_URL = '/nvme_cache/api/jobs';
const POLL_MS = 700;

// How long a finished row lingers before it removes itself.
const LINGER_OK_MS = 4000;
const LINGER_ERROR_MS = 12000;

const STYLE_ID = 'nvme-progress-styles';
const PANEL_ID = 'nvme-progress-panel';

const CSS = `
#${PANEL_ID} {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 100000;
    width: 320px;
    max-height: 60vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    pointer-events: none;
}
#${PANEL_ID} .nvme-row {
    pointer-events: auto;
    background: rgba(24, 26, 32, 0.96);
    color: #e8eaed;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    padding: 9px 11px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    animation: nvme-row-in 0.18s ease-out;
}
@keyframes nvme-row-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
}
#${PANEL_ID} .nvme-row.nvme-leaving {
    opacity: 0;
    transition: opacity 0.35s ease;
}
#${PANEL_ID} .nvme-row-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
}
#${PANEL_ID} .nvme-op {
    font-weight: 600;
    white-space: nowrap;
}
#${PANEL_ID} .nvme-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
    direction: rtl;
    text-align: left;
}
#${PANEL_ID} .nvme-bar {
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.14);
    overflow: hidden;
}
#${PANEL_ID} .nvme-bar > div {
    height: 100%;
    width: 0;
    background: #4f9cf9;
    border-radius: 2px;
    transition: width 0.3s ease;
}
#${PANEL_ID} .nvme-row.nvme-indeterminate .nvme-bar > div {
    width: 35%;
    animation: nvme-slide 1.1s ease-in-out infinite;
}
@keyframes nvme-slide {
    0%   { margin-left: -35%; }
    100% { margin-left: 100%; }
}
#${PANEL_ID} .nvme-row.nvme-done .nvme-bar > div { width: 100%; background: #4caf7d; }
#${PANEL_ID} .nvme-row.nvme-error .nvme-bar > div { width: 100%; background: #e5534b; }
#${PANEL_ID} .nvme-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 5px;
    font-size: 11px;
    opacity: 0.7;
}
#${PANEL_ID} .nvme-meta .nvme-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
`;

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function ensurePanel() {
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        document.body.appendChild(panel);
    }
    return panel;
}

function createRow(op, name) {
    const row = document.createElement('div');
    row.className = 'nvme-row nvme-indeterminate';
    row.innerHTML = `
        <div class="nvme-row-head">
            <span class="nvme-op"></span>
            <span class="nvme-name"></span>
        </div>
        <div class="nvme-bar"><div></div></div>
        <div class="nvme-meta"><span class="nvme-detail"></span><span class="nvme-rate"></span></div>`;
    // textContent, not innerHTML: model names are user data, not markup.
    row.querySelector('.nvme-op').textContent = op;
    row.querySelector('.nvme-name').textContent = name;
    ensurePanel().appendChild(row);
    return row;
}

function setDetail(row, detail, rate = '') {
    row.querySelector('.nvme-detail').textContent = detail;
    row.querySelector('.nvme-rate').textContent = rate;
}

function retireRow(row, ok) {
    setTimeout(() => {
        row.classList.add('nvme-leaving');
        setTimeout(() => {
            row.remove();
            const panel = document.getElementById(PANEL_ID);
            if (panel && !panel.children.length) panel.remove();
        }, 400);
    }, ok ? LINGER_OK_MS : LINGER_ERROR_MS);
}

// ---------------------------------------------------------------------------
// Job polling
// ---------------------------------------------------------------------------

// jobId -> {row, resolve}
const tracked = new Map();
let pollTimer = null;

async function poll() {
    let jobs = [];
    try {
        const response = await fetch(JOBS_URL);
        if (response.ok) jobs = await response.json();
    } catch (_) {
        // Transient failure; the next tick retries. Rows simply hold.
    }

    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const [jobId, entry] of [...tracked]) {
        const job = byId.get(jobId);
        // A job can fall off the end of the server's 100-job ring buffer. Treat
        // it as finished rather than polling for it forever.
        if (!job) {
            finish(jobId, entry, true);
            continue;
        }

        const { row } = entry;
        if (job.status === 'running' || job.status === 'queued') {
            const total = job.bytes_total || 0;
            const done = job.bytes_done || 0;
            if (total > 0) {
                row.classList.remove('nvme-indeterminate');
                row.querySelector('.nvme-bar > div').style.width =
                    `${Math.min(100, (done / total) * 100).toFixed(1)}%`;
                setDetail(
                    row,
                    `${formatBytes(done)} / ${formatBytes(total)}`,
                    job.speed_bps ? `${formatBytes(job.speed_bps)}/s` : ''
                );
            } else {
                setDetail(row, job.status === 'queued' ? 'Queued…' : 'Starting…');
            }
        } else if (job.status === 'done') {
            finish(jobId, entry, true, job);
        } else if (job.status === 'error') {
            finish(jobId, entry, false, job);
        }
    }

    if (!tracked.size) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function finish(jobId, entry, ok, job) {
    const { row, resolve } = entry;
    tracked.delete(jobId);
    row.classList.remove('nvme-indeterminate');
    row.classList.add(ok ? 'nvme-done' : 'nvme-error');
    if (ok) {
        const copied = job?.result?.bytes_copied;
        setDetail(row, copied ? `Done · ${formatBytes(copied)}` : 'Done');
    } else {
        setDetail(row, job?.error || 'Failed');
    }
    retireRow(row, ok);
    resolve(ok);
}

/**
 * Show a row for a queued job and follow it to completion.
 * @param {string} jobId Job id returned by promote/pin.
 * @param {string} op Short verb shown on the row, e.g. "Promoting".
 * @param {string} name Model file name.
 * @returns {Promise<boolean>} Resolves true when the job succeeded.
 */
export function trackJob(jobId, op, name) {
    const row = createRow(op, name);
    setDetail(row, 'Queued…');
    return new Promise((resolve) => {
        tracked.set(jobId, { row, resolve });
        if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
    });
}

/**
 * Show an indeterminate row for an operation that completes synchronously,
 * for as long as `work` takes. Rethrows whatever `work` rejects with, after
 * marking the row failed.
 * @param {string} op Short verb shown on the row, e.g. "Demoting".
 * @param {string} name Model file name.
 * @param {Promise} work The in-flight request.
 */
export async function trackSync(op, name, work) {
    const row = createRow(op, name);
    setDetail(row, 'Working…');
    try {
        const result = await work;
        row.classList.remove('nvme-indeterminate');
        row.classList.add('nvme-done');
        setDetail(row, 'Done');
        retireRow(row, true);
        return result;
    } catch (error) {
        row.classList.remove('nvme-indeterminate');
        row.classList.add('nvme-error');
        setDetail(row, error.message || 'Failed');
        retireRow(row, false);
        throw error;
    }
}
