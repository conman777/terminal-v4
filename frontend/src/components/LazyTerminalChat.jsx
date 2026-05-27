import { lazy, memo, Suspense } from 'react';

const TerminalChatImpl = lazy(() =>
  import('./TerminalChat').then((module) => ({ default: module.TerminalChat }))
);

export const LazyTerminalChat = memo(function LazyTerminalChat(props) {
  return (
    <Suspense fallback={<div className="terminal-loading">Loading terminal...</div>}>
      <TerminalChatImpl {...props} />
    </Suspense>
  );
});
