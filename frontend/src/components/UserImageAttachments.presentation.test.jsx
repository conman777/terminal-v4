import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserImageAttachments } from './UserImageAttachments';

const itemErrors = [
  ['upload_unconfirmed', 'Upload could not be confirmed. Retry the upload or remove this image.'],
  ['upload_expired', 'Upload expired. Retry using the image saved on this device.'],
  ['missing_bytes', 'Original image bytes are unavailable on this device.'],
  ['quota', 'This device has insufficient storage for the image. Free up space and retry.'],
  ['unavailable', 'The image could not be saved or read on this device. Retry or choose the image again.'],
  ['corrupt', 'Saved image data could not be verified. Remove this attachment and choose the original image again.'],
  ['invalid_input', 'The image file or its metadata is invalid. Choose a supported image again.'],
  ['closed', 'This image draft is closed. Reopen the conversation to continue.'],
  ['stale_scope', 'The image draft changed. Return to the current conversation and retry.'],
  ['conflict', 'Another version of this image draft was found. Review the saved draft before retrying.'],
  ['not_ready', 'The image is not ready. Wait for it to finish saving or retry the upload.'],
];

describe('UserImageAttachments error presentation', () => {
  it.each(itemErrors)('explains the known item error %s', (error, feedback) => {
    render(<UserImageAttachments disabled={false} onAction={vi.fn()} userImages={{
      items: [{ localId: 'denied-image', name: 'layout.png', status: 'error', error }],
      admission: { state: 'allowed' },
    }} />);
    expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual([feedback]);
    expect(screen.getByRole('button', { name: 'Retry image upload layout.png' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove image layout.png' })).toBeEnabled();
  });

  it('retains an unfamiliar actionable item error', () => {
    const feedback = 'This image exceeds the workspace size limit. Choose a smaller image.';
    render(<UserImageAttachments onAction={vi.fn()} userImages={{
      items: [{ localId: 'oversize-image', name: 'large.png', status: 'error', error: feedback }],
      admission: { state: 'allowed' },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(feedback);
  });
});
