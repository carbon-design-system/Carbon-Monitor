import React, { useEffect, useState } from 'react';
import {
  Toggle,
  TimePicker,
  TimePickerSelect,
  SelectItem,
  Button,
  InlineNotification,
} from '@carbon/react';
import { WarningFilled } from '@carbon/icons-react';
import { api } from '../api';
import { targetWindowText } from '../utils/prPhrasing';

/**
 * The zone the operator sees first. The server's canonical zone
 * (SCHEDULE_TIMEZONE, reported as schedule.timezone) is used for conversions;
 * this only seeds the selector.
 */
export const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Format a UTC ISO string for display in a given IANA timezone.
 *
 * @param {string|null} isoString
 * @param {string} [tz=DEFAULT_TIMEZONE]
 * @returns {string|null}
 */
export function toLocalTz(isoString, tz = DEFAULT_TIMEZONE) {
  if (!isoString) return null;
  try {
    return new Date(isoString).toLocaleString('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch (_) {
    // Unknown timezone (e.g. an IANA zone not supported by this runtime) —
    // fall back to the default so the display is always a valid time string.
    try {
      return new Date(isoString).toLocaleString('en-US', {
        timeZone: DEFAULT_TIMEZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      });
    } catch (_2) {
      return isoString;
    }
  }
}

/**
 * Scheduled reviews settings panel.
 *
 * Rendered inside the Settings modal's "Scheduled reviews" tab. Provides:
 *   - Toggle to enable/disable the daily run
 *   - Time input (HH:MM, shown in the selected zone)
 *   - Read-only display of the effective max PRs (from server config)
 *   - Status read-out: last run, next run, skip warning
 *
 * The stored time is a wall-clock value in the server's canonical zone
 * (schedule.timezone). The operator picks a display zone; every value shown
 * is converted from the canonical zone to it, and edits are converted back.
 *
 * @param {Object|null} schedule  - From GET /api/schedule
 * @param {Object|null} config    - From GET /api/config (for maxPRs read-only display)
 * @param {Function}    onChanged - Called after a successful save to re-fetch parent state
 */
// ── Timezone list ────────────────────────────────────────────────────────────

/**
 * Common IANA timezone zones shown in the selector.
 * Covers the major US, EU, Asia-Pacific and Latin America zones operators
 * are likely to be in. The full IANA database has 500+ entries; this focused
 * list keeps the dropdown scannable.
 */
const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Phoenix', label: 'Mountain Time – AZ (MST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
  { value: 'America/Sao_Paulo', label: 'Brasília Time (BRT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central European (CET)' },
  { value: 'Europe/Helsinki', label: 'Eastern European (EET)' },
  { value: 'Asia/Dubai', label: 'Gulf Time (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Bangkok', label: 'Indochina (ICT)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
  { value: 'Pacific/Auckland', label: 'New Zealand (NZST/NZDT)' },
];

// ── Time conversion helpers ───────────────────────────────────────────────────

/**
 * A zone's offset from UTC, in ms, at a reference instant: UTC = local + offset.
 */
function zoneOffsetMsAt(refUtcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(refUtcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const localMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second')
  );
  return refUtcMs - localMs;
}

// A fixed reference date (2000-01-05, a Wednesday) keeps the conversion
// deterministic: the schedule fires at a fixed clock time year-round, so what
// matters is the operator's "9 AM my time", not a DST-adjusted equivalent.
const REF_UTC_MS = Date.UTC(2000, 0, 5, 12, 0, 0);

/**
 * Convert a 24-hour "HH:MM" in the canonical zone to a wall-clock time in the
 * display zone, as { display: "h:mm", period: "AM"|"PM" }.
 */
function canonicalToDisplay(hhmm, targetTz, canonicalTz) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm))
    return { display: '9:00', period: 'AM' };
  try {
    const [hStr, mStr] = hhmm.split(':');
    const utcMs =
      Date.UTC(2000, 0, 5, Number(hStr), Number(mStr), 0) +
      zoneOffsetMsAt(REF_UTC_MS, canonicalTz);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(new Date(utcMs));
    const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '9';
    const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const dayPeriod =
      parts.find((p) => p.type === 'dayPeriod')?.value?.toUpperCase() ?? 'AM';
    return {
      display: `${Number(hourPart)}:${minutePart}`,
      period: dayPeriod.startsWith('P') ? 'PM' : 'AM',
    };
  } catch (_) {
    return { display: '9:00', period: 'AM' };
  }
}

