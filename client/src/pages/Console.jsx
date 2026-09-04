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
  ToastNotification,
  Tabs,
  Tab,
  TabList,
  TabPanels,
  TabPanel,
} from '@carbon/react';
// Icons are imported sparingly and only after the export name is verified against
// the installed @carbon/icons-react. Settings opens the connection panel; Terminal
// marks the live review-output indicator; Help opens the usage guide.
import { Settings, Terminal, Help } from '@carbon/icons-react';
import { api } from '../api';
import StatusTile from '../components/StatusTile';
import McpConnectionPanel from '../components/McpConnectionPanel';
import BobcoinsPanel, { BobcoinsLedger } from '../components/BobcoinsPanel';
import ReviewLog from '../components/ReviewLog';
import SchedulePanel, { toLocalTz, detectBrowserTimezone } from '../components/SchedulePanel';
import { pluralPRs, targetWindowText, reviewButtonLabel } from '../utils/prPhrasing';

/** How often the status panel re-polls, in milliseconds. */
const POLL_INTERVAL_MS = 30_000;

/**
 * How often to poll JUST the review status while a run is in flight. Matched to
 * the log tail's cadence (ReviewLog's TAIL_INTERVAL_MS) so `running` flips the
 * instant a run ends — the completion modal and the idle status bubble track
 * completion within a couple seconds instead of lagging up to POLL_INTERVAL_MS
 * behind the log's "complete" line.
 */
const REVIEW_POLL_INTERVAL_MS = 2_000;

