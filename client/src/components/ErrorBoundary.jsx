import React from 'react';
import { Theme, InlineNotification, Button } from '@carbon/react';

/**
 * Catches a render-time error anywhere beneath it and shows a recoverable
 * message instead of letting React unmount the whole tree to a blank page.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The console is a single-page app with one root component (Console). React's
 * default response to a component throwing during render is to unmount the
 * ENTIRE tree — so one transient error blanks the page and leaves only a line
 * in the browser console. That is exactly the failure mode a bad reference
 * produced during a hot-reload once: "An error occurred in the <Console>
 * component", and nothing rendered. A boundary confines such a failure to the
 * subtree it wraps and turns it into a legible notice with a way back, whatever
 * the cause — a malformed API payload, an unexpected null, a future edit.
 *
 * Must be a class: getDerivedStateFromError / componentDidCatch have no hook
 * equivalent — there is no useErrorBoundary in React.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    // Flip to the fallback on the next commit. The error object itself is not
    // stored in state — it is not shown to the operator (a raw message or stack
    // is noise to them), only logged below for a developer.
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Surface it where a developer looks first. Kept to the console rather than
    // shipped anywhere — this app has no client-side error sink, and the server
    // already captures its own review output separately.
    console.error('Console render error caught by ErrorBoundary:', error, info);
  }

  handleReload = () => {
    // A full reload is the honest recovery: the boundary cannot know which slice
    // of state caused the throw, and the console rebuilds all of its state from
    // the API on mount, so reloading is both safe and sufficient.
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // g10 and InlineNotification mirror App.jsx's "Cannot reach Carbon
      // Monitor" state, so a crash looks like the app's own considered error
      // screen rather than a browser default.
      return (
        <Theme theme="g10">
          <div style={{ padding: '2rem', maxWidth: '40rem' }}>
            <InlineNotification
              kind="error"
              title="Something went wrong"
              subtitle="The console hit an unexpected error and stopped rendering. Reloading should recover it."
              hideCloseButton
            />
            <Button
              kind="primary"
              onClick={this.handleReload}
              style={{ marginTop: '1rem' }}
            >
              Reload console
            </Button>
          </div>
        </Theme>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
