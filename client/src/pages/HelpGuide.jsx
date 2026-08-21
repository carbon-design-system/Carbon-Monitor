import React from 'react';
import {
  Theme,
  Header,
  HeaderName,
  Content,
  Accordion,
  AccordionItem,
} from '@carbon/react';
import mainImg from '../assets/carbon_monitor_screen.png';
import settingsImg from '../assets/settings.png';
import aiReviewedImg from '../assets/ai_reviewed_label.png';
import scheduleImg from '../assets/schedule_reviews2.png';

/**
 * Public help & usage guide, served at /help.
 *
 * Rendered before the auth gate in App.jsx so it opens in a new tab without a
 * sign-in — an operator reaches it from the header's Help (?) control. Content is
 * kept short and plain; the annotated screenshots carry the layout, and each
 * lettered badge on an image maps to the same letter in the accordions below it.
 */
function HelpGuide() {
  return (
    <Theme theme="g10">
      <Header aria-label="Carbon Monitor">
        <HeaderName href="/" prefix="">
          <span style={{ fontWeight: 100 }}>Carbon</span> Monitor
        </HeaderName>
      </Header>

      <Content className="cm-help">
        <div className="cm-help__inner">
          <h1 className="cm-help__title">Help &amp; usage guide</h1>
          <p className="cm-help__lede">
            Carbon Monitor runs an AI agent (Bob Shell) that reviews open pull
            requests in <code>carbon-design-system/carbon</code> and posts its
            findings back to GitHub. This guide walks through the screen. Each
            lettered badge on the images matches a letter below it.
          </p>

          {/* ── The main screen ─────────────────────────────────────────── */}
          <h2 className="cm-help__h2">The Operations screen</h2>
          <img
            className="cm-help__img"
            src={mainImg}
            alt="Carbon Monitor Operations screen, annotated with labels A through F."
          />

          <Accordion className="cm-help__accordion">
            <AccordionItem title="A — Pre-checks">
              <p>Four tiles across the top. All must be green before a review can run.</p>
              <ul className="cm-help__list">
                <li><strong>Bob Shell CLI</strong> — the AI agent. Green means it is installed and has an API key.</li>
                <li><strong>Carbon MCP</strong> — the Carbon docs and tools the agent checks its facts against. Green means connected, with its token refreshing on its own.</li>
                <li><strong>GitHub</strong> — access to the repository. Green means the token works and can read and label pull requests. It also shows how many API calls are left for the hour.</li>
                <li><strong>ElasticDB</strong> — where run telemetry is stored (optional). Green means connected.</li>
              </ul>
              <p>If a tile is red or amber, fix that first — reviews fail when a check is down.</p>
            </AccordionItem>

            <AccordionItem title="B — Reviews">
              <p>Start a review here, and see details of the last one.</p>
              <ul className="cm-help__list">
                <li><strong>State</strong> — Idle or Running.</li>
                <li><strong>Started / Finished / Last run</strong> — details of the most recent run.</li>
                <li><strong>Target</strong> — what a blank run reviews: up to 10 pull requests opened in the last 21 days.</li>
                <li><strong>Pull request numbers</strong> — type specific PR numbers, comma-separated, to review only those.</li>
                <li><strong>Review latest 10 PRs</strong> — reviews recent open PRs and ignores the box.</li>
                <li><strong>Review listed PRs</strong> — reviews only the numbers you typed (enabled once you type one).</li>
              </ul>
              <p>Only one review runs at a time.</p>
            </AccordionItem>

            <AccordionItem title="C — Bobcoins">
              <p>The agent&rsquo;s monthly budget. Shows how much is used and how much is left. Reviews stop if it runs out.</p>
            </AccordionItem>

            <AccordionItem title="D — Review output">
              <p>A live log of the current or last run. Watch progress, then copy, download, or clear the log.</p>
            </AccordionItem>

            <AccordionItem title="E — Spend &amp; recent reviews">
              <p>What past reviews cost, plus a per-pull-request history.</p>
            </AccordionItem>

            <AccordionItem title="F — Settings">
              <p>The gear icon (top right) opens the Carbon MCP connection panel — covered in the next section.</p>
            </AccordionItem>
          </Accordion>

          {/* ── Settings ────────────────────────────────────────────────── */}
          <h2 className="cm-help__h2">Settings &mdash; Carbon MCP connection</h2>
          <img
            className="cm-help__img"
            src={settingsImg}
            alt="Carbon Monitor Settings panel, annotated with labels G through I."
          />

          <Accordion className="cm-help__accordion">
            <AccordionItem title="G — Connection status">
              <p>The Carbon MCP connection at a glance.</p>
              <ul className="cm-help__list">
                <li><strong>Status</strong> — whether it is connected.</li>
                <li><strong>Renewal</strong> — how the token stays fresh. &ldquo;Automatic&rdquo; means the app refreshes it for you.</li>
                <li><strong>Cached token</strong> — time left before the current token expires.</li>
                <li><strong>Agent</strong> — &ldquo;AI agent ready for queries&rdquo; means it is working.</li>
                <li><strong>Last refresh / Server</strong> — when the token last renewed, and the MCP server address.</li>
              </ul>
            </AccordionItem>

            <AccordionItem title="H — Connection actions">
              <ul className="cm-help__list">
                <li><strong>Sign in with IBMid</strong> — connect or reconnect Carbon MCP. Do this once; the app keeps it refreshed after.</li>
                <li><strong>Test connection</strong> — check the connection is live right now.</li>
                <li><strong>Refresh now</strong> — force a token refresh.</li>
                <li><strong>Sign out</strong> — disconnect Carbon MCP.</li>
              </ul>
            </AccordionItem>

            <AccordionItem title="I — Enter credentials manually">
              <p>
                Expand this to paste a bearer token and session ID instead of
                signing in with IBMid. It is a fallback for when IBMid sign-in is
                not available.
              </p>
            </AccordionItem>
          </Accordion>

          {/* ── The AIReviewed label ────────────────────────────────────── */}
          <h2 className="cm-help__h2">The GitHub AIReviewed label</h2>
          <img
            className="cm-help__img cm-help__img--narrow"
            src={aiReviewedImg}
            alt="A GitHub pull request sidebar. In the Labels section, the AIReviewed label is highlighted with a purple box marked J."
          />

          <Accordion className="cm-help__accordion">
            <AccordionItem title="J — The GitHub AIReviewed label">
              <p>
                When Carbon Monitor finishes reviewing a pull request, it adds the{' '}
                <strong>AIReviewed</strong> label to it on GitHub (highlighted
                above). That label is how Carbon Monitor remembers which pull
                requests it has already handled.
              </p>
              <p>
                <strong>
                  Please do not add, remove, rename, or edit this label by hand.
                </strong>{' '}
                An automatic run skips any pull request that already carries it.
                Remove it and the pull request looks unreviewed again, so the next
                run reviews it a second time &mdash; spending Bobcoins and posting
                duplicate comments. Adding it to a pull request that was never
                reviewed has the opposite effect: that one is skipped and never
                reviewed.
              </p>
              <p>
                If a pull request genuinely needs another look, leave the label
                alone and use <strong>Review listed PRs</strong> on the Operations
                screen (B) &mdash; that reviews exactly the numbers you enter and
                ignores the label.
              </p>
            </AccordionItem>
          </Accordion>

          {/* ── Scheduled reviews ───────────────────────────────────────── */}
          <h2 className="cm-help__h2">Scheduled reviews</h2>
          <img
            className="cm-help__img"
            src={scheduleImg}
            alt="The Settings dialog on the Scheduled reviews tab, enabled, with callouts K through O marking the on/off toggle, the daily run time, the target, the save and discard buttons, and the last/next run status."
          />

          <Accordion className="cm-help__accordion">
            <AccordionItem title="K — Enable daily scheduled review">
              <p>
                Found under the gear (Settings) → Scheduled reviews tab. Turns the
                daily automatic review on or off. When On, Carbon Monitor runs a
                review by itself once a day at the time you set — it runs on the
                server, so the console does not need to be open. When Off, reviews
                happen only when you start one by hand.
              </p>
            </AccordionItem>

            <AccordionItem title="L — Daily run time">
              <p>When the daily run happens. Editable only while the schedule is On.</p>
              <ul className="cm-help__list">
                <li>Set the time and AM/PM, then pick the timezone the time is in.</li>
                <li>Timezone defaults to your browser&rsquo;s; change it to pin the run to another zone.</li>
                <li>It fires at the same clock time year-round — it does not shift for daylight saving.</li>
              </ul>
            </AccordionItem>

            <AccordionItem title="M — Target">
              <p>
                What each run reviews — the same set as{' '}
                <strong>Review latest 10 PRs</strong> on the Operations screen: up to
                10 pull requests opened in the last 21 days. Shown read-only; it
                follows the deployment&rsquo;s configured limits and is not changed here.
              </p>
            </AccordionItem>

            <AccordionItem title="N — Save &amp; discard changes">
              <p>
                <strong>Save changes</strong> stores the schedule and makes it active.{' '}
                <strong>Discard changes</strong> reverts the fields to the last saved
                values. Until you save, an <strong>Unsaved changes</strong> note shows
                and nothing is scheduled yet.
              </p>
            </AccordionItem>

            <AccordionItem title="O — Last &amp; next scheduled run">
              <p>
                When the schedule last ran and when it will run next. If a review is
                already running at the scheduled time, that day&rsquo;s run is skipped
                — only one review runs at a time — and a note tells you why.
              </p>
            </AccordionItem>
          </Accordion>

          {/* ── Troubleshooting ─────────────────────────────────────────── */}
          <h2 className="cm-help__h2">Troubleshooting</h2>
          <Accordion className="cm-help__accordion">
            <AccordionItem title="First thing to try — refresh and retry">
              <p>
                Carbon Monitor runs in the cloud, and cloud services have the
                occasional brief hiccup. If something looks wrong &mdash; a tile
                flips red, &ldquo;Sign in with IBMid&rdquo; does not respond, or a
                review will not start &mdash; it is very often a momentary blip
                rather than a real fault.
              </p>
              <p>
                <strong>
                  Refresh the browser (or reopen the page), wait a moment, and
                  try the same action again.
                </strong>{' '}
                A retry against a warm, idle service usually just works &mdash;
                this one low-tech step clears the large majority of intermittent
                issues.
              </p>
            </AccordionItem>

            <AccordionItem title="If the problem persists">
              <ul className="cm-help__list">
                <li>Refresh once more and give it a minute; two or three tries clears most transient issues.</li>
                <li>Check the four pre-check tiles at the top &mdash; if one is red or amber, fix that first, because reviews fail when a check is down.</li>
                <li>For the Carbon MCP tile, open Settings and use <strong>Test connection</strong>; if it is red, <strong>Sign in with IBMid</strong> again.</li>
                <li>If every retry still fails after a few minutes, it is more likely a real outage than a blip &mdash; check back shortly.</li>
              </ul>
            </AccordionItem>
          </Accordion>
        </div>
      </Content>
    </Theme>
  );
}

export default HelpGuide;
