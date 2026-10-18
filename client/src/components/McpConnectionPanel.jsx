import React, { useEffect, useState } from 'react';
import {
  Tile,
  Button,
  Form,
  TextInput,
  PasswordInput,
  InlineNotification,
  Accordion,
  AccordionItem,
} from '@carbon/react';
import { api } from '../api';
import ExpiryCountdown from './ExpiryCountdown';

/**
 * Carbon MCP connection controls.
 *
 * Two ways to establish the connection, ordered by how well they hold up
 * unattended:
 *
 *   1. Sign in with IBMid (primary) — completes an OAuth authorization-code
 *      flow, after which the container renews its own token indefinitely.
 *   2. Paste credentials (fallback, behind an accordion) — for when the OAuth
 *      flow cannot be used. A pasted session id still allows Carbon MCP to
 *      refresh server-side; a bare bearer token expires in about two hours.
 *
 * The manual path is deliberately collapsed: it is the one that leads to the
 * connection dying every couple of hours, so it should not read as the default.
 */
/**
 * @param {boolean} [inPanel] - Rendered inside a SidePanel, which supplies the
 *   surface and the title. Drops this component's own Tile chrome and heading,
 *   which would otherwise be a box inside a box under a duplicated title.
 */
function McpConnectionPanel({ status, onChanged, inPanel = false, resetKey }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [token, setToken] = useState('');
  const [sessionId, setSessionId] = useState('');
  // Signing out is cheap to do and expensive to undo — restoring the connection
  // needs a browser round trip through IBMid — so the control asks twice.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Clear the action confirmation when the parent Settings modal closes.
  // The modal stays mounted (only hidden) between opens, so this component
  // never unmounts on its own — without this, a stale confirmation (e.g.
  // "Token refreshed") would reappear on reopen with no new action taken.
  useEffect(() => {
    setMessage(null);
  }, [resetKey]);

  function report(kind, title, subtitle) {
    setMessage({ kind, title, subtitle });
  }

  async function withBusy(name, fn) {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      report('error', 'Action failed', err.message);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  /**
   * Start the OAuth bootstrap.
   *
   * The authorization page opens in a new tab so the console keeps its state and
   * can poll for the result; the callback tab closes itself on success.
   */
  const connect = () =>
    withBusy('connect', async () => {
      const { authorizationUrl } = await api.mcpConnect();
      window.open(authorizationUrl, '_blank', 'noopener');
      report(
        'info',
        'Sign-in opened in a new tab',
        'Complete IBMid authentication there, then return here and refresh the status.'
      );
    });

  const testConnection = () =>
    withBusy('test', async () => {
      const result = await api.mcpTest();
      if (result.authorized) {
        report(
          'success',
          'Connection healthy',
          'Carbon MCP accepted the credentials.'
        );
      } else if (result.reachable) {
        report(
          'error',
          'Credentials rejected',
          result.reason || `Carbon MCP returned HTTP ${result.status}.`
        );
      } else {
        report('error', 'Carbon MCP unreachable', result.reason);
      }
    });

  const forceRefresh = () =>
    withBusy('refresh', async () => {
      const result = await api.mcpRefresh();
      report(
        'success',
        'Token refreshed',
        `A new token was issued${result.rotated ? ' and the refresh token rotated' : ''}.`
      );
    });

  /**
   * Drop the stored grant and strip the agent's MCP headers.
   *
   * The next review then genuinely runs without a credential, which is the
   * point: it is how an operator hands the container back before it is torn
   * down, or clears a grant issued to the wrong IBMid.
   */
  const signOutOfMcp = () =>
    withBusy('disconnect', async () => {
      await api.mcpDisconnect();
      setConfirmingSignOut(false);
      report(
        'success',
        'Signed out of Carbon MCP',
        'The stored token and refresh grant were cleared. Sign in with IBMid to reconnect.'
      );
    });

  async function submitManual(e) {
    e.preventDefault();
    await withBusy('manual', async () => {
      await api.mcpRefresh({
        token: token.trim() || undefined,
        sessionId: sessionId.trim() || undefined,
      });
      setToken('');
      setSessionId('');
      report(
        'success',
        'Credentials saved',
        'The agent’s MCP configuration was updated.'
      );
    });
  }

  const connected = status?.hasToken || status?.hasSession;

  // SidePanel already provides a surface and a title; a Tile and heading inside
  // it would be a box within a box beneath a repeated name.
  const Shell = inPanel ? 'div' : Tile;

  return (
    <Shell className={inPanel ? 'cm-settings-panel-body' : undefined}>
      {!inPanel && (
        <h2 className="cm-section-heading">Carbon MCP connection</h2>
      )}

      {message && (
        <InlineNotification
          kind={message.kind}
          title={message.title}
          subtitle={message.subtitle}
          onCloseButtonClick={() => setMessage(null)}
          className="cm-login__notification"
        />
      )}

      {status?.needsReauth && (
        <InlineNotification
          kind="error"
          title="Re-authentication required"
          subtitle="The stored grant was rejected. Sign in with IBMid again to restore unattended refresh."
          hideCloseButton
          className="cm-login__notification"
        />
      )}

      <dl className="cm-definition-list">
        <dt>Status</dt>
        <dd>{connected ? 'Connected' : 'Not connected'}</dd>

        <dt>Renewal</dt>
        <dd>
          {status?.canAutoRefresh
            ? 'Automatic — this container refreshes its own token'
            : status?.hasSession
              ? 'Server-side — Carbon MCP refreshes from the session id'
              : 'None — the token will expire and stay expired'}
        </dd>

        <dt>Cached token</dt>
        <dd>
          <ExpiryCountdown
            seconds={status?.expiresInSeconds}
            expiresAt={status?.expiresAt}
            renewable={status?.canAutoRefresh || status?.hasSession}
          />
        </dd>

        {status?.authenticated && (
          <>
            <dt>Agent</dt>
            <dd>AI agent ready for queries.</dd>
          </>
        )}

        {status?.lastRefreshAt && (
          <>
            <dt>Last refresh</dt>
            <dd>{new Date(status.lastRefreshAt).toLocaleString()}</dd>
          </>
        )}

        <dt>Server</dt>
        <dd>{status?.url}</dd>
      </dl>

      <div className="cm-button-row">
        <Button
          onClick={connect}
          disabled={busy !== null}
          className="cm-mcp-primary-action"
        >
          {busy === 'connect' ? 'Opening…' : 'Sign in with IBMid'}
        </Button>
        <Button
          kind="secondary"
          onClick={testConnection}
          disabled={busy !== null}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          kind="tertiary"
          onClick={forceRefresh}
          disabled={busy !== null || !status?.canAutoRefresh}
        >
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh now'}
        </Button>

        {/* Nothing to sign out of when there is no credential stored. */}
        {connected && !confirmingSignOut && (
          <Button
            kind="danger--ghost"
            onClick={() => setConfirmingSignOut(true)}
            disabled={busy !== null}
          >
            Sign out
          </Button>
        )}

        {connected && confirmingSignOut && (
          <>
            <Button
              kind="danger--ghost"
              onClick={signOutOfMcp}
              disabled={busy !== null}
            >
              {busy === 'disconnect' ? 'Signing out…' : 'Confirm sign out'}
            </Button>
            <Button
              kind="ghost"
              onClick={() => setConfirmingSignOut(false)}
              disabled={busy !== null}
            >
              Keep connection
            </Button>
          </>
        )}
      </div>

      {/*
        Spelled out rather than left to the button's colour (WCAG 1.4.1).
        Always mounted once connected so the live region already exists in the
        DOM when confirmingSignOut flips — a live region that mounts with
        content does not announce; one whose content changes inside an existing
        region does. Scoped to `connected` so no empty element sits in the DOM
        (and no ghost margin from cm-confirm-hint) when disconnected.
      */}
      {connected && (
        <p
          className="cm-status-tile__hint cm-confirm-hint"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {confirmingSignOut
            ? 'Signing out clears the stored token and refresh grant. Reconnecting needs another IBMid sign-in in the browser.'
            : ''}
        </p>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <Accordion>
          <AccordionItem title="Enter credentials manually">
            <p
              className="cm-status-tile__hint"
              style={{ marginBottom: '1rem' }}
            >
              Use this only when IBMid sign-in is unavailable. The session id is
              the durable value — Carbon MCP can mint a fresh token from it even
              after the bearer token has expired.
            </p>
            <Form onSubmit={submitManual}>
              <div className="cm-field-stack">
                <PasswordInput
                  id="cm-mcp-token"
                  labelText="Bearer token"
                  helperText="The Authorization header value, without the “Bearer ” prefix"
                  hidePasswordLabel="Hide token"
                  showPasswordLabel="Show token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  disabled={busy !== null}
                />
                <TextInput
                  id="cm-mcp-session"
                  labelText="Session id"
                  helperText="The X-MCP-Session header value"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  autoComplete="off"
                  disabled={busy !== null}
                />
              </div>
              <Button
                type="submit"
                kind="secondary"
                disabled={busy !== null || (!token.trim() && !sessionId.trim())}
                style={{ marginTop: '1.5rem' }}
              >
                {busy === 'manual' ? 'Saving…' : 'Save credentials'}
              </Button>
            </Form>
          </AccordionItem>
        </Accordion>
      </div>
    </Shell>
  );
}

export default McpConnectionPanel;
