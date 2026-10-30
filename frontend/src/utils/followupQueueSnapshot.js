export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_BYTES = 100_000;
const bytes = value => new TextEncoder().encode(value).length;
export const integer = value => Number.isSafeInteger(value) && value >= 0;

export function validateSnapshot(value) {
  if (!value || !integer(value.revision) || !['held', 'running'].includes(value.mode)
    || (value.mode === 'held' ? !['new', 'restart', 'manual', 'dispatch_error'].includes(value.holdReason) : value.holdReason != null)
    || !Array.isArray(value.items) || value.items.length > 128 || !Array.isArray(value.order)) throw new Error('The host returned an invalid queue. Reload before changing it.');
  const ids = new Set(); const requests = new Set(); const pending = new Set();
  for (const item of value.items) {
    if (!item || !UUID.test(item.itemId) || ids.has(item.itemId) || !UUID.test(item.inputRequestId) || requests.has(item.inputRequestId)
      || !integer(item.revision) || item.revision < 1 || item.revision > value.revision || typeof item.text !== 'string' || bytes(item.text) > MAX_BYTES
      || !['pending', 'dispatching', 'accepted', 'removed'].includes(item.state)) throw new Error('The host returned an invalid queue. Reload before changing it.');
    ids.add(item.itemId); requests.add(item.inputRequestId); if (item.state === 'pending') pending.add(item.itemId);
  }
  if (value.order.length !== pending.size || new Set(value.order).size !== value.order.length || value.order.some(id => !pending.has(id))) throw new Error('The host returned an invalid queue order.');
  if (value.items.filter(item => item.state === 'dispatching').length > 1) throw new Error('The host returned an invalid queue reservation.');
  return value;
}

export function applyOptimistic(snapshot, operation) {
  const items = snapshot.items.map(item => ({ ...item }));
  let order = [...snapshot.order];
  const saving = new Set();
  switch (operation.kind) {
    case 'enqueue':
      if (items.some(item => item.itemId === operation.itemId)) break;
      items.push({ itemId: operation.itemId, revision: 0, text: operation.text, inputRequestId: operation.itemId, state: 'pending' });
      order.push(operation.itemId); saving.add(operation.itemId); break;
    case 'edit': {
      const item = items.find(entry => entry.itemId === operation.itemId);
      if (item) { item.text = operation.text; saving.add(item.itemId); }
      break;
    }
    case 'remove':
      saving.add(operation.itemId); order = order.filter(id => id !== operation.itemId); break;
    case 'promote':
      order = [operation.itemId, ...order.filter(id => id !== operation.itemId)]; saving.add(operation.itemId); break;
    case 'reorder':
      order = [...operation.itemIds]; operation.itemIds.forEach(id => saving.add(id)); break;
    default: break;
  }
  return { items, order, saving };
}
