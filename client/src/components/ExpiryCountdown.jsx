import React, { useEffect, useState } from 'react';

/**
 * Format a duration as H:MM:SS, or an explicit expired marker.
 */
function format(totalSeconds) {
  if (totalSeconds <= 0) return 'Expired';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Live countdown to Carbon MCP token expiry.
 *
 * Ticks locally from the last server value rather than polling every second —
 * the token's lifetime is known, so a second-by-second display costs nothing.
 * `seconds` resets the local clock whenever the server reports a new value,
 * which is what makes a refresh visibly reset the countdown.
 *
 * `renewable` distinguishes the two very different meanings of a lapsed token.
 * When something can renew it — this container's refresh token, or Carbon MCP
 * refreshing server-side from the session id — an expired cached token is
 * routine and the connection still works; the tile alongside this one is what
 * reports actual health. Painting that red would cry wolf on a healthy system,
 * so only a genuinely dead connection gets the error treatment.
 */
function ExpiryCountdown({ seconds, expiresAt, renewable = false }) {
  const [remaining, setRemaining] = useState(seconds ?? 0);

  // Re-synced on `expiresAt` as well as `seconds`, so a background refresh
  // visibly restarts the clock.
  //
  // The server renews the token when it is within MCP_REFRESH_MARGIN_SEC of
  // expiry and the console polls every 30s, so the new, much larger
  // `expiresInSeconds` does arrive — but a countdown that only watched `seconds`
  // would sit at whatever it had ticked down to if the poll happened to return
  // the same integer twice, and would give no signal that a NEW token had been
  // issued rather than the old one being re-reported. `expiresAt` is the token's
  // own expiry instant: it changes exactly when a fresh token is minted, and
  // never otherwise.
  useEffect(() => {
    setRemaining(seconds ?? 0);
  }, [seconds, expiresAt]);

  useEffect(() => {
    if (seconds === null || seconds === undefined) return undefined;
    const timer = setInterval(() => setRemaining((r) => r - 1), 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  if (seconds === null || seconds === undefined) {
    return <span className="cm-countdown">—</span>;
  }

  const expired = remaining <= 0;

  if (expired) {
    return (
      <span
        className={`cm-countdown${renewable ? '' : ' cm-countdown--expired'}`}
        aria-live="off"
      >
        {renewable ? 'Renews on next call' : 'Expired'}
      </span>
    );
  }

  return (
    <span
      className="cm-countdown"
      // Announced only when it changes state, not on every tick — a per-second
      // live region would flood a screen reader with meaningless updates.
      aria-live="off"
    >
      {format(remaining)}
    </span>
  );
}

export default ExpiryCountdown;
