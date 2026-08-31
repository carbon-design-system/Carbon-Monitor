/**
 * Shared PR-count phrasing.
 *
 * Both the Reviews tile (Console.jsx) and the Schedule tab (SchedulePanel.jsx)
 * describe the same server-owned target criteria — GITHUB_AI_AGENT_MAX_PRS and
 * GITHUB_AI_AGENT_DAYS_BACK — since a scheduled run uses the identical limits
 * as a manual "Review latest" click. Centralised here so the wording cannot
 * drift between the two places that state it.
 */

/**
 * "1 pull request" / "3 pull requests".
 *
 * Worth the helper because GITHUB_AI_AGENT_MAX_PRS is genuinely set to 1 in some
 * deployments, where a hardcoded plural reads as a bug in the limit itself.
 */
export function pluralPRs(count) {
  return `${count} pull request${count === 1 ? '' : 's'}`;
}

/**
 * "Up to 10 pull requests opened in the last 21 days".
 *
 * Returns null when either limit has not loaded yet (both are null before
 * GET /api/config answers), so a caller can fall back to a loading state
 * instead of describing a number the console has not actually been told.
 *
 * @param {number|null} maxPRs
 * @param {number|null} daysBack
 * @returns {string|null}
 */
export function targetWindowText(maxPRs, daysBack) {
  if (maxPRs == null || daysBack == null) return null;
  return `Up to ${pluralPRs(maxPRs)} opened in the last ${daysBack} days`;
}

/**
 * Label for the explicit "Review …" button. Names a single PR, but collapses a
 * longer selection to a count so the button stays a fixed size instead of
 * growing with the numbers entered.
 *
 * @param {number[]} prNumbers
 * @returns {string}
 */
export function reviewButtonLabel(prNumbers) {
  if (!prNumbers || prNumbers.length === 0) return 'Review listed PRs';
  if (prNumbers.length === 1) return `Review #${prNumbers[0]}`;
  return `Review ${prNumbers.length} listed PRs`;
}
