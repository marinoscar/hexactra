//! Provider settings management for Hexactra Chrome extension
//!
//! This module handles provider configuration, secret storage, and scope controls.

// OpenAI-compatible config interface (duplicate to avoid circular deps)
interface OpenAIConfig {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

/**
 * Storage keys
 */
const STORAGE_KEYS = {
  PROVIDERS: 'providers',
  CURRENT_PROVIDER: 'currentProvider',
  SESSION_KEYS: 'sessionKeys', // Keys stored in session storage only
};

/**
 * Provider configuration interface
 */
export interface ProviderConfig extends OpenAIConfig {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Provider settings state
 */
export interface ProviderState {
  providers: Record<string, ProviderConfig>;
  currentProviderId?: string;
  sessionOnlyKeys: Set<string>; // Keys that should only be in session storage
}

/**
 * Initialize provider management
 */
export function initProviderManagement(): ProviderState {
  return {
    providers: {},
    currentProviderId: undefined,
    sessionOnlyKeys: new Set(['apiKey']),
  };
}

/**
 * Load providers from storage
 */
export async function loadProviders(): Promise<ProviderState> {
  const state = initProviderManagement();

  try {
    const providers = await chrome.storage.sync.get([STORAGE_KEYS.PROVIDERS]);
    if (providers[STORAGE_KEYS.PROVIDERS]) {
      state.providers = providers[STORAGE_KEYS.PROVIDERS];
    }

    const current = await chrome.storage.sync.get([STORAGE_KEYS.CURRENT_PROVIDER]);
    if (current[STORAGE_KEYS.CURRENT_PROVIDER]) {
      state.currentProviderId = current[STORAGE_KEYS.CURRENT_PROVIDER];
    }
  } catch (error) {
    console.error('Failed to load providers:', error);
  }

  return state;
}

/**
 * Save providers to storage
 */
export async function saveProviders(state: ProviderState): Promise<void> {
  try {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.PROVIDERS]: state.providers,
      [STORAGE_KEYS.CURRENT_PROVIDER]: state.currentProviderId,
    });
  } catch (error) {
    console.error('Failed to save providers:', error);
  }
}

/**
 * Add or update a provider
 */
export async function addProvider(
  state: ProviderState,
  config: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>
): Promise<ProviderConfig> {
  const id = Date.now().toString();
  const now = Date.now();

  const provider: ProviderConfig = {
    ...config,
    id,
    createdAt: now,
    updatedAt: now,
  };

  state.providers[id] = provider;
  await saveProviders(state);

  return provider;
}

/**
 * Update an existing provider
 */
export async function updateProvider(
  state: ProviderState,
  id: string,
  config: Partial<ProviderConfig>
): Promise<void> {
  if (!state.providers[id]) {
    throw new Error(`Provider not found: ${id}`);
  }

  state.providers[id] = {
    ...state.providers[id],
    ...config,
    updatedAt: Date.now(),
  };

  await saveProviders(state);
}

/**
 * Remove a provider
 */
export async function removeProvider(
  state: ProviderState,
  id: string
): Promise<void> {
  if (!state.providers[id]) {
    throw new Error(`Provider not found: ${id}`);
  }

  delete state.providers[id];
  if (state.currentProviderId === id) {
    state.currentProviderId = undefined;
  }

  await saveProviders(state);
}

/**
 * Set the current provider
 */
export async function setCurrentProvider(
  state: ProviderState,
  id?: string
): Promise<void> {
  state.currentProviderId = id;
  await saveProviders(state);
}

/**
 * Get the current provider configuration
 */
export async function getCurrentProvider(state: ProviderState): Promise<ProviderConfig | undefined> {
  if (!state.currentProviderId) {
    return undefined;
  }

  return state.providers[state.currentProviderId];
}

/**
 * Test connection to a provider endpoint
 */
export async function testProviderConnection(config: OpenAIConfig): Promise<{
  success: boolean;
  message?: string;
}> {
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      return { success: true, message: 'Connection successful' };
    }

    const errorData = await response.json().catch(() => ({}));
    return {
      success: false,
      message: errorData.error?.message || `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear all provider data
 */
export async function clearProviders(state: ProviderState): Promise<void> {
  state.providers = {};
  state.currentProviderId = undefined;
  await saveProviders(state);
}
