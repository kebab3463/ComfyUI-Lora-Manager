import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

const {
  MODEL_VERSIONS_MODULE,
  API_FACTORY_MODULE,
  DOWNLOAD_MANAGER_MODULE,
  UI_HELPERS_MODULE,
  STATE_MODULE,
  I18N_HELPERS_MODULE,
  UTILS_MODULE,
} = vi.hoisted(() => ({
  MODEL_VERSIONS_MODULE: new URL('../../../static/js/components/shared/ModelVersionsTab.js', import.meta.url).pathname,
  API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
  DOWNLOAD_MANAGER_MODULE: new URL('../../../static/js/managers/DownloadManager.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
  I18N_HELPERS_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  UTILS_MODULE: new URL('../../../static/js/components/shared/utils.js', import.meta.url).pathname,
}));

vi.mock(DOWNLOAD_MANAGER_MODULE, () => ({
  downloadManager: {
    downloadVersionWithDefaults: vi.fn(),
    openFileSelectionForVersion: vi.fn(),
  },
}));

vi.mock(UI_HELPERS_MODULE, () => ({
  showToast: vi.fn(),
  openCivitaiUrl: vi.fn(),
}));

const stateMock = {
  currentPageType: 'loras',
  global: {
    settings: {
      autoplay_on_hover: false,
      version_grouping: 'any',
    },
  },
};
vi.mock(STATE_MODULE, () => ({
  state: stateMock,
}));

vi.mock(I18N_HELPERS_MODULE, () => ({
  translate: vi.fn((_, __, fallback) => fallback ?? ''),
}));

vi.mock(UTILS_MODULE, () => ({
  formatFileSize: vi.fn(() => '1 MB'),
}));

vi.mock(API_FACTORY_MODULE, () => ({
  getModelApiClient: vi.fn(),
  resetAndReload: vi.fn(),
}));

function localVersion(versionId, separateCard = false) {
  return {
    versionId,
    name: `v${versionId}`,
    baseModel: 'Illustrious',
    isInLibrary: true,
    shouldIgnore: false,
    filePath: `/models/loras/v${versionId}.safetensors`,
    separateCard,
  };
}

function buildRecord(versions) {
  return {
    success: true,
    record: {
      shouldIgnore: false,
      inLibraryVersionIds: versions.filter(v => v.isInLibrary).map(v => v.versionId),
      versions,
    },
  };
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('ModelVersionsTab separate-card controls', () => {
  let fetchModelUpdateVersions;
  let setSeparateCard;
  let resetAndReload;

  async function render(versions) {
    fetchModelUpdateVersions.mockResolvedValue(buildRecord(versions));
    const { initVersionsTab } = await import(MODEL_VERSIONS_MODULE);
    const controller = initVersionsTab({
      modalId: 'model-versions-modal',
      modelType: 'loras',
      modelId: 123,
      currentVersionId: null,
    });
    await controller.load();
  }

  function rowButton(versionId) {
    return document.querySelector(
      `.model-version-row[data-version-id="${versionId}"] [data-version-action="toggle-separate"]`
    );
  }

  function splitAllButton() {
    return document.querySelector('[data-versions-action="split-all"]');
  }

  beforeEach(async () => {
    vi.resetModules();
    stateMock.currentPageType = 'loras';
    document.body.innerHTML = `
      <div id="model-versions-modal">
        <div id="versions-tab">
          <div class="model-versions-tab"></div>
        </div>
      </div>
    `;
    const factory = await import(API_FACTORY_MODULE);
    resetAndReload = factory.resetAndReload;
    resetAndReload.mockReset();
    fetchModelUpdateVersions = vi.fn();
    setSeparateCard = vi.fn().mockResolvedValue({ success: true });
    factory.getModelApiClient.mockReturnValue({
      fetchModelUpdateVersions,
      setSeparateCard,
      fetchModelRoots: vi.fn(),
      setModelUpdateIgnore: vi.fn(),
      setVersionUpdateIgnore: vi.fn(),
      deleteModel: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows no split controls for a model with one local version', async () => {
    await render([localVersion(10), { ...localVersion(20), isInLibrary: false, filePath: null }]);

    expect(rowButton(10)).toBeNull();
    expect(splitAllButton()).toBeNull();
  });

  it('offers an own-card toggle on every local version', async () => {
    await render([localVersion(10), localVersion(20, true)]);

    expect(rowButton(10).textContent).toBe('Own Card');
    expect(rowButton(20).textContent).toBe('Rejoin Group');
    expect(splitAllButton().textContent.trim()).toBe('Split into separate cards');
  });

  it('offers to merge when every local version is already separate', async () => {
    await render([localVersion(10, true), localVersion(20, true)]);

    expect(splitAllButton().textContent.trim()).toBe('Merge into one card');
  });

  it('toggles one version and reloads the tab and the grid', async () => {
    await render([localVersion(10), localVersion(20)]);

    rowButton(20).click();
    await flush();

    expect(setSeparateCard).toHaveBeenCalledWith(
      '/models/loras/v20.safetensors', true, { allVersions: false }
    );
    expect(fetchModelUpdateVersions).toHaveBeenCalledTimes(2);
    expect(resetAndReload).toHaveBeenCalledWith(false);
  });

  it('splits all versions in one request', async () => {
    await render([localVersion(10), localVersion(20, true)]);

    splitAllButton().click();
    await flush();

    expect(setSeparateCard).toHaveBeenCalledWith(
      expect.any(String), true, { allVersions: true }
    );
  });

  it('merges all versions back when all are separate', async () => {
    await render([localVersion(10, true), localVersion(20, true)]);

    splitAllButton().click();
    await flush();

    expect(setSeparateCard).toHaveBeenCalledWith(
      expect.any(String), false, { allVersions: true }
    );
  });

  it('does not reload a grid of a different model type', async () => {
    stateMock.currentPageType = 'recipes';
    await render([localVersion(10), localVersion(20)]);

    rowButton(10).click();
    await flush();

    expect(setSeparateCard).toHaveBeenCalled();
    expect(resetAndReload).not.toHaveBeenCalled();
  });
});
