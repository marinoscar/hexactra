interface OpenAIConfig {
    baseUrl: string;
    apiKey?: string;
    modelId: string;
}
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
    sessionOnlyKeys: Set<string>;
}
/**
 * Initialize provider management
 */
export declare function initProviderManagement(): ProviderState;
/**
 * Load providers from storage
 */
export declare function loadProviders(): Promise<ProviderState>;
/**
 * Save providers to storage
 */
export declare function saveProviders(state: ProviderState): Promise<void>;
/**
 * Add or update a provider
 */
export declare function addProvider(state: ProviderState, config: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProviderConfig>;
/**
 * Update an existing provider
 */
export declare function updateProvider(state: ProviderState, id: string, config: Partial<ProviderConfig>): Promise<void>;
/**
 * Remove a provider
 */
export declare function removeProvider(state: ProviderState, id: string): Promise<void>;
/**
 * Set the current provider
 */
export declare function setCurrentProvider(state: ProviderState, id?: string): Promise<void>;
/**
 * Get the current provider configuration
 */
export declare function getCurrentProvider(state: ProviderState): Promise<ProviderConfig | undefined>;
/**
 * Test connection to a provider endpoint
 */
export declare function testProviderConnection(config: OpenAIConfig): Promise<{
    success: boolean;
    message?: string;
}>;
/**
 * Clear all provider data
 */
export declare function clearProviders(state: ProviderState): Promise<void>;
export {};
//# sourceMappingURL=provider.d.ts.map