import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../static/js/state/index.js', () => ({
    getCurrentPageState: vi.fn(() => ({
        filters: {},
    })),
    state: {
        currentPageType: 'loras',
        loadingManager: {
            showSimpleLoading: vi.fn(),
            hide: vi.fn(),
        },
    },
}));

vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
    showToast: vi.fn(),
    updatePanelPositions: vi.fn(),
}));

const loadMoreWithVirtualScroll = vi.fn().mockResolvedValue();
vi.mock('../../../static/js/api/modelApiFactory.js', () => ({
    getModelApiClient: vi.fn(() => ({
        loadMoreWithVirtualScroll,
    })),
}));

vi.mock('../../../static/js/utils/storageHelpers.js', () => ({
    getStorageItem: vi.fn(),
    setStorageItem: vi.fn(),
    removeStorageItem: vi.fn(),
}));

vi.mock('../../../static/js/utils/i18nHelpers.js', () => ({
    translate: vi.fn((key, _params, fallback) => fallback || key),
}));

vi.mock('../../../static/js/managers/FilterPresetManager.js', () => ({
    FilterPresetManager: vi.fn().mockImplementation(() => ({
        renderPresets: vi.fn(),
        saveActivePreset: vi.fn(),
        restoreActivePreset: vi.fn(),
        updateAddButtonState: vi.fn(),
        hasEmptyWildcardResult: vi.fn(() => false),
    })),
    EMPTY_WILDCARD_MARKER: '__EMPTY_WILDCARD_RESULT__',
}));

import { FilterManager } from '../../../static/js/managers/FilterManager.js';
import { getStorageItem } from '../../../static/js/utils/storageHelpers.js';

describe('FilterManager - Civitai publish date', () => {
    let fromInput;
    let toInput;
    let activeFiltersCount;

    beforeEach(() => {
        vi.clearAllMocks();
        getStorageItem.mockReturnValue(undefined);
        document.body.innerHTML = `
            <div id="filterPanel" class="hidden"></div>
            <button id="filterButton"></button>
            <span id="activeFiltersCount"></span>
            <input type="date" id="publishedFromInput">
            <input type="date" id="publishedToInput">
        `;
        fromInput = document.getElementById('publishedFromInput');
        toInput = document.getElementById('publishedToInput');
        activeFiltersCount = document.getElementById('activeFiltersCount');
    });

    async function changeInput(input, value) {
        input.value = value;
        input.dispatchEvent(new Event('change'));
        // The change handler awaits applyFilters
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    it('starts with no range', () => {
        const manager = new FilterManager({ page: 'loras' });

        expect(manager.filters.published).toEqual({});
        expect(manager.hasActiveFilters()).toBe(false);
    });

    it('restores a stored range into the inputs and drops malformed bounds', () => {
        getStorageItem.mockReturnValue({
            baseModel: [],
            tags: {},
            published: { from: '2024-03-01', to: 'next week' },
        });

        const manager = new FilterManager({ page: 'loras' });

        expect(manager.filters.published).toEqual({ from: '2024-03-01' });
        expect(fromInput.value).toBe('2024-03-01');
        expect(toInput.value).toBe('');
        // The end date cannot be picked before the start date.
        expect(toInput.min).toBe('2024-03-01');
    });

    it('applies the range when a date changes and counts it as one filter', async () => {
        const manager = new FilterManager({ page: 'loras' });

        await changeInput(fromInput, '2024-03-01');
        await changeInput(toInput, '2024-03-31');

        expect(manager.filters.published).toEqual({ from: '2024-03-01', to: '2024-03-31' });
        expect(manager.hasActiveFilters()).toBe(true);
        expect(activeFiltersCount.textContent).toBe('1');
        expect(loadMoreWithVirtualScroll).toHaveBeenCalled();
    });

    it('clearing an input removes that bound', async () => {
        const manager = new FilterManager({ page: 'loras' });
        await changeInput(fromInput, '2024-03-01');

        await changeInput(fromInput, '');

        expect(manager.filters.published).toEqual({});
        expect(manager.hasActiveFilters()).toBe(false);
    });

    it('is reset by clear all', async () => {
        const manager = new FilterManager({ page: 'loras' });
        await changeInput(fromInput, '2024-03-01');

        await manager.clearFilters();

        expect(manager.filters.published).toEqual({});
        expect(fromInput.value).toBe('');
    });

    it('is carried by cloned filter snapshots (presets and page state)', async () => {
        const manager = new FilterManager({ page: 'loras' });
        await changeInput(toInput, '2024-12-31');

        const snapshot = manager.cloneFilters();
        snapshot.published.to = 'mutated';

        expect(manager.filters.published).toEqual({ to: '2024-12-31' });
    });
});
