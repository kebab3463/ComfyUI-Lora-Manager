import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let trackJob, trackSync;

const PANEL = '#nvme-progress-panel';

function rows() {
  return [...document.querySelectorAll(`${PANEL} .nvme-row`)];
}
function text(sel) {
  return document.querySelector(`${PANEL} ${sel}`)?.textContent;
}

describe('nvmeProgress', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    // The module keeps its own timer/tracking state; a fresh copy per test
    // stops one test's in-flight poll leaking into the next.
    vi.resetModules();
    ({ trackJob, trackSync } = await import('../../../static/js/utils/nvmeProgress.js'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('follows a job from queued through byte progress to done', async () => {
    let phase = 0;
    const phases = [
      [{ id: 'j1', status: 'running', bytes_done: 500, bytes_total: 1000, speed_bps: 250 }],
      [{ id: 'j1', status: 'done', result: { bytes_copied: 1000 } }],
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => phases[Math.min(phase++, phases.length - 1)],
    })));

    const settled = trackJob('j1', 'Promoting', 'big_model.safetensors');

    // Row appears immediately, before any poll.
    expect(rows()).toHaveLength(1);
    expect(text('.nvme-op')).toBe('Promoting');
    expect(text('.nvme-name')).toBe('big_model.safetensors');
    expect(text('.nvme-detail')).toBe('Queued…');

    // First poll: real byte progress and a rate.
    await vi.advanceTimersByTimeAsync(700);
    expect(text('.nvme-detail')).toBe('500 B / 1000 B');
    expect(text('.nvme-rate')).toBe('250 B/s');
    expect(document.querySelector(`${PANEL} .nvme-bar > div`).style.width).toBe('50%');

    // Second poll: completion resolves the promise and marks the row done.
    await vi.advanceTimersByTimeAsync(700);
    await expect(settled).resolves.toBe(true);
    expect(rows()[0].classList.contains('nvme-done')).toBe(true);
    expect(text('.nvme-detail')).toBe('Done · 1000 B');

    // The row retires itself and takes the empty panel with it.
    await vi.advanceTimersByTimeAsync(4000 + 400);
    expect(document.querySelector(PANEL)).toBeNull();
  });

  it('surfaces a failed job and resolves false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'j2', status: 'error', error: 'cache full' }],
    })));

    const settled = trackJob('j2', 'Promoting', 'x.safetensors');
    await vi.advanceTimersByTimeAsync(700);

    await expect(settled).resolves.toBe(false);
    expect(rows()[0].classList.contains('nvme-error')).toBe(true);
    expect(text('.nvme-detail')).toBe('cache full');
  });

  it('treats a job that fell out of the server ring buffer as finished', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    const settled = trackJob('gone', 'Promoting', 'y.safetensors');
    await vi.advanceTimersByTimeAsync(700);
    await expect(settled).resolves.toBe(true);
  });

  it('shows an indeterminate row for a synchronous op and marks it failed', async () => {
    const p = trackSync('Demoting', 'z.safetensors', Promise.reject(new Error('boom')));
    expect(rows()[0].classList.contains('nvme-indeterminate')).toBe(true);
    expect(text('.nvme-detail')).toBe('Working…');
    await expect(p).rejects.toThrow('boom');
    expect(rows()[0].classList.contains('nvme-error')).toBe(true);
    expect(text('.nvme-detail')).toBe('boom');
  });

  it('renders model names as text, never as markup', async () => {
    trackSync('Demoting', '<img src=x onerror=alert(1)>', new Promise(() => {}));
    const nameEl = document.querySelector(`${PANEL} .nvme-name`);
    expect(nameEl.querySelector('img')).toBeNull();
    expect(nameEl.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
