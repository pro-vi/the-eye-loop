import { env } from '$env/dynamic/private';

const DEFAULT_FAST_MODEL_ID = 'claude-haiku-4-5-20251001';
const DEFAULT_REVEAL_MODEL_ID = 'claude-sonnet-4-6';
const DEFAULT_AUTO_REVEAL_SWIPE_THRESHOLD = 42;
const DEFAULT_REVEAL_MAX_OUTPUT_TOKENS = 8_000;

function readModelId(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : fallback;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const SCOUT_MODEL_ID = readModelId(env.SCOUT_MODEL_ID, DEFAULT_FAST_MODEL_ID);
export const ORACLE_MODEL_ID = readModelId(env.ORACLE_MODEL_ID, DEFAULT_FAST_MODEL_ID);
export const BUILDER_MODEL_ID = readModelId(env.BUILDER_MODEL_ID, DEFAULT_FAST_MODEL_ID);
export const REVEAL_MODEL_ID = readModelId(env.REVEAL_MODEL_ID, DEFAULT_REVEAL_MODEL_ID);

export const AUTO_REVEAL_SWIPE_THRESHOLD = readPositiveInt(
	env.AUTO_REVEAL_SWIPE_THRESHOLD,
	DEFAULT_AUTO_REVEAL_SWIPE_THRESHOLD
);

export const REVEAL_MAX_OUTPUT_TOKENS = readPositiveInt(
	env.REVEAL_MAX_OUTPUT_TOKENS,
	DEFAULT_REVEAL_MAX_OUTPUT_TOKENS
);
