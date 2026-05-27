import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { installBuildFreshnessReloader } from './utils/buildFreshness';
import './styles.css';

if (!import.meta.env.DEV) {
  installBuildFreshnessReloader();
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
);
