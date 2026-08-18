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
            <AccordionItem title="A — Pre-checks" open>
              <p>Four tiles across the top. All must be green before a review can run.</p>
              <ul className="cm-help__list">
                <li><strong>Bob Shell CLI</strong> — the AI agent. Green means it is installed and has an API key.</li>
                <li><strong>Carbon MCP</strong> — the Carbon docs and tools the agent checks its facts against. Green means connected, with its token refreshing on its own.</li>
                <li><strong>GitHub</strong> — access to the repository. Green means the token works and can read and label pull requests. It also shows how many API calls are left for the hour.</li>
                <li><strong>ElasticDB</strong> — where run telemetry is stored (optional). Green means connected.</li>
              </ul>
              <p>If a tile is red or amber, fix that first — reviews fail when a check is down.</p>
            </AccordionItem>

            <AccordionItem title="B — Reviews" open>
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
            <AccordionItem title="G — Connection status" open>
              <p>The Carbon MCP connection at a glance.</p>
              <ul className="cm-help__list">
                <li><strong>Status</strong> — whether it is connected.</li>
                <li><strong>Renewal</strong> — how the token stays fresh. &ldquo;Automatic&rdquo; means the app refreshes it for you.</li>
                <li><strong>Cached token</strong> — time left before the current token expires.</li>
                <li><strong>Agent</strong> — &ldquo;AI agent ready for queries&rdquo; means it is working.</li>
                <li><strong>Last refresh / Server</strong> — when the token last renewed, and the MCP server address.</li>
              </ul>
            </AccordionItem>

            <AccordionItem title="H — Connection actions" open>
              <ul className="cm-help__list">
                <li><strong>Sign in with IBMid</strong> — connect or reconnect Carbon MCP. Do this once; the app keeps it refreshed after.</li>
                <li><strong>Test connection</strong> — check the connection is live right now.</li>
                <li><strong>Refresh now</strong> — force a token refresh.</li>
                <li><strong>Sign out</strong> — disconnect Carbon MCP.</li>
              </ul>
            </AccordionItem>

            <AccordionItem title="I — Enter credentials manually" open>
              <p>
                Expand this to paste a bearer token and session ID instead of
                signing in with IBMid. It is a fallback for when IBMid sign-in is
                not available.
              </p>
            </AccordionItem>
          </Accordion>
        </div>
      </Content>
    </Theme>
  );
}

export default HelpGuide;
