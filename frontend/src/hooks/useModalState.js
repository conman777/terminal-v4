import { useState } from 'react';

export function useModalState() {
  const [showSettings, setShowSettings] = useState(false);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [showBrowserSettings, setShowBrowserSettings] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showProcessManager, setShowProcessManager] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [showSystemResources, setShowSystemResources] = useState(false);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);

  return {
    showSettings, setShowSettings,
    showApiSettings, setShowApiSettings,
    showBrowserSettings, setShowBrowserSettings,
    showBookmarks, setShowBookmarks,
    showNotes, setShowNotes,
    showProcessManager, setShowProcessManager,
    showFileManager, setShowFileManager,
    showSystemResources, setShowSystemResources,
    showNewSessionModal, setShowNewSessionModal,
  };
}
