import React, { useState } from 'react';
import {
  AILabel,
  AILabelContent,
  AILabelActions,
  Button,
  Modal,
} from '@carbon/react';

/**
 * The AI disclosure for the whole console.
 *
 * Carbon's AILabel is the system's standard marker for "an AI produced what you
 * are looking at". Everything of consequence on this page — the findings posted
 * to a pull request, the review verdicts — comes out of an agent, so the label
 * belongs to the product rather than to any one tile, which is why it sits in
 * the header's global bar.
 *
 * The toggletip carries the short answer. The long one lives behind a modal
 * because the end-to-end pipeline takes several sentences and a toggletip that
 * long is unreadable — and, being a popover, it closes the moment the operator
 * scrolls to finish it.
 *
 * The AILabelActions button is a plain text <Button>, not the IconButton row the
 * Carbon storybook example shows: @carbon/icons-react is off limits in this
 * project, so affordances are labelled with words. AILabel and CopyButton carry
 * their own icons internally, which is why they are usable here at all.
 */
function AboutAi() {
  const [open, setOpen] = useState(false);

  return (
    <div className="cm-header-ai">
      <AILabel
        // Not `inline`: that variant is designed to sit within a line of text
        // beside the value it qualifies. This one qualifies the application.
        kind="default"
        size="md"
        aiText="AI"
        // No `aria-label` here, deliberately. AILabel composes the button's
        // accessible name as `${aiText} ${slugLabel || ariaLabel}`, and
        // `slugLabel` — deprecated, but still defaulted to "Show information" —
        // shadows `aria-label` unless it is explicitly emptied. Passing an
        // aria-label that is silently discarded would be worse than none, and
        // the resulting default, "AI Show information", is accurate: there is
        // one of these on the page and showing information is what it does.
        // autoAlign flips the callout when it would overflow. The label sits at
        // the right edge of a fixed header, so an unflipped popover would open
        // off the side of the viewport.
        autoAlign
        align="bottom-end"
      >
        <AILabelContent>
          <p className="cm-ai-callout__title">AI-assisted pull request review</p>
          <p>
            Carbon Monitor reviews pull requests with an AI agent, Bob Shell. Before
            it posts anything, every Carbon-specific claim is checked against the
            Carbon Builder skill and the Carbon MCP server, so guidance quoted in a
            review comes from Carbon’s own documentation rather than the model’s
            recollection of it.
          </p>
          <p>
            Findings are posted back to the pull request as inline comments plus a
            summary.
          </p>
          <AILabelActions>
            <Button onClick={() => setOpen(true)}>How it works</Button>
          </AILabelActions>
        </AILabelContent>
      </AILabel>

      {/*
        passiveModal: this explains, it does not ask. A passive modal renders no
        footer at all, so there is no primary button implying a decision and
        nothing to style as destructive.

        `size="sm"` keeps the measure readable — Carbon's default modal content
        column is wide enough that prose runs past a comfortable line length.
      */}
      <Modal
        open={open}
        onRequestClose={() => setOpen(false)}
        passiveModal
        size="sm"
        modalLabel="AI in Carbon Monitor"
        modalHeading="How a review is produced"
        aria-label="How a review is produced"
      >
        <p className="cm-modal__para">
          A run moves through six steps, and stops at the first one that fails.
        </p>

        {/* An ordered list, because the order is the content: each step consumes
            what the one before it produced. */}
        <ol className="cm-modal__steps">
          <li>
            <strong>Fetch pull requests.</strong> Either the numbers typed into the
            console, or the most recent open pull requests in the configured
            repository.
          </li>
          <li>
            <strong>Build a review bundle.</strong> The diff, the changed files and
            the surrounding context are assembled into a single prompt payload.
          </li>
          <li>
            <strong>Run the agent.</strong> Bob Shell reads the bundle and produces
            candidate findings.
          </li>
          <li>
            <strong>Verify Carbon claims.</strong> Anything the agent asserts about
            Carbon — a component, a prop, a token, an accessibility rule — is checked
            against the Carbon Builder skill and the Carbon MCP server. Claims that
            do not hold up are dropped before they reach the pull request.
          </li>
          <li>
            <strong>Parse findings.</strong> The surviving findings are mapped back to
            the exact file and line in the diff they refer to.
          </li>
          <li>
            <strong>Post comments and label.</strong> Inline comments land on those
            lines, a summary comment goes on the pull request, and the pull request is
            labelled as reviewed so it is not picked up twice.
          </li>
        </ol>

        <p className="cm-modal__para">
          Findings are generated by an AI model. Verification narrows what it can get
          wrong about Carbon; it does not make a finding correct about your codebase.
          Treat each one as a reviewer’s suggestion and apply your own judgement before
          acting on it.
        </p>
      </Modal>
    </div>
  );
}

export default AboutAi;
