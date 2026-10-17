'use strict';

// ---------------------------------------------------------------------------
// escapeAtSign — prevent GitHub/Slack treating SCSS at-rules (@if, @mixin,
// etc.) as user mentions by inserting a zero-width space (U+200B) after each @.
// ---------------------------------------------------------------------------

/**
 * Inserts U+200B after @ in AI-generated text to prevent GitHub and Slack
 * from treating SCSS at-rules as user mentions. Skips content inside
 * backtick spans.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeAtSign(text) {
  if (!text) return text;
  // Split on inline code spans (`...`). Odd-indexed segments are inside
  // backticks and must not be modified; even-indexed are plain text.
  return text.split(/(`[^`]*`)/).map((seg, i) =>
    i % 2 === 0 ? seg.replace(/@(\w)/g, '@\u200B$1') : seg
  ).join('');
}

module.exports = { escapeAtSign };
