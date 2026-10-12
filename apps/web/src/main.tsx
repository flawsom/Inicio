import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * The offline shell.
 *
 * Registered in production builds only: in the Vite dev server a worker would
 * sit between the browser and hot module replacement, caching the very files
 * that are supposed to change on every save. The worker caches the app shell and
 * never touches `/api`, so it cannot serve stale survey data (see public/sw.js).
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* an installable app is a bonus; the survey works without it */
    });
  });
}
