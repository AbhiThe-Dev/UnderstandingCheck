const sessions = new Map<string, { userId: string; createdAt: Date }>();

export async function createSession(userId: string): Promise<string> {
  const token = Math.random().toString(36).slice(2);
  sessions.set(token, { userId, createdAt: new Date() });
  return token;
}

export async function endSessionsForUser(userId: string): Promise<number> {
  let ended = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(token);
      ended++;
    }
  }
  return ended;
}
