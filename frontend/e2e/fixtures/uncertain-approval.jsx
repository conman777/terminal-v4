import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopConversationView } from '../../src/components/DesktopConversationView';
import { useStructuredSession } from '../../src/hooks/useStructuredSession';
import { getUser } from '../../src/utils/auth';
import { setEnvironmentIdentity } from '../../src/utils/remoteEnvironments';

setEnvironmentIdentity(getUser()?.id, window.location.origin);
const sessionId = new URLSearchParams(window.location.search).get('session') || 'ss-approval-fixture';
function Fixture() {
  const session = useStructuredSession({ sessionId, active: true, runtime: 'codex' });
  return <DesktopConversationView turns={[]} mode="structured" aiType="codex" sessionId={sessionId}
    structuredMessages={session.messages} structuredToolCalls={session.currentToolCalls} pendingApproval={session.pendingApproval}
    isStreaming={session.isStreaming} isApproving={session.isApproving} isInterrupting={session.isInterrupting}
    requiresCleanup={session.requiresCleanup} actionError={session.actionError}
    onApprove={session.approve} onReviewApproval={session.reviewApproval} onInterrupt={session.interrupt} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
