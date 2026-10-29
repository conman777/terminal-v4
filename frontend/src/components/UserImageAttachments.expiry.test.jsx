import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserImageAttachments } from './UserImageAttachments';

describe('expired image recovery actions', () => {
  it.each([true, false])('protects a pending pin (%s) while leaving a newer draft image retryable', uploadPinned => {
    const onAction = vi.fn();
    render(<UserImageAttachments disabled={false} onAction={onAction} userImages={{
      items: [{ localId: 'synthetic-local-image', name: 'retained.png', status: 'expired', uploadPinned }],
      admission: { state: 'allowed' }, pendingPreviousSend: { requestId: 'synthetic-request', status: 'unknown', body: { text: 'original' } },
    }} />);
    const retry = screen.getByRole('button', { name: 'Retry image upload retained.png' });
    expect(retry.disabled).toBe(uploadPinned);
    fireEvent.click(retry);
    expect(onAction.mock.calls).toEqual(uploadPinned ? [] : [['retryUpload', 'synthetic-local-image']]);
  });
});
