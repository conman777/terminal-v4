import { createContext, useContext } from 'react';

const ConversationLinksContext = createContext(null);

export const ConversationLinksProvider = ConversationLinksContext.Provider;
export const useConversationLinks = () => useContext(ConversationLinksContext);

export function scopeConversationLinks(links, root, isActive, paneOpenFile) {
  if (!links) return null;
  return { ...links, root, openFile: root ? paneOpenFile || (isActive && root === links.root ? links.openFile : undefined) : undefined };
}
