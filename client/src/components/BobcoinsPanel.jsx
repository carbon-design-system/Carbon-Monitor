import React from 'react';
import {
  Tile,
  ProgressBar,
  InlineNotification,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from '@carbon/react';
// Vite resolves this to a hashed URL at build time. The vector is used rather
// than the PNG so the mark stays sharp at any size and on any density.
import bobMark from '../assets/bob.svg';

/**
 * Bobcoin budget and burn-down.
 *
 * Two tiles that no longer travel together: the balance (what is left of the
 * monthly allowance) belongs beside the review controls, because it is what
 * decides whether the next run can happen at all, while the ledger (which
 * reviews spent it) is history and sits with the other reference material at the
 * foot of the page. Each is exported on its own and the page places them —
 * previously this file rendered its own Grid holding both, which meant a ledger
 * with one row was stretched to the height of the balance tile beside it and
 * showed mostly white space.
 *
 * Deliberately built from core Carbon rather than Carbon Charts — the headline
 * question, "how much is left?", has a single number as its answer, so a
 * ProgressBar encodes it directly, and the depletion story reads better as a
 * per-review list than as a three-point line. Adding @carbon/charts would
 * roughly double the client bundle for that.
 *
 * The balance comes from the Bob gateway and the ledger from this server's own
 * records, so the two can disagree about availability: a missing API key blanks
 * the balance while leaving the locally recorded spend perfectly readable. Each
 * half therefore degrades on its own.
 */

/**
 * Why the gateway balance is missing, in operator language.
 *
 * Keyed by `balance.reason`. An unrecognised reason still produces something
 * useful rather than a blank tile, since the server may add reasons later.
 */
const UNAVAILABLE_COPY = {
  'no-api-key': {
    title: 'Balance not configured',
    subtitle:
      'No Bob API key is set on this server, so the account balance cannot be read. Spend recorded here is still shown.',
  },
  unauthorized: {
    title: 'Bob rejected the API key',
    subtitle:
      'The gateway returned 401. Check that the configured key is current and that it matches the instance and team.',
  },
  unreachable: {
    title: 'Bob gateway unreachable',
    subtitle:
      'The balance request did not complete. The gateway may be down, or blocked by the network this container runs on.',
  },
  'budget-exceeded': {
    title: 'Monthly budget exhausted',
    subtitle:
      'Bob returned 402 — the allowance for this account is spent. Reviews will keep failing until the budget resets.',
  },
  'bad-response': {
    title: 'Bob returned an unrecognised profile',
    subtitle:
      'The gateway answered, but not with a profile this console can read. The account API may have changed shape.',
  },
};

function unavailableCopy(reason) {
  if (UNAVAILABLE_COPY[reason]) return UNAVAILABLE_COPY[reason];

  // The server reports any other rejected status as `http-<status>`.
  const httpStatus = /^http-(\d+)$/.exec(reason || '');
  if (httpStatus) {
    return {
      title: `Bob returned HTTP ${httpStatus[1]}`,
      subtitle: 'The balance request was rejected. The gateway may be degraded.',
    };
  }

  return {
    title: 'Balance unavailable',
    subtitle: reason
      ? `The Bob gateway could not be read: ${reason}.`
      : 'The Bob gateway could not be read, and gave no reason.',
  };
}

const COIN_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/**
 * A Bobcoin amount as plain text, or an em dash when the server sent null.
 *
 * Kept string-returning because it is interpolated into sentences and into
 * ProgressBar's helperText. For a value shown on its own — a definition-list
 * value, a table cell — use <CoinValue>, which announces the missing case.
 */
function coins(value) {
  return Number.isFinite(value) ? COIN_FORMAT.format(value) : '—';
}

/**
 * Dates are rendered with the time attached, including the budget reset.
 *
 * `refreshAt` is an instant, not a calendar date, so a date-only rendering of a
 * UTC-midnight reset shows the previous day in western timezones — "resets
 * 8/31" for a budget the API says renews on 1 September.
 */
function timestamp(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

/**
 * The em dash, said out loud.
 *
 * VoiceOver and NVDA skip a standalone em dash at their default punctuation
 * settings, so a missing figure announces as silence — indistinguishable from a
 * rendering failure, or from a genuine zero. Worse in the ledger, where 'Spent'
 * and 'Remaining after' can both be missing and the row's last two cells then
 * announce as nothing at all. The dash stays exactly as it looks; only the
 * announcement changes.
 */
const MISSING = '—';

function Missing() {
  return (
    <>
      <span aria-hidden="true">{MISSING}</span>
      <span className="cds--visually-hidden">Not available</span>
    </>
  );
}

/** A Bobcoin amount for display on its own, announced when it is absent. */
function CoinValue({ value }) {
  const text = coins(value);
  return text === MISSING ? <Missing /> : text;
}

/** A timestamp for display on its own, announced when it is absent. */
function TimeValue({ value }) {
  const text = timestamp(value);
  return text === MISSING ? <Missing /> : text;
}

/**
 * Bob's own plan names are frequently already "Trial", so the qualifier is only
 * added when the name does not carry it.
 */
function planLabel(balance) {
  const name = balance.planName || balance.plan;
  if (!name) return balance.isTrial ? 'Trial' : 'Unknown';
  return balance.isTrial && !/trial/i.test(name) ? `${name} (trial)` : name;
}

/**
 * The Bobcoins entry from GET /api/status, rendered as a notification.
 *
 * This tile used to have a matching status tile in the row above it. That tile
 * is gone — showing the balance twice was what forced a fifth tile onto a row of
 * four and left it sitting alone, reading as an error rather than a wrap — so
 * the check's verdict has to surface here instead, or a failing dependency would
 * simply stop being reported anywhere.
 *
 * `succeeded` renders nothing: the balance below already says so, in numbers.
 */
function CheckNotice({ check }) {
  if (!check || check.status === 'succeeded') return null;

  const kind = check.status === 'failed' ? 'error' : 'warning';

  return (
    <InlineNotification
      kind={kind}
      title={check.detail || 'Bobcoins check did not pass'}
      subtitle={check.hint || ''}
      hideCloseButton
      lowContrast
      className="cm-coins__notification"
    />
  );
}

/**
 * The headline number, its context, and the proportion still available.
 *
 * `check` is the 'bobcoins' entry from GET /api/status, which this tile now
 * reports on behalf of the status row.
 */
function BalanceTile({ balance, summary, check }) {
  const available = balance?.available === true;
  const { title, subtitle } = unavailableCopy(balance?.reason);

  // A budget of zero would divide by zero below, and an absent one (an
  // uncapped plan) has no proportion to show, so both suppress the bar.
  const budget = Number.isFinite(balance?.budgetLimit) && balance.budgetLimit > 0
    ? balance.budgetLimit
    : null;
  const used = Number.isFinite(balance?.usage) ? balance.usage : null;
  const exhausted = budget !== null && used !== null && used >= budget;
  const percentRemaining = Number.isFinite(balance?.percentRemaining)
    ? Math.round(balance.percentRemaining)
    : null;

  return (
    <Tile className="cm-coins">
      {/* Heading left, Bob right, on one row. Bobcoins are what Bob's work
          costs, so the mark sits with the balance it draws down. */}
      <div className="cm-tile-head">
        <h2 className="cm-section-heading cm-tile-head__title">Bobcoins</h2>
        {/*
          Real alt text rather than alt="". At a glyph's size this was incidental
          decoration; at this size it is a prominent element carrying the fact
          that the balance belongs to Bob — information a sighted reader gets and
          a screen-reader user would otherwise not.

          It names the agent, not the file: "Bob logo" would describe the artwork
          and help nobody.

          Sized by height in CSS with width left to follow: the artwork is a
          512x341 viewBox, so constraining both axes would squash it.
        */}
        <img
          src={bobMark}
          alt="Bobcoins are spent by Bob, IBM's AI coding agent"
          className="cm-bob-mark"
        />
      </div>

      {/*
        Suppressed when the tile is already explaining the same thing in its own
        words: an unreadable balance and an exhausted budget each get a
        purpose-written notification below, and the check's terser version of the
        same news stacked above it would read as two separate problems. What is
        left is the state only the server can judge — a budget below
        BOB_CREDITS_LOW_PCT, which still works now and fails the next review.
      */}
      {available && !exhausted && <CheckNotice check={check} />}

      {available ? (
        <>
          <p className="cm-coins__label">Remaining this month</p>
          <p className="cm-coins__value"><CoinValue value={balance.remaining} /></p>
          <p className="cm-coins__sub">
            {budget === null
              ? 'This plan has no monthly cap.'
              : `of ${coins(budget)} monthly budget${
                  percentRemaining === null ? '' : ` · ${percentRemaining}% left`
                }`}
          </p>

          {budget !== null && used !== null && (
            <div className="cm-coins__progress">
              {/*
                "finished" when the budget is spent, "active" otherwise.

                status="error" is what zeroes the bar (`if (isError)
                cappedValue = 0`) — the *next* branch, `else if (isFinished)
                cappedValue = max`, draws it FULL, which is the truth for an
                exhausted budget. It also adds a CheckmarkFilled, so the state
                does not rest on colour alone.

                The real cost of pinning this to "active" is announcement:
                ProgressBar renders `aria-busy={!isFinished}` and, whenever
                helperText is set, a visually hidden aria-live region reading
                "Loading" until finished. A permanently "active" meter tells a
                screen reader the budget gauge is still loading — including when
                it is fully spent and nothing is in flight.
              */}
              <ProgressBar
                label="Monthly budget used"
                helperText={`${coins(used)} of ${coins(budget)} spent`}
                value={Math.min(used, budget)}
                max={budget}
                status={exhausted ? 'finished' : 'active'}
              />
            </div>
          )}

          {exhausted && (
            <InlineNotification
              kind="error"
              title="Budget exhausted"
              subtitle={`All ${coins(budget)} Bobcoins for this period are spent. Reviews will fail until the budget resets.`}
              hideCloseButton
              lowContrast
              className="cm-coins__notification"
            />
          )}
        </>
      ) : (
        <InlineNotification
          kind="warning"
          title={title}
          subtitle={subtitle}
          hideCloseButton
          lowContrast
          className="cm-coins__notification"
        />
      )}

      <dl className="cm-definition-list">
        <dt>Spent here</dt>
        <dd>
          <CoinValue value={summary?.totalSpent} /> across {summary?.reviewCount ?? 0}{' '}
          {summary?.reviewCount === 1 ? 'review' : 'reviews'}
        </dd>

        <dt>Average per review</dt>
        <dd><CoinValue value={summary?.averagePerReview} /></dd>

        <dt>Last 24 hours</dt>
        <dd><CoinValue value={summary?.last24hSpent} /></dd>

        <dt>Last 7 days</dt>
        <dd><CoinValue value={summary?.last7dSpent} /></dd>

        {available && (
          <>
            <dt>Plan</dt>
            <dd>{planLabel(balance)}</dd>

            <dt>Budget resets</dt>
            <dd><TimeValue value={balance.refreshAt} /></dd>
          </>
        )}
      </dl>
    </Tile>
  );
}

/**
 * The per-review ledger.
 *
 * "Remaining after" is the depletion story told plainly: read down the column
 * and the budget draws down review by review. It is only populated for runs
 * where a balance snapshot succeeded, so nulls are expected and shown as such
 * rather than as zeros.
 */
function LedgerTile({ entries, hasCredits }) {
  const rows = [...entries]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 10);

  return (
    <Tile className="cm-coins-ledger">
      <h2 className="cm-section-heading">Recent reviews</h2>

      {rows.length === 0 ? (
        <p className="cm-coins__empty">
          {hasCredits
            ? 'No reviews recorded yet. Spend appears here once a review completes.'
            : 'Spend history is not available from this server.'}
        </p>
      ) : (
        <StructuredListWrapper isCondensed aria-label="Bobcoins spent per review">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Pull request</StructuredListCell>
              <StructuredListCell head>Finished</StructuredListCell>
              <StructuredListCell head>Spent</StructuredListCell>
              <StructuredListCell head>Remaining after</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {rows.map((entry) => (
              <StructuredListRow key={entry.correlationId || entry.at}>
                <StructuredListCell noWrap>
                  {entry.prNumber ? `#${entry.prNumber}` : 'All open PRs'}
                </StructuredListCell>
                <StructuredListCell noWrap>
                  <TimeValue value={entry.at} />
                </StructuredListCell>
                <StructuredListCell className="cm-coins__numeric">
                  <CoinValue value={entry.coinsSpent} />
                </StructuredListCell>
                <StructuredListCell className="cm-coins__numeric">
                  <CoinValue value={entry.remainingAfter} />
                </StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </Tile>
  );
}

/**
 * The balance tile, on its own, for the page to place.
 *
 * No Grid and no Column: which row this belongs to, and how wide it is there, is
 * the page's decision. Returning its own grid is what previously chained it to
 * the ledger.
 */
function BobcoinsPanel({ credits, check }) {
  // The endpoints are additive, so a server that predates them returns 404 and
  // the console must still say something coherent instead of rendering zeros.
  if (!credits) {
    return (
      <Tile>
        <h2 className="cm-section-heading">Bobcoins</h2>
        <InlineNotification
          kind="info"
          title="Bobcoin accounting unavailable"
          subtitle="This server did not return a credit balance. It may be running a build from before Bobcoin tracking was added."
          hideCloseButton
          lowContrast
          className="cm-coins__notification"
        />
      </Tile>
    );
  }

  return (
    <BalanceTile balance={credits.balance} summary={credits.summary} check={check} />
  );
}

/**
 * The per-review ledger, on its own, for the page to place.
 *
 * `credits` is passed only to tell "this server has no Bobcoin accounting at
 * all" apart from "it has accounting and no reviews have run yet" — two states
 * that look identical from an empty list.
 */
function BobcoinsLedger({ credits, history }) {
  if (!credits) {
    return (
      <Tile>
        <h2 className="cm-section-heading">Recent reviews</h2>
        <p className="cm-coins__empty">
          This server does not record per-review spend.
        </p>
      </Tile>
    );
  }

  return <LedgerTile entries={history?.entries || []} hasCredits={Boolean(history)} />;
}

export { BobcoinsLedger };
export default BobcoinsPanel;
