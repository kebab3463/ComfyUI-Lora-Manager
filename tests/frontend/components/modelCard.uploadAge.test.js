import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock(STATE_MODULE, () => ({
  state: {
    settings: { blur_mature_content: false, model_name_display: 'model_name' },
    global: {
      settings: {
        model_name_display: 'model_name',
        group_by_model: false,
        display_density: 'default',
        model_card_footer_action: 'replace_preview',
      },
    },
    pages: { loras: { previewVersions: new Map(), sortBy: 'name:asc' } },
    bulkMode: false,
    selectedLoras: new Set(),
  },
  getCurrentPageState: vi.fn(() => ({ sortBy: 'name:asc', previewVersions: new Map() })),
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

// Returns the fallback, which already carries the interpolated numbers.
vi.mock(I18N_MODULE, () => ({
  translate: vi.fn((key, params, fallback) => fallback || key),
}));

vi.mock(API_CONFIG_MODULE, () => ({
  MODEL_TYPES: { LORA: 'loras', CHECKPOINT: 'checkpoints', EMBEDDING: 'embeddings' },
}));

vi.mock(API_FACTORY_MODULE, () => ({
  getModelApiClient: vi.fn(() => ({ uploadPreview: vi.fn() })),
}));

const NOW = new Date('2026-08-15T00:00:00Z');
const MS_PER_MONTH = 30.436875 * 86400000;

function monthsAgo(months) {
  return new Date(NOW.getTime() - months * MS_PER_MONTH).toISOString();
}

function daysAgo(days) {
  return new Date(NOW.getTime() - days * 86400000).toISOString();
}

describe('ModelCard upload age', () => {
  let formatUploadAge;
  let createModelCard;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    ({ formatUploadAge, createModelCard } = await import(MODEL_CARD_MODULE));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function age(civitai) {
    return formatUploadAge({ civitai });
  }

  it('reports a recent upload as the current month', () => {
    expect(age({ publishedAt: daysAgo(0) })).toBe('this month');
    expect(age({ publishedAt: daysAgo(10) })).toBe('this month');
  });

  it('rounds to the nearest month rather than truncating', () => {
    // 20 days is 0.66 months, which rounds up to 1.
    expect(age({ publishedAt: daysAgo(20) })).toBe('1mo ago');
  });

  it('reports whole months below a year', () => {
    expect(age({ publishedAt: monthsAgo(3) })).toBe('3mo ago');
    expect(age({ publishedAt: monthsAgo(11) })).toBe('11mo ago');
  });

  it('rolls up to years at twelve months', () => {
    expect(age({ publishedAt: monthsAgo(12) })).toBe('1y ago');
    expect(age({ publishedAt: monthsAgo(24) })).toBe('2y ago');
  });

  it('combines years and months when there is a remainder', () => {
    expect(age({ publishedAt: monthsAgo(18) })).toBe('1y 6mo ago');
    expect(age({ publishedAt: monthsAgo(41) })).toBe('3y 5mo ago');
  });

  it('falls back to createdAt when publishedAt is absent', () => {
    // Full metadata payloads may carry only createdAt.
    expect(age({ createdAt: monthsAgo(5) })).toBe('5mo ago');
  });

  it('prefers publishedAt over createdAt', () => {
    expect(age({ publishedAt: monthsAgo(2), createdAt: monthsAgo(9) })).toBe('2mo ago');
  });

  it('returns null when the date is missing or unusable', () => {
    expect(age({})).toBeNull();
    expect(age({ publishedAt: '' })).toBeNull();
    expect(age({ publishedAt: 'not a date' })).toBeNull();
    expect(age({ publishedAt: 12345 })).toBeNull();
    expect(formatUploadAge({})).toBeNull();
  });

  it('returns null for a future date instead of a negative age', () => {
    expect(age({ publishedAt: monthsAgo(-6) })).toBeNull();
  });

  function createCard(civitai) {
    return createModelCard(
      {
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
        civitai,
        sub_type: 'lora',
      },
      'loras',
    );
  }

  it('renders the age on the card under a name sort', () => {
    const card = createCard({ id: 1, publishedAt: monthsAgo(7) });
    const badge = card.querySelector('.civitai-stat--uploaded');

    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('7mo ago');
  });

  it('omits the badge when the upload date is unknown', () => {
    expect(createCard({ id: 1 }).querySelector('.civitai-stat--uploaded')).toBeNull();
  });
});
