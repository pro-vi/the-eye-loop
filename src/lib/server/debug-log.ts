import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_PATH = join(process.cwd(), 'debug.jsonl');

export function debugLog(source: string, event: string, data?: Record<string, unknown>) {
	const entry = JSON.stringify({
		t: new Date().toISOString().slice(11, 23),
		src: source,
		ev: event,
		...data
	});
	try {
		appendFileSync(LOG_PATH, entry + '\n');
	} catch {
		// Silent — debug logging should never crash the app
	}
}