/**
 * Convert a 12-hour display time in the display zone back to a 24-hour
 * "HH:MM" in the canonical zone. Returns null when the display value is not a
 * valid time.
 */
function displayToCanonical(display, period, sourceTz, canonicalTz) {
  if (!display || !/^\d{1,2}:\d{2}$/.test(display)) return null;
  let [h, m] = display.split(':').map(Number);
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;
  if (period === 'AM') {
    h = h === 12 ? 0 : h;
  } else {
    h = h === 12 ? 12 : h + 12;
  }
  try {
    const utcMs =
      Date.UTC(2000, 0, 5, h, m, 0) + zoneOffsetMsAt(REF_UTC_MS, sourceTz);
    const canonicalMs = utcMs - zoneOffsetMsAt(REF_UTC_MS, canonicalTz);
    const d = new Date(canonicalMs);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  } catch (_) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

function SchedulePanel({
  schedule,
  config,
  onChanged,
  timezone,
  onTimezoneChange,
  resetKey,
}) {
  // The zone the stored time is expressed in, reported by the server.
  const canonicalTz = schedule?.timezone ?? DEFAULT_TIMEZONE;
  // Local form state — initialised from the server's current values.
  // Using separate pieces of state (not mirroring the whole schedule object)
  // so a partial edit does not mutate the prop.
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [paused, setPaused] = useState(schedule?.paused ?? false);
  const [timeLocal, setTimeLocal] = useState(schedule?.timeLocal ?? '09:00');

  // 12-hour display state derived from the stored value converted to the
  // selected timezone (lifted to Console, received as a prop).
  const [timeDisplay, setTimeDisplay] = useState(
    () =>
      canonicalToDisplay(schedule?.timeLocal ?? '09:00', timezone, canonicalTz)
        .display
  );
  const [timePeriod, setTimePeriod] = useState(
    () =>
      canonicalToDisplay(schedule?.timeLocal ?? '09:00', timezone, canonicalTz)
        .period
  );

  // A null means the display field is incomplete/invalid.
  const timeError = !displayToCanonical(
    timeDisplay,
    timePeriod,
    timezone,
    canonicalTz
  )
    ? 'Enter a valid time'
    : null;

  const [busy, setBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // The last-saved values, used both to detect unsaved edits and to reset the
  // form on "Discard changes". Deliberately just `enabled` + `timeLocal` — the
  // two fields that are actually persisted by POST /api/schedule. Timezone is
  // excluded on purpose: it has no persisted field of its own (see
  // onTimezoneChange below), so switching zones must never read as an
  // unsaved change.
  const [savedEnabled, setSavedEnabled] = useState(schedule?.enabled ?? false);
  const [savedTimeLocal, setSavedTimeLocal] = useState(
    schedule?.timeLocal ?? '09:00'
  );

  const isDirty = enabled !== savedEnabled || timeLocal !== savedTimeLocal;

  // Clear the save confirmation when the parent Settings modal closes.
  // The modal stays mounted (only hidden) between opens, so this component
  // never unmounts on its own — without this, a stale "Schedule saved"
  // banner would reappear on reopen with no new save having happened.
  useEffect(() => {
    setMessage(null);
  }, [resetKey]);

  // Sync form fields when the parent re-fetches (e.g. after save or 30s poll).
  // Gated on `!isDirty` as well as `!busy`: without it, a poll landing seconds
  // after an edit silently overwrote the field with the server's still-old
  // value — the edit did not survive being left for "a few seconds", not
  // because the modal discarded it on close, but because the very next
  // background poll clobbered it. Held off until the operator saves or
  // discards, at which point isDirty goes false and the pending sync applies.
  const [lastSyncedSchedule, setLastSyncedSchedule] = useState(schedule);
  if (schedule !== lastSyncedSchedule && !busy && !isDirty) {
    setLastSyncedSchedule(schedule);
    setEnabled(schedule?.enabled ?? false);
    setPaused(schedule?.paused ?? false);
    const synced24 = schedule?.timeLocal ?? '09:00';
    const { display, period } = canonicalToDisplay(
      synced24,
      timezone,
      canonicalTz
    );
    setTimeLocal(synced24);
    setTimeDisplay(display);
    setTimePeriod(period);
    setSavedEnabled(schedule?.enabled ?? false);
    setSavedTimeLocal(synced24);
  }

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    // Convert the display time in the selected timezone back to the canonical zone for storage.
    const value24 = displayToCanonical(
      timeDisplay,
      timePeriod,
      timezone,
      canonicalTz
    );
    const finalTimeLocal = value24 ?? timeLocal;
    try {
      await api.setSchedule({ enabled, timeLocal: finalTimeLocal });
      setSavedEnabled(enabled);
      setSavedTimeLocal(finalTimeLocal);
      setMessage({ kind: 'success', title: 'Schedule saved' });
      onChanged();
    } catch (err) {
      setMessage({
        kind: 'error',
        title: 'Could not save schedule',
        subtitle: err.message,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Revert the form to the last-saved values without a network call.
   * Mirrors the poll-sync reset above exactly, so a discard and an
   * out-of-band server sync can never leave the fields in different shapes.
   */
  function handleDiscard() {
    setEnabled(savedEnabled);
    setTimeLocal(savedTimeLocal);
    const { display, period } = canonicalToDisplay(
      savedTimeLocal,
      timezone,
      canonicalTz
    );
    setTimeDisplay(display);
    setTimePeriod(period);
    setMessage(null);
  }

  async function handlePauseToggle() {
    const next = !paused;
    setPauseBusy(true);
    setMessage(null);
    try {
      await api.setSchedule({ paused: next });
      setPaused(next);
      onChanged();
      if (!next) {
        setMessage({
          kind: 'info',
          title: 'Schedule resumed.',
          subtitle:
            'If token balance is still low, the schedule will re-pause automatically.',
        });
      }
    } catch (err) {
      setMessage({
        kind: 'error',
        title: 'Could not update pause state',
        subtitle: err.message,
      });
    } finally {
      setPauseBusy(false);
    }
  }

  const maxPRs = config?.maxPRs ?? null;
  const daysBack = config?.daysBack ?? null;

  return (
    <div className="cm-schedule-panel">
      {message && (
        <InlineNotification
          kind={message.kind}
          title={message.title}
          subtitle={message.subtitle}
          onCloseButtonClick={() => setMessage(null)}
          className="cm-login__notification"
        />
      )}

      {schedule?.lastRunSkipped && !schedule?.paused && (
        <InlineNotification
          kind="warning"
          title="Last scheduled run was skipped"
          subtitle={
            schedule.lastSkipReason ||
            'A manual review was in flight at the scheduled time.'
          }
          hideCloseButton
          className="cm-login__notification"
        />
      )}

      {schedule?.enabled && schedule?.paused && (
        <InlineNotification
          kind="warning"
          title="Scheduled reviews are paused."
          subtitle={
            schedule?.lastSkipReason || 'Click Resume schedule to re-enable.'
          }
          hideCloseButton
          className="cm-login__notification"
        />
      )}

      <form onSubmit={handleSave}>
        <div className="cm-schedule-panel__fields">
          <Toggle
            id="cm-schedule-enabled"
            labelText="Enable daily scheduled review"
            labelA="Off"
            labelB="On"
            toggled={enabled}
            onToggle={(checked) => setEnabled(checked)}
            disabled={busy}
          />

          <TimePicker
            id="cm-schedule-time"
            labelText="Daily run time"
            placeholder="hh:mm"
            pattern="\d{1,2}:\d{2}"
            value={timeDisplay}
            onChange={(e) => {
              const display = e.target.value;
              setTimeDisplay(display);
              const v24 = displayToCanonical(
                display,
                timePeriod,
                timezone,
                canonicalTz
              );
              if (v24) setTimeLocal(v24);
            }}
            invalid={enabled && Boolean(timeError)}
            invalidText={timeError || ''}
            disabled={busy || !enabled}
          >
            <TimePickerSelect
              id="cm-schedule-time-period"
              labelText="AM/PM"
              value={timePeriod}
              onChange={(e) => {
                const period = e.target.value;
                setTimePeriod(period);
                const v24 = displayToCanonical(
                  timeDisplay,
                  period,
                  timezone,
                  canonicalTz
                );
                if (v24) setTimeLocal(v24);
              }}
              disabled={busy || !enabled}
            >
              <SelectItem value="AM" text="AM" />
              <SelectItem value="PM" text="PM" />
            </TimePickerSelect>
            <TimePickerSelect
              id="cm-schedule-time-zone"
              labelText="Timezone"
              value={timezone}
              onChange={(e) => {
                const newTz = e.target.value;
                // Re-derive the display time in the new timezone from the
                // current stored value so the field updates immediately
                // when the user switches zones.
                const { display, period } = canonicalToDisplay(
                  timeLocal,
                  newTz,
                  canonicalTz
                );
                onTimezoneChange(newTz);
                setTimeDisplay(display);
                setTimePeriod(period);
              }}
              disabled={busy || !enabled}
            >
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz.value} value={tz.value} text={tz.label} />
              ))}
            </TimePickerSelect>
          </TimePicker>

          {/*
            maxPRs/daysBack are intentionally not editable here. The scheduled
            run uses the same GITHUB_AI_AGENT_MAX_PRS / _DAYS_BACK limits as
            the manual "Review latest" button — threading a per-schedule
            override through reviewPRs would require changes to the most
            load-bearing code in the project for no additional capability the
            user asked for.
          */}
          <div className="cm-schedule-panel__readonly">
            <p className="cm-schedule-panel__readonly-label">Target</p>
            <p className="cm-schedule-panel__readonly-value">
              {targetWindowText(maxPRs, daysBack) || 'Loading…'}
            </p>
          </div>
        </div>

        <div className="cm-button-row">
          <Button
            type="submit"
            disabled={busy || (enabled && Boolean(timeError)) || !isDirty}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </Button>

          <Button
            kind="secondary"
            onClick={handleDiscard}
            disabled={!isDirty || busy}
          >
            Discard changes
          </Button>

          {schedule?.enabled &&
            (paused ? (
              <Button
                kind="primary"
                onClick={handlePauseToggle}
                disabled={pauseBusy}
              >
                {pauseBusy ? 'Resuming…' : 'Resume schedule'}
              </Button>
            ) : (
              <Button
                kind="ghost"
                onClick={handlePauseToggle}
                disabled={pauseBusy}
              >
                {pauseBusy ? 'Pausing…' : 'Pause schedule'}
              </Button>
            ))}

          {/*
            Spelled out in text, not colour alone (WCAG 1.4.1) — matching the
            project's existing pattern for a state that must not depend on
            colour perception (see McpConnectionPanel's sign-out hint).
          */}
          {isDirty && (
            <span className="cm-schedule-panel__unsaved" role="status">
              <WarningFilled size={16} aria-hidden="true" />
              Unsaved changes
            </span>
          )}
        </div>
      </form>

      {/* Status read-out — shown only when there is something to report.
          Times are shown in the user's selected timezone, not hardcoded ET. */}
      {schedule && (
        <div className="cm-schedule-panel__status">
          <dl className="cm-definition-list">
            <dt>Last scheduled run</dt>
            <dd>
              {schedule.lastRunAt
                ? toLocalTz(schedule.lastRunAt, timezone)
                : 'Never'}
            </dd>

            <dt>Next scheduled run</dt>
            <dd>
              {schedule.enabled && schedule.nextRunAt
                ? toLocalTz(schedule.nextRunAt, timezone)
                : schedule.enabled
                  ? 'Calculating…'
                  : 'Scheduling disabled'}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}

export default SchedulePanel;
