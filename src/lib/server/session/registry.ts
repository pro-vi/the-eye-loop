import { EyeLoopSession } from './eye-loop-session';

const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 100;

interface RegisteredSession {
	session: EyeLoopSession;
	lastAccessedAt: number;
}

const sessions = new Map<string, RegisteredSession>();

function sweepSessions(now = Date.now()) {
	for (const [sessionId, entry] of sessions) {
		if (now - entry.lastAccessedAt > SESSION_IDLE_TTL_MS) sessions.delete(sessionId);
	}

	if (sessions.size <= MAX_SESSIONS) return;
	const oldest = [...sessions.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
	for (const [sessionId] of oldest.slice(0, sessions.size - MAX_SESSIONS)) {
		sessions.delete(sessionId);
	}
}

export function createSession(intent: string): EyeLoopSession {
	sweepSessions();
	const session = new EyeLoopSession(intent);
	sessions.set(session.sessionId, { session, lastAccessedAt: Date.now() });
	return session;
}

export function getSession(sessionId: string | null | undefined): EyeLoopSession | null {
	if (!sessionId) return null;
	const entry = sessions.get(sessionId);
	if (!entry) return null;
	const now = Date.now();
	if (now - entry.lastAccessedAt > SESSION_IDLE_TTL_MS) {
		sessions.delete(sessionId);
		return null;
	}
	entry.lastAccessedAt = now;
	return entry.session;
}

export function deleteSession(sessionId: string) {
	sessions.delete(sessionId);
}

export function getAllSessions(): EyeLoopSession[] {
	sweepSessions();
	return [...sessions.values()].map((entry) => entry.session);
}
