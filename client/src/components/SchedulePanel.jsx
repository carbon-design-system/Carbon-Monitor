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
 * Format a UTC ISO string for display in a given IANA timezone.
 *
 * Defaults to America/New_York (ET) so existing call sites with no second
 * argument are unaffected. When a user-selected timezone is passed, the
 * displayed time and abbreviation reflect that zone instead.
 *
 * @param {string|null} isoString
 * @param {string} [tz='America/New_York']
 * @returns {string|null}
 */
export function toLocalTz(isoString, tz = 'America/New_York') {
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
    // fall back to ET so the display is always a valid time string.
    try {
      return new Date(isoString).toLocaleString('en-US', {
        timeZone: 'America/New_York',
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

/** @deprecated Use toLocalTz instead. Kept for any external callers. */
export const toET = (isoString) => toLocalTz(isoString, 'America/New_York');

/**
 * Scheduled reviews settings panel.
 *
 * Rendered inside the Settings modal's "Scheduled reviews" tab. Provides:
 *   - Toggle to enable/disable the daily run
 *   - Time input (HH:MM, ET)
 *   - Read-only display of the effective max PRs (from server config)
 *   - Status read-out: last run, next run, skip warning
 *
 * All times are displayed and described in Eastern Time so they match the
 * value the operator entered.
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
  { value: 'America/New_York',    label: 'Eastern Time (ET)'        },
  { value: 'America/Chicago',     label: 'Central Time (CT)'        },
  { value: 'America/Denver',      label: 'Mountain Time (MT)'       },
  { value: 'America/Phoenix',     label: 'Mountain Time – AZ (MST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)'        },
  { value: 'America/Anchorage',   label: 'Alaska Time (AKT)'        },
  { value: 'Pacific/Honolulu',    label: 'Hawaii Time (HT)'         },
  { value: 'America/Sao_Paulo',   label: 'Brasília Time (BRT)'      },
  { value: 'Europe/London',       label: 'London (GMT/BST)'         },
  { value: 'Europe/Paris',        label: 'Central European (CET)'   },
  { value: 'Europe/Helsinki',     label: 'Eastern European (EET)'   },
  { value: 'Asia/Dubai',          label: 'Gulf Time (GST)'          },
  { value: 'Asia/Kolkata',        label: 'India (IST)'              },
  { value: 'Asia/Bangkok',        label: 'Indochina (ICT)'          },
  { value: 'Asia/Shanghai',       label: 'China (CST)'              },
  { value: 'Asia/Tokyo',          label: 'Japan (JST)'              },
  { value: 'Australia/Sydney',    label: 'Sydney (AEST/AEDT)'       },
  { value: 'Pacific/Auckland',    label: 'New Zealand (NZST/NZDT)'  },
];

/**
 * Detect the browser's IANA timezone and return its value from TIMEZONES,
 * falling back to 'America/New_York' if not in the list.
 */
export function detectBrowserTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.find((z) => z.value === tz)?.value ?? 'America/New_York';
  } catch (_) {
    return 'America/New_York';
  }
}

// ── Time conversion helpers ───────────────────────────────────────────────────

/**
 * Convert a 24-hour ET "HH:MM" string to a wall-clock time in the given
 * IANA timezone, returned as { display: "h:mm", period: "AM"|"PM" }.
 *
 * Uses a fixed reference date (2000-01-05, a Wednesday in standard time) so
 * the conversion is deterministic and not affected by DST on today's date.
 * This is intentional: the schedule fires at a fixed clock time year-round,
 * so what matters is the operator's mental model of "9 AM my time", not a
 * DST-adjusted equivalent.
 */
function etToLocalDisplay(etHHMM, targetTz) {
  if (!etHHMM || !/^\d{2}:\d{2}$/.test(etHHMM)) return { display: '9:00', period: 'AM' };
  try {
    // Build a Date whose UTC value represents etHHMM in America/New_York.
    // We parse "2000-01-05T{HH}:{MM}:00" as ET by finding the ET→UTC offset
    // for that instant, then adjusting.
    const [hStr, mStr] = etHHMM.split(':');
    // ET UTC offset in January (standard time) is -5h = -18000000ms.
    const etOffsetMs = -5 * 60 * 60 * 1000;
    const utcMs = Date.UTC(2000, 0, 5, Number(hStr), Number(mStr), 0) - etOffsetMs;
    const d = new Date(utcMs);

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(d);

    const hourPart   = parts.find((p) => p.type === 'hour')?.value   ?? '9';
    const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const dayPeriod  = parts.find((p) => p.type === 'dayPeriod')?.value?.toUpperCase() ?? 'AM';
    const period = dayPeriod.startsWith('P') ? 'PM' : 'AM';

    return { display: `${Number(hourPart)}:${minutePart}`, period };
  } catch (_) {
    return { display: '9:00', period: 'AM' };
  }
}

/**
 * Convert a 12-hour display time in a given IANA timezone back to a
 * 24-hour ET "HH:MM" string.
 * Returns null when the display value is not a valid time.
 */
function localDisplayToET(display, period, sourceTz) {
  if (!display || !/^\d{1,2}:\d{2}$/.test(display)) return null;
  let [h, m] = display.split(':').map(Number);
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;

  // Convert 12-hour → 24-hour in the source timezone.
  if (period === 'AM') { h = h === 12 ? 0 : h; }
  else                 { h = h === 12 ? 12 : h + 12; }

  try {
    // Build a Date at 2000-01-05 h:m in sourceTz, then read it back as ET.
    // Find sourceTz offset by comparing UTC to local for a known instant.
    const refUtcMs = Date.UTC(2000, 0, 5, 12, 0, 0); // noon UTC, unambiguous
    const localNoon = new Intl.DateTimeFormat('en-CA', {
      timeZone: sourceTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(refUtcMs));
    const get = (type) => Number(localNoon.find((p) => p.type === type)?.value ?? 0);
    const localNoonMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const srcOffsetMs = refUtcMs - localNoonMs; // UTC = local + offset

    // Build the local time as UTC.
    const utcMs = Date.UTC(2000, 0, 5, h, m, 0) + srcOffsetMs;

    // Read it back as ET (January = -5h offset).
    const etOffsetMs = -5 * 60 * 60 * 1000;
    const etMs = utcMs + etOffsetMs;
    const etDate = new Date(etMs);
    const etH = etDate.getUTCHours();
    const etM = etDate.getUTCMinutes();
    return `${String(etH).padStart(2, '0')}:${String(etM).padStart(2, '0')}`;
  } catch (_) {
    // Fallback: if Intl conversion fails, treat source as ET.
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

function SchedulePanel({ schedule, config, onChanged, timezone, onTimezoneChange, resetKey }) {
  // Local form state — initialised from the server's current values.
  // Using separate pieces of state (not mirroring the whole schedule object)
  // so a partial edit does not mutate the prop.
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [timeEST, setTimeEST] = useState(schedule?.timeEST ?? '09:00');

  // 12-hour display state derived from the stored ET value converted to the
  // selected timezone (lifted to Console, received as a prop).
  const [timeDisplay, setTimeDisplay] = useState(
    () => etToLocalDisplay(schedule?.timeEST ?? '09:00', timezone).display
  );
  const [timePeriod, setTimePeriod] = useState(
    () => etToLocalDisplay(schedule?.timeEST ?? '09:00', timezone).period
  );

  // A null means the display field is incomplete/invalid.
  const timeError = !localDisplayToET(timeDisplay, timePeriod, timezone)
    ? 'Enter a valid time'
    : null;

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // The last-saved values, used both to detect unsaved edits and to reset the
  // form on "Discard changes". Deliberately just `enabled` + `timeEST` — the
  // two fields that are actually persisted by POST /api/schedule. Timezone is
  // excluded on purpose: it has no persisted field of its own (see
  // onTimezoneChange below), so switching zones must never read as an
  // unsaved change.
  const [savedEnabled, setSavedEnabled] = useState(schedule?.enabled ?? false);
  const [savedTimeEST, setSavedTimeEST] = useState(schedule?.timeEST ?? '09:00');

  const isDirty = enabled !== savedEnabled || timeEST !== savedTimeEST;

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
    const synced24 = schedule?.timeEST ?? '09:00';
    const { display, period } = etToLocalDisplay(synced24, timezone);
    setTimeEST(synced24);
    setTimeDisplay(display);
    setTimePeriod(period);
    setSavedEnabled(schedule?.enabled ?? false);
    setSavedTimeEST(synced24);
  }

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    // Convert the display time in the selected timezone back to ET for storage.
    const value24 = localDisplayToET(timeDisplay, timePeriod, timezone);
    const finalTimeEST = value24 ?? timeEST;
    try {
      await api.setSchedule({ enabled, timeEST: finalTimeEST });
      setSavedEnabled(enabled);
      setSavedTimeEST(finalTimeEST);
      setMessage({ kind: 'success', title: 'Schedule saved' });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', title: 'Could not save schedule', subtitle: err.message });
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
    setTimeEST(savedTimeEST);
    const { display, period } = etToLocalDisplay(savedTimeEST, timezone);
    setTimeDisplay(display);
    setTimePeriod(period);
    setMessage(null);
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

      {schedule?.lastRunSkipped && (
        <InlineNotification
          kind="warning"
          title="Last scheduled run was skipped"
          subtitle={schedule.lastSkipReason || 'A manual review was in flight at the scheduled time.'}
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
              const v24 = localDisplayToET(display, timePeriod, timezone);
              if (v24) setTimeEST(v24);
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
                const v24 = localDisplayToET(timeDisplay, period, timezone);
                if (v24) setTimeEST(v24);
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
                // current stored ET value so the field updates immediately
                // when the user switches zones.
                const { display, period } = etToLocalDisplay(timeEST, newTz);
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

          <Button kind="secondary" onClick={handleDiscard} disabled={!isDirty || busy}>
            Discard changes
          </Button>

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
            <dd>{schedule.lastRunAt ? toLocalTz(schedule.lastRunAt, timezone) : 'Never'}</dd>

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
