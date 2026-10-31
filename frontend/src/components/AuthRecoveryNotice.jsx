import './AuthRecoveryNotice.css';

export function AuthRecoveryNotice({ message, onDismiss }) {
  if (!message) return null;
  return <div className="auth-recovery-notice" role="alert">
    <p>{message}</p>
    <button type="button" onClick={onDismiss}>Dismiss</button>
  </div>;
}
