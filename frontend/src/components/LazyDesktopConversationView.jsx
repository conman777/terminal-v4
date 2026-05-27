import { lazy, memo, Suspense } from 'react';

const DesktopConversationViewImpl = lazy(() =>
  import('./DesktopConversationView').then((module) => ({
    default: module.DesktopConversationView
  }))
);

export const LazyDesktopConversationView = memo(function LazyDesktopConversationView(props) {
  return (
    <Suspense fallback={<div className="conversation-loading">Loading conversation...</div>}>
      <DesktopConversationViewImpl {...props} />
    </Suspense>
  );
});
