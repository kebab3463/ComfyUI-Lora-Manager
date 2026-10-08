import { describe, it, expect, beforeEach, vi } from 'vitest';

const { BASE_MODEL_API_MODULE, STATE_MODULE, STORAGE_MODULE, API_FACTORY_MODULE } = vi.hoisted(() => ({
    BASE_MODEL_API_MODULE: new URL('../../../static/js/api/baseModelApi.js', import.meta.url).pathname,
    STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
    STORAGE_MODULE: new URL('../../../static/js/utils/storageHelpers.js', import.meta.url).pathname,
    API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
}));

vi.mock(STATE_MODULE, () => ({
    state: { global: { settings: {} }, loadingManager: {} },
    getCurrentPageState: vi.fn(() => ({})),
}));

vi.mock(STORAGE_MODULE, () => ({
    getStorageItem: vi.fn(),
    setStorageItem: vi.fn(),
    getSessionItem: vi.fn(() => null),
    setSessionItem: vi.fn(),
    removeSessionItem: vi.fn(),
    saveMapToStorage: vi.fn(),
}));

vi.mock(API_FACTORY_MODULE, () => ({
    resetAndReload: vi.fn(),
    getModelApiClient: vi.fn(),
}));

function pageState(filters) {
    return {
        activeFolder: null,
        searchOptions: { recursive: true },
        filters: { baseModel: [], tags: {}, ...filters },
    };
}

describe('BaseModelApiClient publish-date query params', () => {
    let client;

    beforeEach(async () => {
        const { BaseModelApiClient } = await import(BASE_MODEL_API_MODULE);
        // The base client is abstract; a bare subclass exercises its param builder.
        class TestClient extends BaseModelApiClient {}
        client = new TestClient('loras');
    });

    it('sends both bounds', () => {
        const params = client._buildQueryParams({}, pageState({
            published: { from: '2024-03-01', to: '2024-03-31' },
        }));

        expect(params.get('published_from')).toBe('2024-03-01');
        expect(params.get('published_to')).toBe('2024-03-31');
    });

    it('sends a single bound on its own', () => {
        const params = client._buildQueryParams({}, pageState({ published: { to: '2024-03-31' } }));

        expect(params.has('published_from')).toBe(false);
        expect(params.get('published_to')).toBe('2024-03-31');
    });

    it('sends nothing without a range', () => {
        const params = client._buildQueryParams({}, pageState({}));

        expect(params.has('published_from')).toBe(false);
        expect(params.has('published_to')).toBe(false);
    });
});
