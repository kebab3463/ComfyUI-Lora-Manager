import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../static/js/utils/i18nHelpers.js', () => ({
  translate: vi.fn((key, params, fallback) => fallback || key),
}));

// The real ModalManager is used deliberately: the confirmation silently hung
// once because the modal was never registered with it, and showModal() is a
// no-op for unregistered ids.
function renderModalDom() {
  document.body.innerHTML = `
    <div id="refreshStatsConfirmModal" class="modal delete-modal">
      <div class="modal-content delete-modal-content">
        <h2 data-role="title"></h2>
        <p data-role="message"></p>
        <p data-role="tip"></p>
        <div class="modal-actions">
          <button data-action="cancel-refresh-stats">Cancel</button>
          <button data-action="confirm-refresh-stats">Fetch Stats</button>
        </div>
      </div>
    </div>
  `;
}

async function loadModules() {
  const { modalManager } = await import('../../../static/js/managers/ModalManager.js');
  const { confirmStatsRefresh } = await import('../../../static/js/utils/statsRefreshHelpers.js');
  return { modalManager, confirmStatsRefresh };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('confirmStatsRefresh', () => {
  it('registers the modal with ModalManager so it can actually open', async () => {
    renderModalDom();
    const { modalManager } = await loadModules();
    modalManager.initialize();

    // This is the exact gap that made the button appear to do nothing.
    expect(modalManager.getModal('refreshStatsConfirmModal')).toBeTruthy();
  });

  it('opens with the show class, which is what .delete-modal CSS displays on', async () => {
    renderModalDom();
    const { modalManager, confirmStatsRefresh } = await loadModules();
    modalManager.initialize();
    const element = document.getElementById('refreshStatsConfirmModal');

    const pending = confirmStatsRefresh('LoRA', 42);
    await Promise.resolve();

    // .delete-modal is display:none until .show sets display:flex; an inline
    // display:block would render it uncentred and never close cleanly.
    expect(element.classList.contains('show')).toBe(true);
    expect(element.style.display).not.toBe('block');

    document.querySelector('[data-action="cancel-refresh-stats"]').click();
    await pending;
  });

  it('removes the show class again once dismissed', async () => {
    renderModalDom();
    const { modalManager, confirmStatsRefresh } = await loadModules();
    modalManager.initialize();
    const element = document.getElementById('refreshStatsConfirmModal');

    const pending = confirmStatsRefresh('LoRA', 42);
    await Promise.resolve();
    document.querySelector('[data-action="cancel-refresh-stats"]').click();
    await pending;

    expect(element.classList.contains('show')).toBe(false);
  });

  it('resolves true when the confirm button is clicked', async () => {
    renderModalDom();
    const { modalManager, confirmStatsRefresh } = await loadModules();
    modalManager.initialize();

    const pending = confirmStatsRefresh('LoRA', 42);
    await Promise.resolve();

    document.querySelector('[data-action="confirm-refresh-stats"]').click();

    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the cancel button is clicked', async () => {
    renderModalDom();
    const { modalManager, confirmStatsRefresh } = await loadModules();
    modalManager.initialize();

    const pending = confirmStatsRefresh('LoRA', 42);
    await Promise.resolve();

    document.querySelector('[data-action="cancel-refresh-stats"]').click();

    await expect(pending).resolves.toBe(false);
  });

  it('shows the scoped count in the prompt', async () => {
    renderModalDom();
    const { modalManager, confirmStatsRefresh } = await loadModules();
    modalManager.initialize();

    const pending = confirmStatsRefresh('LoRA', 342);
    await Promise.resolve();

    expect(document.querySelector('[data-role="title"]').textContent).toContain('342');
    expect(document.querySelector('[data-role="message"]').textContent).toContain('342');

    document.querySelector('[data-action="cancel-refresh-stats"]').click();
    await pending;
  });

  it('proceeds rather than hanging when the modal is not registered', async () => {
    renderModalDom();
    const { confirmStatsRefresh } = await loadModules();
    // Deliberately skip modalManager.initialize() to simulate a missing
    // registration; the call must resolve instead of awaiting forever.

    await expect(confirmStatsRefresh('LoRA', 42)).resolves.toBe(true);
  });

  it('proceeds when the modal markup is absent entirely', async () => {
    const { confirmStatsRefresh } = await loadModules();

    await expect(confirmStatsRefresh('LoRA', 42)).resolves.toBe(true);
  });
});
