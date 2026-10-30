import { createContext, useContext } from 'react';

const ConversationLinksContext = createContext(null);

export const ConversationLinksProvider = ConversationLinksContext.Provider;
export const useConversationLinks = () => useContext(ConversationLinksContext);
