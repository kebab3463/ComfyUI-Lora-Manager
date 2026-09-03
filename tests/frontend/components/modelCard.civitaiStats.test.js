import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  MODEL_CARD_MODULE,
  STATE_MODULE,
  UI_HELPERS_MODULE,
  I18N_MODULE,
  API_CONFIG_MODULE,
  API_FACTORY_MODULE,
} = vi.hoisted(() => ({
  MODEL_CARD_MODULE: new URL('../../../static/js/components/shared/ModelCard.js', import.meta.url).pathname,
  STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  API_CONFIG_MODULE: new URL('../../../static/js/api/apiConfig.js', import.meta.url).pathname,
  API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
}));

// The card must render stats regardless of the active sort, so this is fixed
// to a name sort throughout.
vi.mock(STATE_MODULE, () => ({
  state: {
    settings: {
      blur_mature_content: false,
      model_name_display: 'model_name',
    },
    global: {
      settings: {
        model_name_display: 'model_name',
        group_by_model: false,
        display_density: 'default',
        model_card_footer_action: 'replace_preview',
      },
    },
    pages: {
      loras: {
        previewVersions: new Map(),
        sortBy: 'name:asc',
      },
    },
    bulkMode: false,
    selectedLoras: new Set(),
  },
  getCurrentPageState: vi.fn(() => ({
    sortBy: 'name:asc',
    previewVersions: new Map(),
  })),
}));

vi.mock(UI_HELPERS_MODULE, () => ({
  showToast: vi.fn(),
  openCivitai: vi.fn(),
  openHuggingFace: vi.fn(),
  copyToClipboard: vi.fn(),
  copyLoraSyntax: vi.fn(),
  sendLoraToWorkflow: vi.fn(),
  sendEmbeddingToWorkflow: vi.fn(),
  openExampleImagesFolder: vi.fn(),
  buildLoraSyntax: vi.fn(),
  sendModelPathToWorkflow: vi.fn(),
}));

vi.mock(I18N_MODULE, () => ({
  translate: vi.fn((key, params, fallback) => fallback || key),
}));

vi.mock(API_CONFIG_MODULE, () => ({
  MODEL_TYPES: { LORA: 'loras', CHECKPOINT: 'checkpoints', EMBEDDING: 'embeddings' },
}));

vi.mock(API_FACTORY_MODULE, () => ({
  getModelApiClient: vi.fn(() => ({ uploadPreview: vi.fn() })),
}));

describe('ModelCard Civitai stats', () => {
  let createModelCard;

  beforeEach(async () => {
    ({ createModelCard } = await import(MODEL_CARD_MODULE));
  });

  function createCard(stats) {
    const model = {
      sha256: 'abc123',
      file_path: '/models/test_lora.safetensors',
      model_name: 'Test LoRA',
      file_name: 'test_lora',
      folder: 'models',
      modified: 1234567890,
      file_size: 1024,
      usage_count: 0,
      notes: '',
      base_model: 'SD1.5',
      favorite: false,
      exclude: false,
      hf_url: '',
      update_available: false,
      skip_metadata_refresh: false,
      preview_url: '',
      preview_nsfw_level: 0,
      tags: [],
      civitai: stats === undefined ? {} : { id: 1, stats },
      sub_type: 'lora',
    };
    return createModelCard(model, 'loras');
  }

  it('renders like and download counts under a name sort', () => {
    const card = createCard({ thumbsUpCount: 42, downloadCount: 900 });

    const likes = card.querySelector('.civitai-stat--likes');
    const downloads = card.querySelector('.civitai-stat--downloads');

    expect(likes).not.toBeNull();
    expect(likes.textContent).toContain('42');
    expect(downloads).not.toBeNull();
    expect(downloads.textContent).toContain('900');
  });

  it('omits the counters entirely when stats have never been fetched', () => {
    const card = createCard(undefined);

    expect(card.querySelector('.civitai-stat--likes')).toBeNull();
    expect(card.querySelector('.civitai-stat--downloads')).toBeNull();
  });

  it('renders a genuine zero rather than hiding it', () => {
    const card = createCard({ thumbsUpCount: 0, downloadCount: 0 });

    expect(card.querySelector('.civitai-stat--likes').textContent).toContain('0');
    expect(card.querySelector('.civitai-stat--downloads').textContent).toContain('0');
  });

  it('shows each counter independently when only one is known', () => {
    const card = createCard({ downloadCount: 7 });

    expect(card.querySelector('.civitai-stat--likes')).toBeNull();
    expect(card.querySelector('.civitai-stat--downloads').textContent).toContain('7');
  });

  it('formats large numbers compactly', () => {
    const card = createCard({ thumbsUpCount: 1234, downloadCount: 2500000 });

    expect(card.querySelector('.civitai-stat--likes').textContent).toContain('1.2k');
    expect(card.querySelector('.civitai-stat--downloads').textContent).toContain('2.5M');
  });

  it('ignores non-numeric stat values', () => {
    const card = createCard({ thumbsUpCount: 'lots', downloadCount: null });

    expect(card.querySelector('.civitai-stat--likes')).toBeNull();
    expect(card.querySelector('.civitai-stat--downloads')).toBeNull();
  });
});
