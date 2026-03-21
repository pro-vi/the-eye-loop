import { startOracle } from '$lib/server/agents/oracle';
import { startBuilder } from '$lib/server/agents/builder';

export async function init() {
	startOracle();
	startBuilder();
	// Scouts start via POST /api/session, not here
}
