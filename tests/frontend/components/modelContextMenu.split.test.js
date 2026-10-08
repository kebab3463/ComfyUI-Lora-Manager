import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MIXIN_MODULE, UI_HELPERS_MODULE, I18N_MODULE, API_FACTORY_MODULE, STATE_MODULE } = vi.hoisted(() => ({
  MIXIN_MODULE: new URL('../../../static/js/components/ContextMenu/ModelContextMenuMixin.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
  STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
}));

const setSeparateCard = vi.fn().mockResolvedValue({ success: true });
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
  getModelApiClient: vi.fn(() => ({ setSeparateCard })),
  resetAndReload,
}));

function makeHost({ separate = false, versionCount } = {}) {
  document.body.innerHTML = `
    <div class="context-menu">
      <div class="context-menu-item" data-action="split-versions"><span>Split versions into separate cards</span></div>
    </div>
  `;
  const card = document.createElement('div');
  card.dataset.filepath = '/m/v2.safetensors';
  card.dataset.separate_card = separate ? 'true' : 'false';
  if (versionCount !== undefined) card.dataset.version_count = String(versionCount);

  return { menu: document.querySelector('.context-menu'), currentCard: card, card };
}

describe('ModelContextMenuMixin split-versions item', () => {
  let mixin;
  let state;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ ModelContextMenuMixin: mixin } = await import(MIXIN_MODULE));
    ({ state } = await import(STATE_MODULE));
    state.global.settings.group_by_model = true;
  });

  function item() {
    return document.querySelector('[data-action="split-versions"]');
  }
  function label() {
    return item().querySelector('span').textContent;
  }

  it('offers to split a grouped card', () => {
    const host = makeHost({ versionCount: 3 });
    mixin.updateSplitMenuItem.call(host, host.card);

    expect(item().style.display).toBe('');
    expect(label()).toBe('Split versions into separate cards');
  });

  it('offers to merge a card that was split off', () => {
    const host = makeHost({ separate: true });
    mixin.updateSplitMenuItem.call(host, host.card);

    expect(item().style.display).toBe('');
    expect(label()).toBe('Merge versions into one card');
  });

  it('hides the item for a single-version card', () => {
    const host = makeHost({ versionCount: 1 });
    mixin.updateSplitMenuItem.call(host, host.card);

    expect(item().style.display).toBe('none');
  });

  it('hides the item when grouping is off', () => {
    state.global.settings.group_by_model = false;
    const host = makeHost({ versionCount: 3 });
    mixin.updateSplitMenuItem.call(host, host.card);

    expect(item().style.display).toBe('none');
  });

  it('splits every version of the model and reloads the grid', async () => {
    const host = makeHost({ versionCount: 3 });

    await mixin.toggleSplitVersions.call(host);

    expect(setSeparateCard).toHaveBeenCalledWith('/m/v2.safetensors', true, { allVersions: true });
    expect(resetAndReload).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('toast.models.versionsSplit', {}, 'success');
  });

  it('merges every version back when the card is separate', async () => {
    const host = makeHost({ separate: true });

    await mixin.toggleSplitVersions.call(host);

    expect(setSeparateCard).toHaveBeenCalledWith('/m/v2.safetensors', false, { allVersions: true });
    expect(showToast).toHaveBeenCalledWith('toast.models.versionsMerged', {}, 'success');
  });

  it('reports a failure without reloading', async () => {
    setSeparateCard.mockRejectedValueOnce(new Error('boom'));
    const host = makeHost({ versionCount: 2 });

    await mixin.toggleSplitVersions.call(host);

    expect(resetAndReload).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'toast.models.versionsSplitFailed',
      expect.objectContaining({ message: 'boom' }),
      'error',
    );
  });
});
