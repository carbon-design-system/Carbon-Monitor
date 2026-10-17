import React, { useEffect, useRef, useState } from 'react';
import {
  Tile,
  InlineNotification,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from '@carbon/react';
import { GaugeChart } from '@carbon/charts-react';
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
      'The gateway returned 401. This is usually transient. Wait a few minutes, refresh the browser and try again.',
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
      subtitle:
        'The balance request was rejected. The gateway may be degraded.',
    };
  }

  return {
    title: 'Balance unavailable',
    subtitle: reason
      ? `The Bob gateway could not be read: ${reason}.`
      : 'The Bob gateway could not be read, and gave no reason.',
  };
}

const COIN_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

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
 * Animate a number toward its latest value, honouring reduced-motion.
 *
 * The balance changes after a run completes; counting to the new figure rather
 * than snapping to it makes that change legible and a little satisfying. The
 * first value shows immediately — only later changes animate — and a caller who
 * has asked for reduced motion gets the value with no animation at all.
 */
function useAnimatedNumber(target, duration = 900) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!Number.isFinite(target) || reduce) {
      setDisplay(target);
      fromRef.current = target;
      return undefined;
    }

    const from = Number.isFinite(fromRef.current) ? fromRef.current : target;
    if (from === target) {
      setDisplay(target);
      return undefined;
    }

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

/**
 * The headline number, its context, and the proportion still available.
 *
 * `check` is the 'bobcoins' entry from GET /api/status, which this tile now
 * reports on behalf of the status row.
 */
