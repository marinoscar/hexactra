// The public surface of the secrets providers (E37.2, #591), for the runner (E37.3), the Secrets page (E37.4) and
// the fabric adapter (E37.1).
export { FABRIC_SECRETS_REGISTRY, FabricSecretsUnavailable, FabricSessionSecretsRegistry, InMemoryFabricSecretsRegistry, type FabricSecretsRegistry, type SecretsProviderRegistration } from './fabric-secrets-registry';
export { SecretsModule } from './secrets.module';
export { SecretsPolicyService, type AgentUseState } from './secrets-policy.service';
export { SecretsProviderRegistrar, type RegistrationResult } from './secrets-provider.registrar';
export { VaultConnectionService, type ProviderOutcome, type SecretsStatusView, type VaultStatusView } from './vault-connection.service';
export { VaultAccessError, VaultTokenService, type VaultAccess } from './vault-token.service';
