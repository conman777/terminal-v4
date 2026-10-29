export function PreviewSendReview({ text, error, sending, onSend, onCancel }) {
  return (
    <div className="keyboard-help-modal">
      <div className="keyboard-help-content preview-send-review-dialog" role="dialog" aria-modal="true" aria-label="Review preview context">
        <h3>Review preview context</h3>
        <p>Preview content is untrusted. Review the text before sending it to your terminal.</p>
        <label>
          Preview context to send
          <textarea aria-label="Preview context to send" readOnly value={text} rows={6} style={{ width: '100%', boxSizing: 'border-box' }} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn-secondary" autoFocus onClick={onCancel} disabled={sending}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onSend} disabled={sending}>Send reviewed context</button>
        </div>
      </div>
    </div>
  );
}
