import { useState, useId, useRef, useEffect } from 'react';
import './AccountAccess.css';
import { apiPost } from '../utils/api';

export default function ChangePasswordModal({ isOpen, onClose }) {
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  return isOpen ? <OpenChangePasswordModal onClose={onClose} writing={writing} pending={pending} onWritingChange={setPending} /> : null;
}

function OpenChangePasswordModal({ onClose, writing, pending, onWritingChange }) {
  const titleId = useId();
  const dialog = useRef(null);
  const mounted = useRef(false);
  const closeTimer = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => { mounted.current = false; clearTimeout(closeTimer.current); if (opener?.isConnected) opener.focus(); };
  }, []);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleSave = async () => {
    if (writing.current) return;
    setError(null);
    setSuccess(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('All fields are required');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    writing.current = true;
    onWritingChange(true);
    setIsSaving(true);
    try {
      await apiPost('/api/auth/change-password', {
        currentPassword,
        newPassword
      });
      if (!mounted.current) return;
      setSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      // Close modal after 1.5 seconds
      closeTimer.current = setTimeout(() => {
        if (!mounted.current) return;
        onClose();
        setSuccess(null);
      }, 1500);
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to change password');
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setIsSaving(false);
    }
  };

  const handleClose = () => {
    clearTimeout(closeTimer.current);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(null);
    onClose();
  };

  function keyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); handleClose(); }
    if (event.key !== 'Tab') return;
    const fields = dialog.current?.querySelectorAll(':is(button, input):not(:disabled)');
    if (!fields?.length) return;
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content account-access-modal account-password-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} tabIndex={-1} onKeyDown={keyDown} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id={titleId}>Change Password</h2>
          <button className="modal-close" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {pending && !isSaving && <p role="status">An earlier password change is still pending. Wait for it to finish before making another change.</p>}
          <div className="form-group">
            <label htmlFor="current-password">Current Password</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              disabled={isSaving || pending}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
          </div>

          <div className="form-group">
            <label htmlFor="new-password">New Password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              disabled={isSaving || pending}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password (min 6 characters)"
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label htmlFor="confirm-password">Confirm New Password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              disabled={isSaving || pending}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
            />
          </div>

          {error && <div className="form-error" role="alert">{error}</div>}
          {success && <div className="form-success" role="status">{success}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={handleClose} disabled={isSaving}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={isSaving || pending || !currentPassword || !newPassword || !confirmPassword}
          >
            {isSaving ? 'Changing...' : 'Change Password'}
          </button>
        </div>
      </div>
    </div>
  );
}
