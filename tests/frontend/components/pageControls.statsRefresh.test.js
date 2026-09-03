import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

const resetAndReloadMock = vi.fn();
const getModelApiClientMock = vi.fn();
const refreshCivitaiStatsMock = vi.fn();

vi.mock('../../../static/js/api/modelApiFactory.js', () => ({
  getModelApiClient: getModelApiClientMock,
  resetAndReload: resetAndReloadMock,
}));

vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
  showToast: vi.fn(),
  openCivitaiByMetadata: vi.fn(),
  updatePanelPositions: vi.fn(),
}));

vi.mock('../../../static/js/managers/DownloadManager.js', () => ({
  downloadManager: { showDownloadModal: vi.fn() },
}));

vi.mock('../../../static/js/components/SidebarManager.js', () => ({
  sidebarManager: {
    setHostPageControls: vi.fn(),
    initialize: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    cleanup: vi.fn(),
    isInitialized: false,
  },
}));

vi.mock('../../../static/js/components/alphabet/index.js', () => ({
  createAlphabetBar: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../static/js/utils/updateCheckHelpers.js', () => ({
  performModelUpdateCheck: vi.fn(async () => ({ status: 'success', displayName: 'LoRA', records: [] })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();

  resetAndReloadMock.mockResolvedValue(undefined);
  refreshCivitaiStatsMock.mockResolvedValue(undefined);
  getModelApiClientMock.mockReturnValue({
    refreshCivitaiStats: refreshCivitaiStatsMock,
    fetchCivitaiMetadata: vi.fn(),
  });

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, base_models: [] }),
  });
});

afterEach(() => {
  delete window.bulkManager;
  delete window.modelDuplicatesManager;
  delete global.fetch;
});

// Mirrors the Fetch dropdown-group introduced in controls.html: the main
// button keeps data-action="fetch" and the stats action lives in its menu.
function renderControlsDom(pageKey) {
  document.body.dataset.page = pageKey;
  document.body.innerHTML = `
    <div class="controls">
      <div id="excludedViewBanner" class="excluded-view-banner hidden">
        <button id="excludedViewBackBtn">Back</button>
      </div>
      <div class="actions">
        <div class="action-buttons">
          <div class="control-group">
            <select id="sortSelect">
              <option value="name:asc">Name Asc</option>
              <option value="likes:desc">Most liked</option>
              <option value="downloads:desc">Most downloaded</option>
            </select>
          </div>
          <div class="control-group dropdown-group">
            <button data-action="refresh" class="dropdown-main"></button>
            <button class="dropdown-toggle"></button>
            <div class="dropdown-menu">
              <div class="dropdown-item" data-action="full-rebuild"></div>
            </div>
          </div>
          <div class="control-group dropdown-group">
            <button data-action="fetch" class="dropdown-main"></button>
            <button class="dropdown-toggle"></button>
            <div class="dropdown-menu">
              <div class="dropdown-item" data-action="fetch-stats"></div>
            </div>
          </div>
          <div class="control-group">
            <button data-action="download"></button>
          </div>
          <div class="control-group">
            <button data-action="bulk"></button>
          </div>
          <div class="control-group">
            <button data-action="find-duplicates"></button>
          </div>
          <div class="control-group">
            <button id="favoriteFilterBtn" class="favorite-filter"></button>
          </div>
          <div class="control-group dropdown-group update-filter-group">
            <button id="updateFilterBtn" class="dropdown-main update-filter" aria-busy="false">
              <span>Updates</span>
            </button>
            <button id="updateFilterMenuToggle" class="dropdown-toggle"></button>
            <div class="dropdown-menu">
              <div id="checkUpdatesMenuItem" class="dropdown-item" data-action="check-updates">
                <span>Check updates</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="customFilterIndicator" class="control-group hidden">
      <div class="filter-active">
        <span class="customFilterText" title=""></span>
        <i class="fas fa-times-circle clear-filter"></i>
      </div>
    </div>
    <div id="breadcrumbContainer"></div>
    <div id="duplicatesBanner" style="display: none;"></div>
    <div class="alphabet-bar-container"></div>
  `;
}

async function createControls() {
  const stateModule = await import('../../../static/js/state/index.js');
  stateModule.initPageState('loras');
  const { LorasControls } = await import('../../../static/js/components/controls/LorasControls.js');
  return { stateModule, controls: new LorasControls() };
}

describe('Fetch Civitai stats action', () => {
  it('invokes the API client when the dropdown item is clicked', async () => {
    renderControlsDom('loras');
    await createControls();

    document.querySelector('[data-action="fetch-stats"]').click();
    await Promise.resolve();

    expect(refreshCivitaiStatsMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the main Fetch action untouched', async () => {
    renderControlsDom('loras');
    const fetchMetadataMock = vi.fn();
    getModelApiClientMock.mockReturnValue({
      refreshCivitaiStats: refreshCivitaiStatsMock,
      fetchCivitaiMetadata: fetchMetadataMock,
    });
    await createControls();

    document.querySelector('[data-action="fetch"]').click();
    await Promise.resolve();

    expect(fetchMetadataMock).toHaveBeenCalledTimes(1);
    expect(refreshCivitaiStatsMock).not.toHaveBeenCalled();
  });
});

describe('Civitai stat sort options', () => {
  it('persists a likes sort selection and reloads', async () => {
    renderControlsDom('loras');
    const { controls } = await createControls();
    const sortSelect = document.getElementById('sortSelect');

    sortSelect.value = 'likes:desc';
    sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(controls.pageState.sortBy).toBe('likes:desc');
    expect(localStorage.getItem('lora_manager_loras_sort')).toBe('likes:desc');
    expect(resetAndReloadMock).toHaveBeenCalled();
  });

  it('restores a persisted downloads sort on load', async () => {
    renderControlsDom('loras');
    localStorage.setItem('lora_manager_loras_sort', 'downloads:asc');

    const { controls } = await createControls();

    // The value survives convertLegacySortFormat because it carries an order.
    expect(controls.pageState.sortBy).toBe('downloads:asc');
  });
});
