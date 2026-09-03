import { describe, it, beforeEach, expect, vi } from 'vitest';

const {
  EVENTS_MODULE,
  API_MODULE,
  APP_MODULE,
} = vi.hoisted(() => ({
  EVENTS_MODULE: new URL('../../../web/comfyui/loras_widget_events.js', import.meta.url).pathname,
  API_MODULE: new URL('../../../scripts/api.js', import.meta.url).pathname,
  APP_MODULE: new URL('../../../scripts/app.js', import.meta.url).pathname,
}));

const fetchApi = vi.fn();
const toastAdd = vi.fn();

vi.mock(API_MODULE, () => ({
  api: { fetchApi: (...args) => fetchApi(...args) },
}));

vi.mock(APP_MODULE, () => ({
  app: { extensionManager: { toast: { add: (...args) => toastAdd(...args) } } },
}));

function jsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Let the state lookup fired during menu construction settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function favoriteItem() {
  return [...document.querySelectorAll('.lm-lora-menu-item')].find((item) =>
    /Favorites/.test(item.textContent)
  );
}

async function openMenu(loraName = 'characters/mianne') {
  const { createContextMenu } = await import(EVENTS_MODULE);
  const widget = { value: [{ name: loraName, strength: 1 }], callback: vi.fn() };
  createContextMenu(10, 10, loraName, widget, null, vi.fn());
  await flush();
  return widget;
}

describe('LoRA widget context menu — favorites', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    fetchApi.mockReset();
    toastAdd.mockReset();
  });

  it('offers a favorites entry alongside the existing options', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: false, file_path: '/loras/mianne.safetensors' })
    );

    await openMenu();

    expect(favoriteItem()).toBeTruthy();
    // The entry that was already there must survive.
    const labels = [...document.querySelectorAll('.lm-lora-menu-item')].map((i) => i.textContent);
    expect(labels.some((l) => /View on Civitai/.test(l))).toBe(true);
  });

  it('looks the current state up by name when the menu opens', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: false, file_path: '/loras/mianne.safetensors' })
    );

    await openMenu('characters/mianne');

    expect(fetchApi).toHaveBeenCalledWith(
      '/lm/loras/favorite?name=characters%2Fmianne'
    );
    expect(favoriteItem().textContent).toContain('Add to Favorites');
  });

  it('relabels itself when the LoRA is already a favorite', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: true, file_path: '/loras/mianne.safetensors' })
    );

    await openMenu();

    expect(favoriteItem().textContent).toContain('Remove from Favorites');
  });

  it('adds to favorites through save-metadata on click', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: false, file_path: '/loras/mianne.safetensors' })
    );
    await openMenu();

    fetchApi.mockReset();
    fetchApi.mockResolvedValue(jsonResponse({ success: true }));
    favoriteItem().click();
    await flush();

    expect(fetchApi).toHaveBeenCalledTimes(1);
    const [url, options] = fetchApi.mock.calls[0];
    expect(url).toBe('/lm/loras/save-metadata');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      file_path: '/loras/mianne.safetensors',
      favorite: true,
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', detail: 'Added to favorites' })
    );
  });

  it('removes from favorites when it is already one', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: true, file_path: '/loras/mianne.safetensors' })
    );
    await openMenu();

    fetchApi.mockReset();
    fetchApi.mockResolvedValue(jsonResponse({ success: true }));
    favoriteItem().click();
    await flush();

    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toEqual({
      file_path: '/loras/mianne.safetensors',
      favorite: false,
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Removed from favorites' })
    );
  });

  it('resolves the state on click when the opening lookup had not landed', async () => {
    // Menu opens while the lookup is still failing/pending: no toast, no noise.
    fetchApi.mockRejectedValueOnce(new Error('network hiccup'));
    await openMenu();
    expect(toastAdd).not.toHaveBeenCalled();
    expect(favoriteItem().textContent).toContain('Add to Favorites');

    fetchApi.mockReset();
    fetchApi
      .mockResolvedValueOnce(
        jsonResponse({ success: true, favorite: false, file_path: '/loras/mianne.safetensors' })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    favoriteItem().click();
    await flush();

    expect(fetchApi.mock.calls[0][0]).toBe('/lm/loras/favorite?name=characters%2Fmianne');
    expect(fetchApi.mock.calls[1][0]).toBe('/lm/loras/save-metadata');
  });

  it('reports a LoRA missing from the cache instead of writing metadata', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: false, error: 'Lora not found in cache' }, false)
    );
    await openMenu();

    fetchApi.mockReset();
    fetchApi.mockResolvedValue(
      jsonResponse({ success: false, error: 'Lora not found in cache' }, false)
    );
    favoriteItem().click();
    await flush();

    expect(fetchApi.mock.calls.every(([url]) => !url.includes('save-metadata'))).toBe(true);
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    );
  });

  it('closes the menu when the entry is clicked', async () => {
    fetchApi.mockResolvedValue(
      jsonResponse({ success: true, favorite: false, file_path: '/loras/mianne.safetensors' })
    );
    await openMenu();
    expect(document.querySelector('.lm-lora-context-menu')).toBeTruthy();

    fetchApi.mockResolvedValue(jsonResponse({ success: true }));
    favoriteItem().click();
    await flush();

    expect(document.querySelector('.lm-lora-context-menu')).toBeNull();
  });
});
