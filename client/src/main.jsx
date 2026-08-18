import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import HelpGuide from './pages/HelpGuide';
import ErrorBoundary from './components/ErrorBoundary';
import '@carbon/charts/styles.css';
import './styles.scss';

// The public help guide is a separate top-level page rather than a route inside
// App, so App keeps its hooks unconditional and the guide never touches auth. It
// opens in its own tab from the header's Help control; the server serves
// index.html for /help, and this picks the page from the path at load.
const Root = window.location.pathname === '/help' ? HelpGuide : App;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
