#!/usr/bin/env node
/**
 * Stage IBM Plex fonts for the console build.
 *
 * Carbon's SCSS emits @font-face rules pointing at `~@ibm/plex/...`. The tilde is
 * webpack's node_modules escape hatch and means nothing to Vite, so those URLs
 * would ship unresolved and every glyph would fall back to a system font.
 *
 * styles.scss overrides Carbon's $font-path to `/plex`, and this script copies
 * the referenced files to client/public/plex so that path actually serves them.
 *
 * Self-hosted rather than loaded from the IBM CDN: the console then renders
 * correctly with no third-party request at all, which matters for a tool whose
 * whole job is telling an operator what is and is not reachable. The cost is
 * about 4 MB in the image.
 *
 * Only split/woff2 is copied — the format Carbon's default configuration
 * references. Copying `complete/` as well would multiply the size for files no
 * emitted rule asks for.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'node_modules', '@ibm', 'plex');
const DEST = path.join(ROOT, 'client', 'public', 'plex');

// The families Carbon enables by default.
const FAMILIES = ['IBM-Plex-Sans', 'IBM-Plex-Mono', 'IBM-Plex-Serif'];
const SUBPATH = path.join('fonts', 'split', 'woff2');

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(
      `[copy-plex-fonts] @ibm/plex not found at ${SOURCE}.\n` +
        '  Run `npm install` first — it arrives as a dependency of @carbon/react.'
    );
    process.exit(1);
  }

  // Rebuilt from scratch so a font removed upstream does not linger in the image.
  fs.rmSync(DEST, { recursive: true, force: true });

  let copied = 0;

  for (const family of FAMILIES) {
    const from = path.join(SOURCE, family, SUBPATH);
    const to = path.join(DEST, family, SUBPATH);

    if (!fs.existsSync(from)) {
      console.warn(`[copy-plex-fonts] skipping ${family} — not present in @ibm/plex`);
      continue;
    }

    fs.mkdirSync(to, { recursive: true });
    for (const file of fs.readdirSync(from)) {
      if (!file.endsWith('.woff2')) continue;
      fs.copyFileSync(path.join(from, file), path.join(to, file));
      copied += 1;
    }
  }

  if (copied === 0) {
    console.error('[copy-plex-fonts] no font files were copied — the console would render unstyled text.');
    process.exit(1);
  }

  console.log(`[copy-plex-fonts] staged ${copied} IBM Plex files into client/public/plex`);
}

main();