function BalanceTile({ balance, summary, check }) {
  const available = balance?.available === true;
  const animatedRemaining = useAnimatedNumber(balance?.remaining);
  const { title, subtitle } = unavailableCopy(balance?.reason);

  // A budget of zero would divide by zero below, and an absent one (an
  // uncapped plan) has no proportion to show, so both suppress the bar.
  const budget =
    Number.isFinite(balance?.budgetLimit) && balance.budgetLimit > 0
      ? balance.budgetLimit
      : null;
  const used = Number.isFinite(balance?.usage) ? balance.usage : null;
  const exhausted = budget !== null && used !== null && used >= budget;
  const percentRemaining = Number.isFinite(balance?.percentRemaining)
    ? Math.round(balance.percentRemaining)
    : null;

  // Budget gauge: a semicircular arc filled to the percentage of budget
  const remaining = Number.isFinite(balance?.remaining)
    ? balance.remaining
    : null;
  const gaugeValue =
    percentRemaining !== null
      ? percentRemaining
      : budget
        ? Math.round(((remaining ?? 0) / budget) * 100)
        : 0;
  const gaugeStatus =
    gaugeValue < 10 ? 'danger' : gaugeValue < 25 ? 'warning' : 'success';
  // Plain-English urgency label — appended to the prose sub-line only when the
  // budget is not healthy, so colour is not the sole signal (WCAG 1.4.1) but
  // normal state isn't cluttered with a redundant confirmation word.
  // null = healthy (>= 25%): the number speaks for itself.
  const gaugeUrgency =
    gaugeValue < 10 ? 'critical' : gaugeValue < 25 ? 'low' : null;
  const gaugeColor =
    gaugeValue < 10 ? '#da1e28' : gaugeValue < 25 ? '#ff832b' : '#0f62fe';
  const gaugeData = [{ group: 'value', value: gaugeValue }];
  const gaugeOptions = {
    resizable: true,
    height: '152px',
    gauge: { type: 'semi', status: gaugeStatus },
    color: { scale: { value: gaugeColor } },
    toolbar: { enabled: false },
  };

  return (
    <Tile className="cm-coins cm-fill">
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
          {/* Capped budget → a semicircular gauge of the % still available, with
              the exact figures beside it (the gauge is the glance, the numbers the
              detail). Height-locked (see .cm-coins__gauge) so this card stays level
              with the Reviews card. An uncapped plan has no percentage to gauge, so
              it shows the figure plainly and keeps its count-up. */}
          {budget !== null && used !== null ? (
            <div className="cm-coins__budget">
              {/*
                role="img" wrapper gives AT a single, accurate label for the
                whole gauge area. aria-hidden on the inner div suppresses the
                GaugeChart SVG internals, which would otherwise be announced as
                disconnected SVG text nodes. The label carries only the
                percentage — urgency is in the prose sub-line below so it is
                not announced twice. WCAG 1.1.1.
              */}
              <div
                role="img"
                aria-label={`Budget gauge: ${gaugeValue}% remaining${gaugeUrgency ? ` · ${gaugeUrgency}` : ''}`}
                className="cm-coins__gauge-wrapper"
              >
                <div className="cm-coins__gauge" aria-hidden="true">
                  <GaugeChart data={gaugeData} options={gaugeOptions} />
                </div>
              </div>
              <div className="cm-coins__figures">
                <p className="cm-coins__value">
                  <CoinValue value={animatedRemaining} />
                </p>
                <p className="cm-coins__label">Bobcoins remaining</p>
                {/*
                  gaugeUrgency appended only when non-null (budget is low or
                  critical) so the status level is conveyed independently of
                  colour (WCAG 1.4.1) without cluttering healthy state with a
                  redundant confirmation word.
                */}
                <p className="cm-coins__sub">
                  {`${coins(used)} used · ${coins(budget)} budget${gaugeUrgency ? ` · ${gaugeUrgency}` : ''}`}
                </p>
              </div>
            </div>
          ) : (
            <p className="cm-coins__value">
              <CoinValue value={animatedRemaining} />
            </p>
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
function LedgerTile({ entries, hasCredits, summary, balance }) {
  const rows = [...entries]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 10);

  const available = balance?.available === true;

  // The spend summary that used to sit inside the balance card lives here now,
  // where there is full width for it. Moving it out is what lets the balance card
  // and the Reviews card sit at a matched height without a well of dead space
  // beneath either — and a wide KPI row reads better than a stacked list anyway.
  const stats = [
    {
      label: 'Total recorded here',
      value: <CoinValue value={summary?.totalSpent} />,
    },
    {
      label: 'Average per review',
      value: <CoinValue value={summary?.averagePerReview} />,
    },
    {
      label: 'Last 24 hours',
      value: <CoinValue value={summary?.last24hSpent} />,
    },
    { label: 'Last 7 days', value: <CoinValue value={summary?.last7dSpent} /> },
    ...(available
      ? [
          { label: 'Plan', value: planLabel(balance) },
          {
            label: 'Budget resets',
            value: <TimeValue value={balance.refreshAt} />,
          },
        ]
      : []),
  ];

  return (
    <Tile className="cm-coins-ledger">
      <h2 className="cm-section-heading">Spend &amp; recent reviews</h2>

      <dl className="cm-stat-row">
        {stats.map((stat) => (
          <div className="cm-stat" key={stat.label} role="presentation">
            <dt className="cm-stat__label">{stat.label}</dt>
            <dd className="cm-stat__value">{stat.value}</dd>
          </div>
        ))}
      </dl>

      {rows.length === 0 ? (
        <p className="cm-coins__empty">
          {hasCredits
            ? 'No reviews recorded yet. Spend appears here once a review completes.'
            : 'Spend history is not available from this server.'}
        </p>
      ) : (
        <StructuredListWrapper
          isCondensed
          aria-label="Bobcoins spent per review"
        >
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Pull request</StructuredListCell>
              <StructuredListCell head>Finished</StructuredListCell>
              <StructuredListCell head>Spent</StructuredListCell>
              <StructuredListCell head>
                Account balance after
              </StructuredListCell>
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

      {rows.length > 0 && (
        <p className="cm-coins__caption">
          “Account balance after” is the account balance snapshotted right after
          each review, and it is unlikely to match the live “Remaining this
          month” balance, which also reflects Bobcoins spent elsewhere on the
          account.
        </p>
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
    <BalanceTile
      balance={credits.balance}
      summary={credits.summary}
      check={check}
    />
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

  return (
    <LedgerTile
      entries={history?.entries || []}
      hasCredits={Boolean(history)}
      summary={credits.summary}
      balance={credits.balance}
    />
  );
}

export { BobcoinsLedger };
export default BobcoinsPanel;
