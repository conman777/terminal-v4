import { lazy, Suspense } from 'react';

const TerminalChatImpl = lazy(() =>
  import('./TerminalChat').then((module) => ({ default: module.TerminalChat }))
);

export function LazyTerminalChat(props) {
  return (
    <Suspense fallback={<div className="terminal-loading">Loading terminal...</div>}>
      <TerminalChatImpl {...props} />
    </Suspense>
  );
}
