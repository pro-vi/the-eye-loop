import { createAnthropic } from '@ai-sdk/anthropic';
import { env } from '$env/dynamic/private';
import {
	BUILDER_MODEL_ID,
	ORACLE_MODEL_ID,
	REVEAL_MODEL_ID,
	SCOUT_MODEL_ID
} from '$lib/server/runtime-config';

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

// Role-tiered bindings. Defaults keep the validated Haiku/Sonnet split,
// but each role can now be tuned independently through env vars.
export const SCOUT_MODEL = anthropic(SCOUT_MODEL_ID);
export const ORACLE_MODEL = anthropic(ORACLE_MODEL_ID);
export const BUILDER_MODEL = anthropic(BUILDER_MODEL_ID);

// Quality tier — builder reveal
export const REVEAL_MODEL = anthropic(REVEAL_MODEL_ID);
