import type { RouterTier } from "../store/index.js";

export interface TierProviderConfig {
	name: RouterTier;
	providers: string[];
	defaultProvider: string;
}

export interface ProviderSelection {
	provider: string;
	availableProviders: string[];
	reason: string;
}

const DEFAULT_PROVIDER_POOLS: Record<RouterTier, TierProviderConfig> = {
	frugal: {
		name: "frugal",
		providers: ["claude-haiku", "gemini-flash", "gpt-4o-mini"],
		defaultProvider: "claude-haiku",
	},
	standard: {
		name: "standard",
		providers: ["claude-sonnet", "gemini-pro", "gpt-4o"],
		defaultProvider: "claude-sonnet",
	},
	frontier: {
		name: "frontier",
		providers: ["claude-opus", "gemini-ultra"],
		defaultProvider: "claude-opus",
	},
};

export function providerConfigForTier(
	tier: RouterTier,
	env: NodeJS.ProcessEnv = process.env,
): TierProviderConfig {
	const envKey = `PAVEDA_PROVIDER_POOL_${tier.toUpperCase()}`;
	const providers = parseProviderPool(env[envKey]) ?? DEFAULT_PROVIDER_POOLS[tier].providers;
	return {
		name: tier,
		providers,
		defaultProvider: providers[0] ?? DEFAULT_PROVIDER_POOLS[tier].defaultProvider,
	};
}

export function selectProvider(input: {
	tier: RouterTier;
	preferredProvider?: string;
	allowedProviders?: readonly string[];
	failedProvider?: string;
	env?: NodeJS.ProcessEnv;
}): ProviderSelection {
	const config = providerConfigForTier(input.tier, input.env);
	const allowed = new Set(input.allowedProviders ?? config.providers);
	const candidates = config.providers.filter(
		(provider) => allowed.has(provider) && provider !== input.failedProvider,
	);
	const preferred = input.preferredProvider;
	if (preferred && candidates.includes(preferred)) {
		return {
			provider: preferred,
			availableProviders: candidates,
			reason: `preferred provider for ${input.tier} tier`,
		};
	}
	return {
		provider: candidates[0] ?? config.defaultProvider,
		availableProviders: candidates.length > 0 ? candidates : [config.defaultProvider],
		reason: input.failedProvider
			? `fallback provider for ${input.tier} tier`
			: `default provider for ${input.tier} tier`,
	};
}

export function handleProviderError(input: {
	tier: RouterTier;
	failedProvider: string;
	preferredProvider?: string;
	allowedProviders?: readonly string[];
	env?: NodeJS.ProcessEnv;
}): ProviderSelection {
	return selectProvider({
		tier: input.tier,
		preferredProvider: input.preferredProvider,
		allowedProviders: input.allowedProviders,
		failedProvider: input.failedProvider,
		env: input.env,
	});
}

function parseProviderPool(value: string | undefined): string[] | undefined {
	const providers = value
		?.split(",")
		.map((provider) => provider.trim())
		.filter(Boolean);
	return providers && providers.length > 0 ? providers : undefined;
}
