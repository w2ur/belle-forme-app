// Pure upsert for the sessions list: replace in place when the id is known,
// prepend otherwise.
export function upsertSession(sessions, session) {
  const i = sessions.findIndex((s) => s.id === session.id);
  if (i === -1) return [session, ...sessions];
  return sessions.map((s, j) => (j === i ? session : s));
}
