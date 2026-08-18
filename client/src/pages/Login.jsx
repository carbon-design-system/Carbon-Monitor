import React, { useState } from 'react';
import {
  Theme,
  Tile,
  Form,
  TextInput,
  PasswordInput,
  Button,
  InlineNotification,
  Link,
  Header,
  HeaderName,
} from '@carbon/react';
import { api } from '../api';

/**
 * Console sign-in.
 *
 * Ported from Carbon Migrate's agent-dispatcher Login page. Signs in with the
 * console's own CONSOLE_USERNAME / CONSOLE_PASSWORD. The wordmark keeps that
 * page's thin/bold split — weight 100 on "Carbon", default on the product word.
 */
function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError({
        message: err.status
          ? err.message
          : 'Unable to reach the server. Please try again.',
        // Returned by the server on an auth failure only, so the contact line
        // shows for a wrong username/password but not for an unreachable server.
        contact: err.body?.contact || null,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Theme theme="g10">
      <Header aria-label="Carbon Monitor">
        <HeaderName href="/" prefix="">
          <span style={{ fontWeight: 100 }}>Carbon</span>
          {' '}Monitor
        </HeaderName>
      </Header>

      <main className="cm-login">
        <h1 className="cm-login__hero">
          <span className="cm-login__hero-thin">Welcome to</span>{' '}
          <span className="cm-login__hero-light">Carbon</span>
          {' '}Monitor
        </h1>

        <Tile className="cm-login__tile">
          <h2 className="cm-login__title">Sign in</h2>
          <p className="cm-login__subtitle">Carbon Monitor · PR Review Agent</p>

          {error && (
            <div className="cm-login__error">
              <InlineNotification
                kind="error"
                title="Sign-in failed"
                subtitle={error.message}
                hideCloseButton
                className="cm-login__notification"
              />
              {error.contact && (
                <p className="cm-login__contact">
                  For access to Carbon Monitor, contact{' '}
                  <Link href={`mailto:${error.contact}`}>{error.contact}</Link>.
                </p>
              )}
            </div>
          )}

          <Form onSubmit={handleSubmit}>
            <TextInput
              id="cm-username"
              labelText="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              disabled={loading}
            />
            <PasswordInput
              id="cm-password"
              labelText="Password"
              hidePasswordLabel="Hide password"
              showPasswordLabel="Show password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={loading}
              style={{ marginTop: '1rem' }}
            />
            <Button type="submit" disabled={loading} className="cm-login__submit">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </Form>
        </Tile>
      </main>
    </Theme>
  );
}

export default Login;
