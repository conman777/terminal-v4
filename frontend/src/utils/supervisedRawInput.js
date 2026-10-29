export async function sendSupervisedRawInput({ text, store, api, isCurrent, withLock }) {
  return withLock(async () => {
    if (!isCurrent()) throw new Error('The account or environment changed. Input was not sent.');
    const pending = store.read();
    if (pending) return { status: 'review_required', requestId: pending.requestId };
    const issued = await api.issue();
    if (!isCurrent()) throw new Error('The account or environment changed. Input was not sent.');
    await store.reserve(issued);
    await store.markSending(issued.requestId);
    try {
      const result = await api.send({ text, fallbackToMessage: false, requestId: issued.requestId, deliveryToken: issued.deliveryToken });
      if (!isCurrent() || result?.requestId !== issued.requestId || result?.status !== 'delivered') {
        return { status: 'uncertain', requestId: issued.requestId };
      }
      const acknowledgment = await api.review(issued.requestId);
      if (!isCurrent() || acknowledgment?.requestId !== issued.requestId || acknowledgment.status !== 'acknowledged') {
        return { status: 'uncertain', requestId: issued.requestId };
      }
      await store.clear(issued.requestId);
      return { status: 'delivered', requestId: issued.requestId };
    } catch {
      return { status: 'uncertain', requestId: issued.requestId };
    }
  });
}

export async function reviewSupervisedRawInput({ store, api, isCurrent, withLock, acknowledged }) {
  return withLock(async () => {
    if (!isCurrent()) throw new Error('The account or environment changed.');
    const pending = store.read();
    if (!pending) return { status: 'none' };
    const unknown = { status: 'unknown', requestId: pending.requestId };
    try {
      const receipt = await api.lookup(pending.requestId);
      if (!isCurrent() || receipt?.requestId !== pending.requestId || !['issued', 'uncertain', 'delivered', 'acknowledged', 'reviewed'].includes(receipt.status)) return unknown;
      if (['acknowledged', 'reviewed'].includes(receipt.status)) {
        await store.clear(pending.requestId);
        return { status: receipt.status, requestId: pending.requestId };
      }
      if (!acknowledged && receipt.status !== 'delivered') return { status: receipt.status, requestId: pending.requestId };
      const result = await api.review(pending.requestId);
      const expected = receipt.status === 'delivered' ? 'acknowledged' : 'reviewed';
      if (!isCurrent() || result?.requestId !== pending.requestId || result.status !== expected) return unknown;
      await store.clear(pending.requestId);
      return { status: expected, requestId: pending.requestId };
    } catch {
      return unknown;
    }
  });
}
