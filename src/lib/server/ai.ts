import { createAnthropic } from '@ai-sdk/anthropic';
import { env } from '$env/dynamic/private';

const anthropic = createAnthropic({
	apiKey: 'x',
	headers: {
		'x-api-key': '',
		Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ''}`,
		'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
		'user-agent': 'claude-cli/2.1.2 (external, cli)',
		'x-app': 'cli'
	}
});

// Fast tier — scouts, builder (scaffold/rebuild), oracle
export const FAST_MODEL = anthropic('claude-haiku-4-5-20251001');

// Quality tier — builder reveal
export const QUALITY_MODEL = anthropic('claude-sonnet-4-6');
