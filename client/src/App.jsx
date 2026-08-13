import React, { useEffect, useState } from 'react';
import { Theme, Loading, InlineNotification } from '@carbon/react';
import { api } from './api';
import Login from './pages/Login';
import Console from './pages/Console';

/**
 * Decides whether to show the login page or the console.
 *
 * The server is asked whether authentication is enforced at all, rather than the
 * client assuming: locally auth is off by default, and showing a login page that
 * gates nothing would be misleading.
 */
function App() {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState(null);

  async function refreshAuth() {
    try {
      setAuth(await api.authStatus());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refreshAuth();
  }, []);

  if (error) {
    return (
      <Theme theme="g10">
        <div style={{ padding: '2rem' }}>
          <InlineNotification
            kind="error"
            title="Cannot reach Carbon Monitor"
            subtitle={error}
            hideCloseButton
          />
        </div>
      </Theme>
    );
  }

  if (!auth) {
    return (
      <Theme theme="g10">
        <Loading description="Starting Carbon Monitor" withOverlay />
      </Theme>
    );
  }

  // The login page appears only when the AUTH_REQUIRED feature flag is on. The
  // default deployment is open, so the console is what loads.
  if (auth.authRequired && !auth.authenticated) {
    return <Login onSuccess={refreshAuth} />;
  }

  // authRequired is passed through so the console can hide the sign-out control:
  // offering to end a session that was never established just raises questions.
  return <Console authRequired={auth.authRequired} onSignOut={refreshAuth} />;
}

export default App;