/** Reviews listed in the Bobcoins ledger. Enough to see the trend, not a log. */
const CREDIT_HISTORY_LIMIT = 10;

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
  if (!trimmed) return { prNumbers: [], error: null, duplicatesDropped: 0 };

  const prNumbers = [];
  let duplicatesDropped = 0;

  for (const entry of trimmed.split(',').map((part) => part.trim())) {
    // An empty entry means a doubled or trailing comma. Everything else that
    // is not a run of digits — decimals, negatives, "abc" — is a typo, and 0
    // is not a pull request number.
    if (!entry) {
      return {
        prNumbers: [],
        error: 'Separate pull request numbers with a single comma.',
        duplicatesDropped: 0,
      };
    }
    if (!/^\d+$/.test(entry) || Number(entry) < 1) {
      return {
        prNumbers: [],
        error: `“${entry}” is not a pull request number. Use positive whole numbers separated by commas.`,
        duplicatesDropped: 0,
      };
    }

    // Duplicates are dropped rather than rejected, keeping first-seen order —
    // the same thing the server does, so the count check below agrees with it.
    // Counted so the field can flag it instead of collapsing quietly.
    const value = Number(entry);
    if (!prNumbers.includes(value)) prNumbers.push(value);
    else duplicatesDropped++;
  }

  if (maxPRs != null && prNumbers.length > maxPRs) {
    return {
      prNumbers: [],
      error: `Up to ${pluralPRs(maxPRs)} per run; ${prNumbers.length} given.`,
      duplicatesDropped: 0,
    };
  }

  return { prNumbers, error: null, duplicatesDropped };
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
  const [scheduleConfig, setScheduleConfig] = useState(null);
  // IANA timezone for displaying schedule times — initialised from the browser's
  // detected zone and updated when the operator changes it in the Schedule panel.
  const [timezone, setTimezone] = useState(detectBrowserTimezone);
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
  // Set from the 409 body when a trigger is refused because a run is already in
  // flight — its own session's or, on this shared single-instance deployment,
  // another operator's. Drives the "already running" modal so a second person
  // gets an unmissable popup naming what is running rather than a terse inline
  // line they might overlook. Holds { startedAt, mode, prNumbers } or null.
  const [busyRun, setBusyRun] = useState(null);
  // Connection settings live in an off-canvas panel; closed by default because
  // they are configured once and then left alone.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which tab is active inside the Settings modal. 0 = Carbon MCP, 1 = Scheduled reviews.
  const [settingsTab, setSettingsTab] = useState(0);
  // Bumped every time the Settings modal closes. Passed to both settings panels
  // as a resetKey so their one-time save/action confirmations do not linger
  // and reappear when the modal is reopened — the modal stays mounted (only
  // hidden) between opens, so neither panel unmounts on its own.
  const [settingsResetKey, setSettingsResetKey] = useState(0);
  // Focus returns here when the panel closes, so a keyboard user lands back on
  // the control they opened it from rather than at the top of the document.
  const settingsButtonRef = useRef(null);

  // Set once when a run transitions from running → finished. A success drives the
  // passive completion Modal (which handles its own Escape / close / click-away);
  // an error drives the toast below.
  const [completion, setCompletion] = useState(null);
  const prevRunningRef = useRef(false);

  const load = useCallback(async () => {
    try {
      // Fetched together so a slow dependency check does not stagger the panel.
      const [statusResult, mcpResult, reviewResult, creditsResult, historyResult, scheduleResult] =
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
          // Schedule config is supplementary: a failure here must degrade only
          // the schedule panel, not the whole console.
          api.schedule().catch(() => null),
        ]);
      setStatus(statusResult);
      setMcpStatus(mcpResult);
      setReview(reviewResult);
      setCredits(creditsResult);
      setCreditHistory(historyResult);
      setScheduleConfig(scheduleResult);
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

  // While a run is in flight, poll just the review status on the fast log-tail
  // cadence so `review.running` flips the moment the run finishes. Without this
  // the flag only refreshed on the 30s load() poll, so the completion modal and
  // the idle status bubble lagged the log's "complete" line by up to 30s. Only the
  // review status is fetched here, and only while running, so it adds no
  // steady-state cost and never hammers the external credits gateway.
  useEffect(() => {
    if (!review?.running) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api.reviewStatus();
        if (!cancelled) setReview(next);
      } catch (_) {
        // A dropped fast poll is harmless: the 30s load() still runs, and the next
        // tick is REVIEW_POLL_INTERVAL_MS away.
      }
    }, REVIEW_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [review?.running]);

  // Announce the end of a run. The fast poll above flips `running` off within a
  // couple seconds of completion, so this fires — and the modal appears — right as
  // the status bubble goes idle, not at the next 30s poll.
  useEffect(() => {
    const isRunning = Boolean(review?.running);
    if (prevRunningRef.current && !isRunning) {
      if (review?.error) {
        setCompletion({ kind: 'error', title: 'Review run failed', subtitle: review.error });
      } else {
        const n = review?.prNumbers?.length;
        setCompletion({
          kind: 'success',
          title: 'Review complete',
          subtitle: n ? `Reviewed ${pluralPRs(n)}.` : 'The review run finished.',
        });
      }
      // A finished run also changes credits, the ledger and health; the fast poll
      // only refreshed the review status, so pull the rest now rather than waiting
      // for the next 30s tick. Safe from re-entry: prevRunningRef is already false
      // for the setReview this load() triggers, so the branch does not run again.
      load();
    }
    prevRunningRef.current = isRunning;
  }, [review, load]);

  const cfg = config?.config;

  // Null until GET /api/config answers. The server owns these limits, so they
  // are never assumed — the field's helper text and the count check both stay
  // quiet about a number the console has not actually been told.
  const maxPRs = cfg?.maxPRs ?? null;
  const daysBack = cfg?.daysBack ?? null;

  const { prNumbers, error: prError, duplicatesDropped } = parsePrNumbers(prInput, maxPRs);
  const reviewRunning = Boolean(review?.running) || triggering;

  // True only once the schedule config has loaded AND enabled is explicitly true.
  // Null (not yet loaded) reads as not-automated, so the schedule-only status rows
  // and the "Configure schedule" label never flash in before the config arrives.
  const isAutomated = scheduleConfig?.schedule?.enabled === true;

  /** Open Settings modal directly on the "Scheduled reviews" tab (index 1). */
  function openScheduleSettings() {
    setSettingsTab(1);
    setSettingsOpen(true);
  }

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
      if (err.status === 409) return handleAlreadyRunning(err);
      setTriggerError(err.message);
    } finally {
      setTriggering(false);
    }
    return undefined;
  }

  /**
   * Surface a 409 from a trigger as the "already running" modal.
  */
  async function handleAlreadyRunning(err) {
    setBusyRun(err.body || { message: err.message });
    await load();
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
      // A run is already in flight — modal, not inline, so a second operator
      // cannot miss it. The field is left untouched so they can retry the same
      // list once it clears.
      if (err.status === 409) return handleAlreadyRunning(err);
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
            Status badge — role="img" with aria-label carries the state for AT.
            The mouse-hover label ("Running"/"Idle") is a native `title`, not a
            Carbon Tooltip: the Tooltip needs a focusable trigger (tabIndex={0})
            and injects an onFocus handler via cloneElement, which VoiceOver
            announces as "clickable" on this non-interactive status. A plain
            title restores the hover affordance for sighted users with no
            interactive semantics — AT still reads the state from the aria-label.
          */}
          <div
            className="cm-review-status"
            role="img"
            aria-label={review?.running ? 'Review status: running' : 'Review status: idle'}
            title={review?.running ? 'Running' : 'Idle'}
          >
            <span className="cm-review-status__icon" aria-hidden="true">
              <Terminal size={20} />
              <span
                className={`cm-review-status__dot cm-review-status__dot--${
                  review?.running ? 'running' : 'idle'
                }`}
              />
            </span>
          </div>

          {/*
            Help sits to the LEFT of the settings gear. It opens the usage guide
            (/help) in a new tab — a public page, so it works whether or not the
            operator is signed in. aria-label doubles as the hover tooltip.
          */}
          <HeaderGlobalAction
            aria-label="Help"
            tooltipAlignment="center"
            onClick={() => window.open('/help', '_blank', 'noopener,noreferrer')}
          >
            <Help size={20} />
          </HeaderGlobalAction>

          {/*
            Connection settings live behind this rather than in a tile on the
            page. They are configured once — an IBMid sign-in at deploy time —
            and then never touched again, so a permanent full-width tile spent
            page real estate on something read about twice a year, and pushed the
            things an operator actually watches below the fold.
          */}
          <HeaderGlobalAction
            ref={settingsButtonRef}
            aria-label={settingsOpen ? 'Close Settings' : 'Open Settings'}
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
            <h1 className="cm-page-heading">Dashboard</h1>
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
            one can run. Reviews takes the wider column.
            When the daily schedule is enabled the tile becomes "Reviews — Automated":
            the manual controls are hidden (CSS, never unmounted so input state is
            safe) and a read-only status block shows the schedule's history. */}
        <Grid narrow withRowGap className="cm-tile-grid">
          <Column sm={4} md={8} lg={10}>
            <Tile className="cm-fill">
              <div className="cm-tile-head">
                <h2 className="cm-section-heading cm-tile-head__title">
                  {isAutomated ? 'Reviews — Automated' : 'Reviews'}
                </h2>
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

                {/*
                  Shown in both manual and automated mode: the scheduled run
                  draws from the same GITHUB_AI_AGENT_MAX_PRS / _DAYS_BACK
                  config as the manual "Review latest" button (see
                  SchedulePanel's maxPRs note), so the target criteria are
                  identical either way — only the trigger differs.
                */}
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
                        : targetWindowText(cfg.maxPRs, cfg.daysBack) || 'Loading…'}
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

                {/* Automated mode only: show schedule-specific status rows.
                    Times are shown in the operator's selected timezone. */}
                {isAutomated && scheduleConfig?.schedule && (
                  <>
                    <dt>Last scheduled run</dt>
                    <dd>
                      {scheduleConfig.schedule.lastRunAt
                        ? toLocalTz(scheduleConfig.schedule.lastRunAt, timezone)
                        : 'Never'}
                    </dd>

                    <dt>Next scheduled run</dt>
                    <dd>
                      {scheduleConfig.schedule.nextRunAt
                        ? toLocalTz(scheduleConfig.schedule.nextRunAt, timezone)
                        : 'Calculating…'}
                    </dd>
                  </>
                )}
              </dl>

              {/* Skipped-run warning — only relevant in automated mode. */}
              {isAutomated && scheduleConfig?.schedule?.lastRunSkipped && (
                <InlineNotification
                  kind="warning"
                  title="Last scheduled run was skipped"
                  subtitle={
                    scheduleConfig.schedule.lastSkipReason ||
                    'A manual review was in flight at the scheduled time.'
                  }
                  hideCloseButton
                  className="cm-tile-notification"
                />
              )}

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

              {/*
                Manual controls — always available, including while a daily
                schedule is configured. A scheduled run and a manual run share one
                single-flight lock (the server refuses a second run with 409 while
                one is in flight, and the scheduler skips its slot when a manual run
                is already going), so the two coexist safely: an operator never has
                to disable the schedule to review a PR by hand. Only an in-flight
                run (reviewRunning) disables the controls below.
              */}
              <div>
                <div className="cm-review-field">
                  <TextInput
                    id="cm-review-prs"
                    labelText="Pull request numbers"
                    placeholder="e.g. 22971, 22972"
                    helperText={prHelperText}
                    invalid={Boolean(prError)}
                    invalidText={prError || ''}
                    // Warn slot flags duplicate PR numbers that were collapsed
                    // (suppressed while an invalid error is showing).
                    warn={!prError && duplicatesDropped > 0}
                    warnText="Duplicate pull request numbers were ignored."
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
                    {reviewButtonLabel(prNumbers)}
                  </Button>

                  {/*
                    Discovery path into schedule settings, always present alongside
                    the manual controls. The label reflects state: "Configure
                    schedule" once a daily schedule is set, "Set up daily schedule"
                    otherwise. `=== true` rather than truthiness so the label stays
                    "Set up…" during the null instant before the schedule config
                    loads and never flashes "Configure…" on an unscheduled console.
                  */}
                  <Button kind="ghost" onClick={openScheduleSettings}>
                    {isAutomated === true ? 'Configure schedule' : 'Set up daily schedule'}
                  </Button>
                </div>
              </div>
            </Tile>
          </Column>

          <Column sm={4} md={8} lg={6}>
            <BobcoinsPanel credits={credits} check={bobcoinsCheck} />
          </Column>
        </Grid>

        {/* D. Live output — the answer to "is it actually doing anything?"*/}
        <Grid narrow withRowGap className={logVisible ? 'cm-tile-grid' : undefined}>
          <Column sm={4} md={8} lg={16}>
            <ReviewLog
              running={Boolean(review?.running)}
              startedAt={review?.startedAt}
              prNumbers={review?.prNumbers}
              owner={cfg?.owner}
              repo={cfg?.repo}
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


      <Modal
        open={settingsOpen}
        onRequestClose={() => {
          setSettingsOpen(false);
          // Reset to the default tab so re-opening lands on Carbon MCP, unless
          // the operator opened it explicitly from the schedule tile.
          setSettingsTab(0);
          setSettingsResetKey((key) => key + 1);
        }}
        modalHeading="Settings"
        aria-label="Settings"
        passiveModal
        launcherButtonRef={settingsButtonRef}
      >
        {/*
          Two tabs: Carbon MCP connection and Scheduled reviews.
          Carbon Tabs is used rather than nested Accordions — McpConnectionPanel
          already has its own Accordion internally ("Enter credentials manually"),
          and nesting Accordion inside AccordionItem produces unreliable focus-trap
          behaviour inside a Modal. Tabs avoid that issue entirely.
        */}
        <Tabs selectedIndex={settingsTab} onChange={({ selectedIndex }) => setSettingsTab(selectedIndex)}>
          <TabList aria-label="Settings sections">
            <Tab>Carbon MCP connection</Tab>
            <Tab>Scheduled reviews</Tab>
          </TabList>
          <TabPanels>
            <TabPanel>
              <McpConnectionPanel
                status={mcpStatus}
                onChanged={load}
                inPanel
                resetKey={settingsResetKey}
              />
            </TabPanel>
            <TabPanel>
              <SchedulePanel
                schedule={scheduleConfig?.schedule ?? null}
                config={cfg}
                onChanged={load}
                timezone={timezone}
                onTimezoneChange={setTimezone}
                resetKey={settingsResetKey}
              />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </Modal>

      {/*
        Already running. A trigger is refused with 409 while a review is in
        flight — the app is single-flight by design, so two agents never review
        the same PR and post duplicate comments. Shown as a Modal rather than the
        inline triggerError notification because the person who most needs to see
        it is a SECOND operator in another browser session, who did not start the
        run and would otherwise be told only "Request failed". It names what is
        running and since when, from the 409 body. Always mounted and driven by
        `open` so it animates in and out; the fields read defensively because the
        body is absent on a non-structured refusal.
      */}
      <Modal
        open={Boolean(busyRun)}
        onRequestClose={() => setBusyRun(null)}
        onRequestSubmit={() => setBusyRun(null)}
        modalHeading="A review is already in progress"
        modalLabel="Reviews"
        primaryButtonText="OK"
      >
        <p style={{ marginBottom: '1rem' }}>
          Carbon Monitor runs one review at a time, so a new run can’t start until
          the current one finishes. This is deliberate — it stops two agents
          reviewing the same pull request and posting duplicate comments.
        </p>
        <dl className="cm-definition-list">
          <dt>Started</dt>
          <dd>
            {busyRun?.startedAt
              ? new Date(busyRun.startedAt).toLocaleString()
              : 'Just now'}
          </dd>
          <dt>Reviewing</dt>
          <dd>
            {busyRun?.mode === 'explicit' && busyRun?.prNumbers?.length
              ? busyRun.prNumbers.map((number) => `#${number}`).join(', ')
              : 'Auto-selected pull requests'}
          </dd>
        </dl>
        <p style={{ marginTop: '1rem' }}>
          The live output below updates as it runs. Try again once it has finished.
        </p>
      </Modal>

      {/*
        Run finished. A clean run gets a celebratory success card dressed in Carbon
        for AI's aura/gradient tokens (its own visual language for AI moments) —
        far more of a payoff than the old growl — with the standing disclaimer as
        italic small print at the foot. A failed run keeps a plain error toast.
        Both are fixed and outside the Grid flow (Carbon guidance), so they float
        over the console rather than shifting layout.
      */}
      {/*
        Run finished cleanly. A small, centered passive Modal — Carbon centers it
        in the viewport and traps focus. The heading carries the outcome; the body
        keeps the run summary and the standing AI disclaimer. passiveModal renders
        no footer: the only action is to close (the X, Escape, or clicking
        outside), which is all a confirmation needs. Always mounted and driven by
        `open` so it animates in and out. A failed run still uses the plain error
        toast below.
      */}
      {/*
        aria-describedby points to the wrapper that contains both the run
        summary and the AI disclaimer. Carbon Modal spreads ...rest onto the
        <div role="dialog">, so this lands on the correct element. AT reads
        the heading (via aria-labelledby) then the body (via aria-describedby)
        on focus entry — the disclaimer is announced without requiring the
        operator to navigate down to it.
      */}
      <Modal
        open={completion?.kind === 'success'}
        onRequestClose={() => setCompletion(null)}
        passiveModal
        size="sm"
        modalLabel="Reviews"
        modalHeading={completion?.title || 'Review complete'}
        aria-label={completion?.title || 'Review complete'}
        aria-describedby="cm-completion-modal-body"
      >
        <div id="cm-completion-modal-body">
          <p className="cm-modal__para">{completion?.subtitle}</p>
          <p className="cm-modal__disclaimer">
            AI-powered review can save time and increase productivity, but human
            review is still required — AI can make mistakes.
          </p>
        </div>
      </Modal>

      {/*
        Always-present assertive live region. Empty at rest; receives
        completion.title when an error fires. A live region that exists in
        the DOM before content is injected is guaranteed to announce by AT —
        a node that mounts with content already in it is not. This gives
        VoiceOver/Safari and NVDA/Firefox the content-change event they need.
        Visually hidden — the ToastNotification below is the visual presentation
        and is left completely unchanged.
      */}
      <div
        role="alert"
        aria-atomic="true"
        className="cds--visually-hidden"
      >
        {completion?.kind === 'error' ? completion.title : ''}
      </div>

      {completion?.kind === 'error' && (
        <div className="cm-toast-region">
          <ToastNotification
            kind="error"
            title={completion.title}
            subtitle={completion.subtitle}
            lowContrast
            timeout={8000}
            onClose={() => {
              setCompletion(null);
              return true;
            }}
          />
        </div>
      )}
    </Theme>
  );
}

export default Console;
