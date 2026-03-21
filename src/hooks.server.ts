import { startOracle } from '$lib/server/agents/oracle';

export async function init() {
	startOracle();
	// startBuilder() -- added when 06-builder is implemented
	// Scouts start via POST /api/session, not here
}
