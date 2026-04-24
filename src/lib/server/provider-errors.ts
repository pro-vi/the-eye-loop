import type { SSEEventMap } from '$lib/context/types';

export function classifyErrorCode(err: unknown): SSEEventMap['error']['code'] {
	const details: string[] = [];
	if (err instanceof Error) {
		details.push(err.name, err.message);
	}
	if (typeof err === 'object' && err !== null) {
		if ('statusCode' in err && typeof err.statusCode === 'number') {
			details.push(String(err.statusCode));
		}
		if ('responseBody' in err && typeof err.responseBody === 'string') {
			details.push(err.responseBody);
		}
		if ('data' in err && err.data) {
			details.push(JSON.stringify(err.data));
		}
	}
	const s = details.filter(Boolean).join(' ') || String(err);
	if (/401|Invalid bearer|authentication_error|x-api-key/i.test(s)) {
		return 'provider_auth_failure';
	}
	if (/AI_APICall|rate_limit_error|429|fetch failed|ECONNREFUSED|timeout/i.test(s)) {
		return 'provider_error';
	}
	return 'generation_error';
}
