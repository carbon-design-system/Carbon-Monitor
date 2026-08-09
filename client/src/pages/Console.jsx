import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Theme,
  Header,
  HeaderName,
  HeaderGlobalBar,
  HeaderGlobalAction,
  Modal,
  SkipToContent,
  Content,
  Grid,
  Column,
  Button,
  Tile,
  TextInput,
  InlineNotification,
  Loading,
} from '@carbon/react';
// The one icon this project imports. Every other affordance is text-labelled,
// because the Carbon icon index has repeatedly returned unusable results and
// guessing an export name is not acceptable — so this one was checked twice:
// against the icon index (which resolved "settings" -> Settings) and against the
// exports of the installed @carbon/icons-react.
import { Settings } from '@carbon/icons-react';
import { api } from '../api';
import StatusTile from '../components/StatusTile';
import McpConnectionPanel from '../components/McpConnectionPanel';
import BobcoinsPanel, { BobcoinsLedger } from '../components/BobcoinsPanel';
import ReviewLog from '../components/ReviewLog';
import AboutAi from '../components/AboutAi';

/** How often the status panel re-polls, in milliseconds. */
const POLL_INTERVAL_MS = 30_000;

/** Reviews listed in the Bobcoins ledger. Enough to see the trend, not a log. */
const CREDIT_HISTORY_LIMIT = 10;

/**
 * "1 pull request" / "3 pull requests".
 *
 * Worth the helper because GITHUB_AI_AGENT_MAX_PRS is genuinely set to 1 in some
 * deployments, where a hardcoded plural reads as a bug in the limit itself.
 */
function pluralPRs(count) {
  return `${count} pull request${count === 1 ? '' : 's'}`;
}

/**
 * Parse the comma-separated PR field, mirroring the server's rules exactly.
 *
 * Returns `{ prNumbers, error }`. A blank field is valid and means auto mode —
 * the server picks the PRs. `maxPRs` may be null before GET /api/config has
 * answered, in which case the count is left to the server rather than checked
 * against a guessed limit.
 *
 * This is a convenience so the operator learns about a typo immediately instead
 * of after a round trip; POST /api/review/trigger re-validates regardless and
 * its 400 message is the authority.
 */
function parsePrNumbers(raw, maxPRs) {
  const trimmed = raw.trim();
  if (!trimmed) return { prNumbers: [], error: null };

  const prNumbers = [];

  for (const entry of trimmed.split(',').map((part) => part.trim())) {
    // An empty entry means a doubled or trailing comma. Everything else that
    // is not a run of digits — decimals, negatives, "abc" — is a typo, and 0
    // is not a pull request number.
    if (!entry) {
      return {
        prNumbers: [],
        error: 'Separate pull request numbers with a single comma.',
      };
    }
    if (!/^\d+$/.test(entry) || Number(entry) < 1) {
      return {
        prNumbers: [],
        error: `“${entry}” is not a pull request number. Use positive whole numbers separated by commas.`,
      };
    }

    // Duplicates are dropped rather than rejected, keeping first-seen order —
    // the same thing the server does, so the count check below agrees with it.
    const value = Number(entry);
    if (!prNumbers.includes(value)) prNumbers.push(value);
  }

  if (maxPRs != null && prNumbers.length > maxPRs) {
    return {
      prNumbers: [],
      error: `Up to ${pluralPRs(maxPRs)} per run; ${prNumbers.length} given.`,
    };
  }

  return { prNumbers, error: null };
}

/**
 * Operator console.
 *
 * Each logical group gets its own Grid so the sections do not wrap into one
 * another, and the rows are ordered by what an operator came to do:
 *
 *   A  heading
 *   B  system health — four dependencies, one row of four
 *   C  Reviews (lg 10) beside the Bobcoins balance (lg 6)
 *   D  review output, full width
 *   E  Carbon MCP connection beside the spend ledger (lg 8 each)
 *
 * Reviews takes the wider half of row C because starting one is the reason the
 * page exists; the connection panel and the ledger are reference material and
 * sit last. The Bobcoins dependency check is deliberately absent from row B — it
 * has a whole tile of its own in row C, and showing it twice is what pushed a
 * fifth tile onto a four-column row where it sat alone, reading as a fault
 * rather than a wrap. BobcoinsPanel reports that check instead.
 */
