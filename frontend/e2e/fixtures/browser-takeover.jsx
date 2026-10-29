import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceBrowser from '../../src/components/WorkspaceBrowser';

createRoot(document.getElementById('root')).render(<WorkspaceBrowser onClose={() => {}} />);
