import { useState } from 'react';

const LABELS = {
  saving: 'Saving image…', saved: 'Saved on device', uploading: 'Uploading…', ready: 'Ready',
  error: 'Image upload failed', removing: 'Removing…', removal_unknown: 'Removal not confirmed',
  missing_bytes: 'Original image bytes unavailable',
  expired: 'Upload expired. Retry using the image saved on this device.',
};
const PREVIOUS_LABELS = {
  unknown: 'Previous send outcome unknown', checking: 'Checking previous send…',
  accepted_cleanup_pending: 'Previous send accepted. Local cleanup pending.',
  missing_bytes: 'Original image bytes unavailable',
};
const ITEM_ERROR_LABELS = new Map([
  ['upload_unconfirmed', 'Upload could not be confirmed. Retry the upload or remove this image.'],
  ['upload_expired', LABELS.expired],
  ['missing_bytes', 'Original image bytes are unavailable on this device.'],
  ['quota', 'This device has insufficient storage for the image. Free up space and retry.'],
  ['unavailable', 'The image could not be saved or read on this device. Retry or choose the image again.'],
  ['corrupt', 'Saved image data could not be verified. Remove this attachment and choose the original image again.'],
  ['invalid_input', 'The image file or its metadata is invalid. Choose a supported image again.'],
  ['closed', 'This image draft is closed. Reopen the conversation to continue.'],
  ['stale_scope', 'The image draft changed. Return to the current conversation and retry.'],
  ['conflict', 'Another version of this image draft was found. Review the saved draft before retrying.'],
  ['not_ready', 'The image is not ready. Wait for it to finish saving or retry the upload.'],
]);

// Presentation only. The shared controller owns bytes, readiness and mutation.
export function UserImageAttachments({ userImages, disabled, onAction }) {
  const items = Array.isArray(userImages.items) ? userImages.items : [];
  const previous = userImages.pendingPreviousSend;
  const [openOriginals, setOpenOriginals] = useState(null);
  const originalsKey = previous ? JSON.stringify([userImages.scopeKey, userImages.generation, previous.requestId, previous.originalsRevision]) : null;
  const originals = Array.isArray(previous?.originals) ? previous.originals : [];
  return <>
    {items.length > 0 && <section className="user-image-draft" aria-label="Image attachments">
      <div className="user-image-draft-list">
        {items.map(item => <div className="user-image-draft-item" key={item.localId}>
          {typeof item.previewUrl === 'string' && item.previewUrl.startsWith('blob:')
            && <img className="user-image-draft-preview" src={item.previewUrl} alt={`Draft image: ${item.name}`} />}
          <div className="user-image-draft-description">
            <span className="user-image-draft-name">{item.name}</span>
            <span className="user-image-draft-state" role="status" aria-live="polite">{LABELS[item.status] || 'Image state unavailable'}</span>
            {item.error && <span className="user-image-draft-error" role="alert">{ITEM_ERROR_LABELS.get(String(item.error)) || String(item.error).slice(0, 400)}</span>}
          </div>
          <div className="user-image-draft-actions">
            <button type="button" aria-label={`Remove image ${item.name}`} disabled={disabled || item.status === 'removing'}
              onClick={() => onAction('removeImage', item.localId)}>Remove</button>
            {['error', 'saved', 'expired'].includes(item.status) && <button type="button" aria-label={`Retry image upload ${item.name}`} disabled={disabled || item.uploadPinned === true}
              onClick={() => onAction('retryUpload', item.localId)}>Retry upload</button>}
            {item.status === 'removal_unknown' && <button type="button" aria-label={`Retry image removal ${item.name}`} disabled={disabled}
              onClick={() => onAction('removeImage', item.localId)}>Retry removal</button>}
          </div>
        </div>)}
      </div>
    </section>}
    {userImages.isHydrating && <p className="user-image-draft-notice" role="status">Loading saved images…</p>}
    {userImages.isSaving && !items.length && <p className="user-image-draft-notice" role="status">Saving images…</p>}
    {userImages.admission?.state !== 'allowed' && <p className="user-image-draft-notice" role="status">
      {userImages.admission?.reason || (userImages.admission?.state === 'checking' ? 'Checking image support…' : 'Image support is not confirmed for this model.')}
    </p>}
    {userImages.error && <p className="user-image-draft-error" role="alert">{String(userImages.error).slice(0, 400)}</p>}
    {previous && <section className="user-image-previous" aria-label="Previous send">
      <p role="status">{PREVIOUS_LABELS[previous.status] || 'Previous send outcome unknown'}</p>
      <pre>{previous.body?.text || 'Image-only message'}</pre>
      {Array.isArray(previous.body?.attachments) && <ul>{previous.body.attachments.map((item, index) => <li key={index}>{item.name}</li>)}</ul>}
      {originals.length > 0 && <>
        <div className="user-image-draft-actions"><button type="button" disabled={disabled || !previous.originalsCanChoose}
          onClick={() => setOpenOriginals(originalsKey)}>Choose original images</button></div>
        {openOriginals === originalsKey && <>
          <ol className="user-image-draft-list user-image-originals" aria-label="Missing original images">
            {originals.map(item => <li className="user-image-draft-item" key={item.slot}>
              <div className="user-image-draft-description">
                <span className="user-image-draft-name">{item.slot + 1}. {item.name}</span>
                <span className="user-image-draft-state">{item.mimeType}</span>
                <span className="user-image-draft-state">{item.bytes} bytes</span>
                <span className="user-image-draft-state" role="status">{item.selected ? 'Original selected' : 'Original not selected'}</span>
              </div>
              <div className="user-image-draft-actions"><button type="button" aria-label={`Choose original image ${item.slot + 1}: ${item.name}`}
                disabled={disabled || !previous.originalsCanChoose} onClick={() => onAction('chooseOriginalImage', {
                  requestId: previous.requestId, originalsRevision: previous.originalsRevision, slot: item.slot,
                })}>Choose original image {item.slot + 1}: {item.name}</button></div>
            </li>)}
          </ol>
          <div className="user-image-draft-actions"><button type="button" disabled={disabled || !previous.originalsCanSave}
            onClick={() => onAction('saveOriginalImages', { requestId: previous.requestId, originalsRevision: previous.originalsRevision })}>
            {previous.originalsState === 'error' ? 'Retry saving originals' : 'Save original images'}
          </button></div>
        </>}
      </>}
      {previous.originalsState === 'saving' && <p role="status">Saving original images…</p>}
      {previous.originalsError && <p className="user-image-draft-error" role="alert">{String(previous.originalsError).slice(0, 400)}</p>}
      {previous.originalsState === 'restored' && <p role="status">Original images restored on this device. Check or retry the previous send.</p>}
      <div className="user-image-draft-actions">
        <button type="button" disabled={disabled || previous.status === 'checking'} onClick={() => onAction('checkPreviousSend')}>Check previous send</button>
        <button type="button" disabled={disabled || previous.status !== 'unknown'} onClick={() => onAction('retryPreviousSend')}>Retry previous send</button>
      </div>
    </section>}
  </>;
}