function Console({ authRequired = false, onSignOut }) {
  const [status, setStatus] = useState(null);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [version, setVersion] = useState(null);
  const [review, setReview] = useState(null);
  const [credits, setCredits] = useState(null);
  const [creditHistory, setCreditHistory] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [prInput, setPrInput] = useState('');
  const [triggering, setTriggering] = useState(false);
  // Whether ReviewLog is rendering anything. It reports this rather than the
  // page inferring it, because the component has to stay mounted to poll.
  const [logVisible, setLogVisible] = useState(false);
  // Kept separate from `error` so a failed trigger reports next to the control
  // that caused it rather than in the page-level banner three tiles away.
  const [triggerError, setTriggerError] = useState(null);
  // Connection settings live in an off-canvas panel; closed by default because
  // they are configured once and then left alone.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus returns here when the panel closes, so a keyboard user lands back on
  // the control they opened it from rather than at the top of the document.
  const settingsButtonRef = useRef(null);


  const load = useCallback(async () => {
    try {
      // Fetched together so a slow dependency check does not stagger the panel.
      const [statusResult, mcpResult, reviewResult, creditsResult, historyResult] =
        await Promise.all([
          api.status(),
          api.mcpStatus(),
          api.reviewStatus(),
          // Bobcoin accounting is supplementary: it reaches an external gateway
          // and only exists on newer builds, so a failure here must degrade the
          // one panel rather than blank the whole console. BobcoinsPanel
          // explains the null.
          api.credits().catch(() => null),
          api.creditsHistory(CREDIT_HISTORY_LIMIT).catch(() => null),
        ]);
      setStatus(statusResult);
      setMcpStatus(mcpResult);
      setReview(reviewResult);
      setCredits(creditsResult);
      setCreditHistory(historyResult);
      setError(null);
    } catch (err) {
      // An expired session must return the operator to the login page rather
      // than leaving them looking at a stale panel that silently stopped updating.
      if (err.status === 401) return onSignOut();
      setError(err.message);
    } finally {
      setLoading(false);
    }
    return undefined;
  }, [onSignOut]);

  useEffect(() => {
    load();
    api.config().then(setConfig).catch(() => {});
    // The build version lives on GET /api/health, not GET /api/config — config
    // describes the review target, health describes the running process. Fetched
    // once: the version cannot change without the process restarting. A failure
    // leaves it null and the header shows the product name alone, which is
    // better than "(vundefined)".
    api.health().then((h) => setVersion(h?.version ?? null)).catch(() => {});
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const cfg = config?.config;

  // Null until GET /api/config answers. The server owns these limits, so they
  // are never assumed — the field's helper text and the count check both stay
  // quiet about a number the console has not actually been told.
  const maxPRs = cfg?.maxPRs ?? null;
  const daysBack = cfg?.daysBack ?? null;

  const { prNumbers, error: prError } = parsePrNumbers(prInput, maxPRs);
  const reviewRunning = Boolean(review?.running) || triggering;

  // Bobcoins is pulled out of the health row and handed to the tile that already
  // shows the balance, so the dependency is still reported exactly once.
  const healthChecks = status?.checks?.filter((check) => check.id !== 'bobcoins') || [];
  const bobcoinsCheck = status?.checks?.find((check) => check.id === 'bobcoins') || null;

  // Says nothing about a limit the console has not been told, and stays honest
  // when that limit is 1 — where "up to 1, comma separated" would be nonsense.
  let prHelperText =
    'Comma separated. Leave blank to review the most recent open pull requests.';
  if (maxPRs && daysBack) {
    prHelperText =
      maxPRs === 1
        ? `One per run. Leave blank to review the most recent open pull request from the last ${daysBack} days.`
        : `Up to ${maxPRs}, comma separated. Leave blank to review the most recent ${maxPRs} open pull requests from the last ${daysBack} days.`;
  }

  // Names what the click will actually do. Falls back to a limit-free label
  // until GET /api/config answers, rather than asserting a number the console
  // has not been told.
  const autoButtonLabel =
    maxPRs && daysBack
      ? maxPRs === 1
        ? 'Review latest PR'
        : `Review latest ${maxPRs} PRs`
      : 'Review latest PRs';

  async function signOut() {
    try {
      await api.logout();
    } finally {
      onSignOut();
    }
  }

  /**
   * Review the most recent PRs, ignoring whatever is in the field.
   *
   * The one-click path: no input, no clearing, no chance that a stray character
   * left in the box turns "review the latest" into something else.
   */
  async function triggerAutoReview() {
    setTriggering(true);
    setTriggerError(null);
    try {
      await api.triggerReview();
      await load();
    } catch (err) {
      if (err.status === 401) return onSignOut();
      setTriggerError(err.message);
    } finally {
      setTriggering(false);
    }
    return undefined;
  }

  async function triggerReview() {
    if (prError) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      // An empty list means auto mode; api.triggerReview omits the body entirely
      // in that case, which is the request this console has always sent.
      await api.triggerReview(prNumbers);
      setPrInput('');
      await load();
    } catch (err) {
      if (err.status === 401) return onSignOut();
      // The server re-validates and its message names the offending value, so
      // it is shown verbatim even when the checks above passed.
      setTriggerError(err.message);
    } finally {
      setTriggering(false);
    }
    return undefined;
  }

  if (loading) {
    return (
      <Theme theme="g10">
        <Loading description="Loading Carbon Monitor" withOverlay />
      </Theme>
    );
  }

  return (
    <Theme theme="g10">
      <Header aria-label="Carbon Monitor">
        <SkipToContent />
        <HeaderName href="/" prefix="">
          <span className="cm-brand-thin">Carbon</span> Monitor
          {/*
            Rendered only once GET /api/health has answered. Until then the
            product name stands alone rather than carrying "(vundefined)" — and
            the version is styled as the metadata it is, so it is not read as
            part of the name.
          */}
          {version && <span className="cm-brand-version"> (v{version})</span>}
        </HeaderName>
        <HeaderGlobalBar>
          {/*
            Connection settings live behind this rather than in a tile on the
            page. They are configured once — an IBMid sign-in at deploy time —
            and then never touched again, so a permanent full-width tile spent
            page real estate on something read about twice a year, and pushed the
            things an operator actually watches below the fold.
          */}
          <HeaderGlobalAction
            ref={settingsButtonRef}
            aria-label={settingsOpen ? 'Close connection settings' : 'Open connection settings'}
            aria-expanded={settingsOpen}
            isActive={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
            tooltipAlignment="end"
          >
            <Settings size={20} />
          </HeaderGlobalAction>

          {/*
            Rendered only when the AUTH_REQUIRED feature flag is on. With sign-in
            disabled — the default — there is no session to end, so the control
            would do nothing but imply the console is protected when it is not.

            A real text button, not a HeaderGlobalAction. That component is
            Carbon's ICON-only global action and is sized as a hard 3rem square
            (`.cds--header__action { inline-size: 3rem; block-size: 3rem }`), so
            a "Sign out" label — about 4.4rem of text — is compressed to
            min-content inside it and renders broken. @carbon/icons-react is off
            limits in this project, so the affordance stays textual and uses the
            component built for text instead.
          */}
          {authRequired && (
            <Button kind="ghost" size="lg" onClick={signOut} className="cm-sign-out">
              Sign out
            </Button>
          )}
        </HeaderGlobalBar>
      </Header>

      <Content id="main-content" className="cm-content">
        {/* A. Page heading — `narrow` matches every group below it, so the h1
            and the tiles share one left edge instead of stair-stepping by 16px. */}
        <Grid narrow withRowGap>
          <Column sm={4} md={8} lg={16}>
            <h1 className="cm-page-heading">Operations</h1>
            <p className="cm-page-caption">
              {cfg
                ? `Reviewing pull requests in ${cfg.owner}/${cfg.repo} with the ${cfg.agent} agent.`
                : 'Connection and review status for the Carbon PR review agent.'}
            </p>
            {error && (
              <InlineNotification
                kind="error"
                title="Could not load status"
                subtitle={error}
                onCloseButtonClick={() => setError(null)}
              />
            )}
          </Column>
        </Grid>

        {/* B. System health — four dependencies at lg 4 apiece, which is exactly
            16 columns and so exactly one row. Bobcoins is not among them; it is
            reported by the tile that shows its balance, in row C. */}
        <Grid narrow withRowGap className="cm-tile-grid">
          {healthChecks.map((check) => (
            <Column key={check.id} sm={4} md={4} lg={4}>
              <StatusTile
                label={check.label}
                status={check.status}
                detail={check.detail}
                hint={check.hint}
              />
            </Column>
          ))}
        </Grid>

        {/* C. The work: starting a review, and the budget that decides whether
            one can run. Reviews takes the wider column. */}
        <Grid narrow withRowGap className="cm-tile-grid">
          <Column sm={4} md={8} lg={10}>
            <Tile>
              {/* Heading left, mark right, on one row — the mark is optically
                  aligned to the heading's line box rather than floated into the
                  corner. h2, not h3: the page's only h1 is "Operations" above,
                  and skipping a level breaks heading navigation (WCAG 1.3.1). */}
              <div className="cm-tile-head">
                <h2 className="cm-section-heading cm-tile-head__title">Reviews</h2>
                {/*
                  The AI disclosure sits with the thing it describes. In the
                  header it labelled the whole console; here it labels the panel
                  that actually produces AI output, which is what Carbon's AI
                  guidance asks for — the marker belongs to the AI-generated
                  content, not to the application chrome.
                */}
                <AboutAi />
              </div>

              <dl className="cm-definition-list">
                <dt>State</dt>
                <dd>{review?.running ? 'Running' : 'Idle'}</dd>

                {review?.startedAt && (
                  <>
                    <dt>Started</dt>
                    <dd>{new Date(review.startedAt).toLocaleString()}</dd>
                  </>
                )}

                {review?.finishedAt && (
                  <>
                    <dt>Finished</dt>
                    <dd>{new Date(review.finishedAt).toLocaleString()}</dd>
                  </>
                )}

                {cfg && (
                  <>
                    <dt>Target</dt>
                    {/*
                      The age cutoff is stated here, not only in the input's
                      helper text. "Up to 5 open PRs" reads as "the 5 newest open
                      PRs" — but a PR older than GITHUB_AI_AGENT_DAYS_BACK is
                      never selected at all, so a repository whose recent PRs are
                      all stale can return nothing and look broken. Naming the
                      window makes an empty run self-explanatory.

                      Only meaningful for auto-selection: an explicit PR number
                      bypasses the age filter entirely, so showing the window
                      there would describe a rule that is not being applied.
                    */}
                    <dd>
                      {cfg.targetPR
                        ? `PR #${cfg.targetPR}`
                        : `Up to ${pluralPRs(cfg.maxPRs)} opened in the last ${cfg.daysBack} days`}
                    </dd>
                  </>
                )}

                {/* What the current — or most recent — run is actually working
                    on, which is not always the configured default now that a
                    run can name its own PRs. */}
                {review?.mode && (
                  <>
                    <dt>{review.running ? 'Reviewing' : 'Last run'}</dt>
                    <dd>
                      {review.mode === 'explicit' && review.prNumbers?.length
                        ? review.prNumbers.map((number) => `#${number}`).join(', ')
                        : 'Auto-selected'}
                    </dd>
                  </>
                )}
              </dl>

              {review?.error && (
                <InlineNotification
                  kind="error"
                  title="Last run failed"
                  subtitle={review.error}
                  hideCloseButton
                  className="cm-tile-notification"
                />
              )}

              {triggerError && (
                <InlineNotification
                  kind="error"
                  title="Could not start the review"
                  subtitle={triggerError}
                  onCloseButtonClick={() => setTriggerError(null)}
                  className="cm-tile-notification"
                />
              )}

              <div className="cm-review-field">
                <TextInput
                  id="cm-review-prs"
                  labelText="Pull request numbers"
                  placeholder="e.g. 22971, 22972"
                  helperText={prHelperText}
                  invalid={Boolean(prError)}
                  invalidText={prError || ''}
                  value={prInput}
                  onChange={(e) => setPrInput(e.target.value)}
                  disabled={reviewRunning}
                  autoComplete="off"
                  inputMode="numeric"
                />
              </div>

              <div className="cm-button-row">
                {/*
                  Two distinct actions rather than one whose meaning depends on
                  whether a field happens to be empty. The primary is the routine
                  case — review the latest PRs — and it deliberately ignores the
                  field, so an abandoned half-typed number cannot silently change
                  what a click does, and reaching it never requires clearing the
                  input first.
                */}
                <Button onClick={triggerAutoReview} disabled={reviewRunning}>
                  {reviewRunning ? 'Review running…' : autoButtonLabel}
                </Button>

                <Button
                  kind="secondary"
                  onClick={triggerReview}
                  disabled={reviewRunning || Boolean(prError) || prNumbers.length === 0}
                >
                  {prNumbers.length > 0
                    ? `Review ${prNumbers.map((n) => `#${n}`).join(', ')}`
                    : 'Review listed PRs'}
                </Button>
              </div>
            </Tile>
          </Column>

          <Column sm={4} md={8} lg={6}>
            <BobcoinsPanel credits={credits} check={bobcoinsCheck} />
          </Column>
        </Grid>

        {/* D. Live output — the answer to "is it actually doing anything?"
            Full width, because stack frames and absolute paths are the whole
            reason to read a log, and a half-width column wraps every one.

            The Grid is always mounted so ReviewLog can keep polling; it renders
            nothing until there is output or a run is active, and the row's
            bottom margin is withheld until then so an empty row cannot open a
            gap between the panels either side of it. */}
        <Grid narrow withRowGap className={logVisible ? 'cm-tile-grid' : undefined}>
          <Column sm={4} md={8} lg={16}>
            <ReviewLog
              running={Boolean(review?.running)}
              startedAt={review?.startedAt}
              onVisibilityChange={setLogVisible}
            />
          </Column>
        </Grid>

        {/* E. What previous runs cost. The connection panel used to sit beside
            this and pushed it below the fold; it now lives behind the header's
            settings control, so the ledger takes the full width and its columns
            have room to breathe. */}
        <Grid narrow withRowGap className="cm-tile-grid">
          <Column sm={4} md={8} lg={16}>
            <BobcoinsLedger credits={credits} history={creditHistory} />
          </Column>
        </Grid>
      </Content>

      {/*
        Connection settings in a Modal rather than a drawer.

        Two drawer components were tried and rejected on evidence. Carbon's
        HeaderPanel is a switcher container: it has no dismiss of its own, and
        widening it past its 16rem default means overriding the very inline-size
        rule that COLLAPSES it — which shipped a 34rem, pointer-events:auto,
        z-index:8000 slab permanently across a third of the page, swallowing
        every click beneath it. Scoping the override to the expanded class fixed
        the collapse but left the panel laying out at 2px wide with its content
        overflowing. IBM Products' SidePanel is the right component in principle
        — overlay, focus trap, focus return — but its exit animation never
        completed here, so it opened and could not be closed at all.

        A Modal is the honest fit for the content: connection settings are read
        and changed roughly never, a focused overlay suits a once-a-deployment
        task better than a persistent drawer, and Modal is already proven in this
        app by the AI-label explainer. passiveModal because the panel's own
        buttons are the actions — a modal footer would duplicate them.
      */}
      <Modal
        open={settingsOpen}
        onRequestClose={() => setSettingsOpen(false)}
        modalHeading="Carbon MCP connection"
        modalLabel="Settings"
        aria-label="Carbon MCP connection settings"
        passiveModal
        launcherButtonRef={settingsButtonRef}
      >
        <McpConnectionPanel status={mcpStatus} onChanged={load} inPanel />
      </Modal>
    </Theme>
  );
}

export default Console;
