export function applyProjectOrder(sessions, orders, pathOf, { pinnedFirst = false } = {}) {
  const byProject = new Map();
  sessions.forEach((session, index) => {
    const key = pathOf(session);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(index);
  });
  const result = [...sessions];
  for (const [key, slots] of byProject) {
    const saved = orders?.[key];
    if (!Array.isArray(saved) || saved.length === 0) continue;
    const rank = new Map(saved.map((id, index) => [id, index]));
    const members = slots.map(slot => sessions[slot]);
    const fresh = members.filter(session => !rank.has(session.id));
    const known = members.filter(session => rank.has(session.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    [...fresh, ...known].forEach((session, position) => { result[slots[position]] = session; });
  }
  if (!pinnedFirst) return result;
  return [...result.filter(session => session.thread?.pinned), ...result.filter(session => !session.thread?.pinned)];
}

export function moveRelative(ids, id, targetId, after) {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return null;
  const without = ids.filter(value => value !== id);
  const at = without.indexOf(targetId) + (after ? 1 : 0);
  const next = [...without.slice(0, at), id, ...without.slice(at)];
  return next.every((value, index) => value === ids[index]) ? null : next;
}

export function stepTarget(visibleIds, id, delta) {
  const index = visibleIds.indexOf(id);
  const target = visibleIds[index + delta];
  if (index < 0 || target === undefined) return null;
  return { targetId: target, after: delta > 0 };
}
