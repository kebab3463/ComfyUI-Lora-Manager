import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MIXIN_MODULE, UI_HELPERS_MODULE, I18N_MODULE, API_FACTORY_MODULE } = vi.hoisted(() => ({
  MIXIN_MODULE: new URL('../../../static/js/components/ContextMenu/ModelContextMenuMixin.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
}));

const pinVersion = vi.fn().mockResolvedValue({ success: true });
const resetAndReload = vi.fn().mockResolvedValue(undefined);
const showToast = vi.fn();

vi.mock(UI_HELPERS_MODULE, () => ({
  showToast,
  getNSFWLevelName: vi.fn(),
  openExampleImagesFolder: vi.fn(),
}));

vi.mock(I18N_MODULE, () => ({
  translate: vi.fn((key, params, fallback) => fallback || key),
}));

vi.mock(API_FACTORY_MODULE, () => ({
  getModelApiClient: vi.fn(() => ({ pinVersion })),
  resetAndReload,
}));

function makeHost({ pinned = false, modelId = '123' } = {}) {
  document.body.innerHTML = `
    <div class="context-menu">
      <div class="context-menu-item" data-action="pin-version"><span>Pin this version</span></div>
    </div>
  `;
  const card = document.createElement('div');
  card.dataset.filepath = '/m/v2.safetensors';
  card.dataset.pinned = pinned ? 'true' : 'false';
  if (modelId) card.dataset.modelId = modelId;

  return { menu: document.querySelector('.context-menu'), currentCard: card, card };
}

describe('ModelContextMenuMixin pin item', () => {
  let mixin;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ ModelContextMenuMixin: mixin } = await import(MIXIN_MODULE));
  });

  function label() {
    return document.querySelector('[data-action="pin-version"] span').textContent;
  }
  function item() {
    return document.querySelector('[data-action="pin-version"]');
  }

  it('offers to pin an unpinned version', () => {
    const host = makeHost({ pinned: false });
    mixin.updatePinMenuItem.call(host, host.card);

    expect(label()).toBe('Pin this version');
    expect(item().classList.contains('disabled')).toBe(false);
  });

  it('offers to unpin an already-pinned version', () => {
    const host = makeHost({ pinned: true });
    mixin.updatePinMenuItem.call(host, host.card);

    expect(label()).toBe('Unpin version');
  });

  it('disables the item for a model with no group identity', () => {
    // No modelId means no Civitai/HF group, so a pin could never take effect.
    const host = makeHost({ modelId: null });
    mixin.updatePinMenuItem.call(host, host.card);

    expect(item().classList.contains('disabled')).toBe(true);
  });

  it('pins via the API and flips the card state', async () => {
    const host = makeHost({ pinned: false });

    await mixin.togglePinVersion.call(host);

    expect(pinVersion).toHaveBeenCalledWith('/m/v2.safetensors', true);
    expect(host.card.dataset.pinned).toBe('true');
    expect(resetAndReload).toHaveBeenCalled();
  });

  it('unpins when the version is already pinned', async () => {
    const host = makeHost({ pinned: true });

    await mixin.togglePinVersion.call(host);

    expect(pinVersion).toHaveBeenCalledWith('/m/v2.safetensors', false);
    expect(host.card.dataset.pinned).toBe('false');
  });

  it('does nothing for an ungroupable model', async () => {
    const host = makeHost({ modelId: null });

    await mixin.togglePinVersion.call(host);

    expect(pinVersion).not.toHaveBeenCalled();
  });

  it('leaves the card state unchanged when the request fails', async () => {
    pinVersion.mockRejectedValueOnce(new Error('boom'));
    const host = makeHost({ pinned: false });

    await mixin.togglePinVersion.call(host);

    expect(host.card.dataset.pinned).toBe('false');
    expect(resetAndReload).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'toast.models.versionPinFailed',
      expect.objectContaining({ message: 'boom' }),
      'error',
    );
  });
});
