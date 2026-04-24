import { lazy, Suspense } from 'react';

const DesktopConversationViewImpl = lazy(() =>
  import('./DesktopConversationView').then((module) => ({
    default: module.DesktopConversationView
  }))
);

export function LazyDesktopConversationView(props) {
  return (
    <Suspense fallback={<div className="conversation-loading">Loading conversation...</div>}>
      <DesktopConversationViewImpl {...props} />
    </Suspense>
  );
}
