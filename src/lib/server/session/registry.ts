import { EyeLoopSession } from './eye-loop-session';

const sessions = new Map<string, EyeLoopSession>();

export function createSession(intent: string): EyeLoopSession {
	const session = new EyeLoopSession(intent);
	sessions.set(session.sessionId, session);
	return session;
}

export function getSession(sessionId: string | null | undefined): EyeLoopSession | null {
	if (!sessionId) return null;
	return sessions.get(sessionId) ?? null;
}

export function deleteSession(sessionId: string) {
	sessions.delete(sessionId);
}

export function getAllSessions(): EyeLoopSession[] {
	return [...sessions.values()];
}
