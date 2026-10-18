#!/usr/bin/env node
/**
 * Ensures the carbon-builder skill is present at .bob/skills/carbon-builder/.
 *
 * Run automatically via the `postinstall` npm hook so every `npm install`
 * guarantees the skill is in place without any manual steps.
 *
 * If SKILL.md already exists the script exits immediately (no-op).
 * Otherwise it downloads the official zip from the Carbon Design System site,
 * extracts it using the central directory (handles data-descriptor entries),
 * and writes the files to .bob/skills/carbon-builder/.
 *
 * Never throws and never exits non-zero: it prints one line saying what it did
 * or why it skipped, so postinstall cannot fail an install.
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const SKILL_URL =
  'https://carbondesignsystem.com/developing/carbon-mcp/files/carbon-builder.zip';
const DEST_DIR = path.join(__dirname, '..', '.bob', 'skills');
const SKILL_MARKER = path.join(DEST_DIR, 'carbon-builder', 'SKILL.md');

// ── Central-directory ZIP parser ──────────────────────────────────────────────
// Many macOS-created zips set the data-descriptor flag (bit 3) which puts
// compSize/uncompSize after the data rather than in the local header.
// The central directory always has correct sizes, so we read it first,
// then use the local-header offsets to locate the compressed data.
//
// Central directory entry:
//   sig        4  0x02014b50
//   ...        6  (versions, flags, method)
//   method     2  offset 10
//   ...        8  (time, date, crc32)
//   comp sz    4  offset 20
//   uncomp sz  4  offset 24
//   name len   2  offset 28
//   extra len  2  offset 30
//   comment    2  offset 32
//   ...        8  (disk, attrs)
//   local hdr  4  offset 42  ← byte offset of local file header
//   name       <name len>
//
// Local file header:
//   sig        4  0x04034b50
//   ...        24
//   name len   2  offset 26
//   extra len  2  offset 28
//   name       <name len>
//   extra      <extra len>
//   data       <comp sz from central dir>

function parseCentralDirectory(buf) {
  // Find end-of-central-directory record (signature 0x06054b50)
  // Search from the end (comment may follow)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('ZIP end-of-central-directory not found');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const entries = [];

  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;

  while (pos < cdEnd) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;

    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    entries.push({ name, method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractEntry(buf, entry) {
  const lhNameLen = buf.readUInt16LE(entry.localOffset + 26);
  const lhExtraLen = buf.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
  const compData = buf.slice(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return compData; // stored
  if (entry.method === 8) return zlib.inflateRawSync(compData); // deflated
  throw new Error(`Unsupported ZIP method: ${entry.method}`);
}

// ── Download helper ───────────────────────────────────────────────────────────

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = (targetUrl) => {
      https
        .get(targetUrl, { timeout: 30_000 }, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(
              new Error(`HTTP ${res.statusCode} downloading skill zip`)
            );
          }
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('timeout', function () {
          this.destroy(new Error('timed out'));
        })
        .on('error', reject);
    };
    request(url);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const MANUAL = 'https://carbondesignsystem.com/developing/carbon-mcp/';

/** Install the skill and return the one line to print. */
async function install() {
  if (fs.existsSync(SKILL_MARKER)) {
    return 'carbon-builder skill: already present, nothing to download';
  }

  let zipBuffer;
  try {
    zipBuffer = await download(SKILL_URL);
  } catch (err) {
    return `carbon-builder skill: skipped, download failed (${err.message}); install manually from ${MANUAL}`;
  }

  let entries;
  try {
    entries = parseCentralDirectory(zipBuffer);
  } catch (err) {
    return `carbon-builder skill: skipped, could not read the zip (${err.message}); install manually from ${MANUAL}`;
  }

  // Determine the common prefix to strip (zip may wrap files in carbon-builder/)
  const fileEntries = entries.filter(
    (e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/')
  );
  if (fileEntries.length === 0) {
    return 'carbon-builder skill: skipped, the zip held no usable files';
  }

  const firstSegments = new Set(fileEntries.map((e) => e.name.split('/')[0]));
  const stripPrefix =
    firstSegments.size === 1 ? [...firstSegments][0] + '/' : '';

  let written = 0;
  let unreadable = 0;
  for (const entry of fileEntries) {
    const relativeName = stripPrefix
      ? entry.name.slice(stripPrefix.length)
      : entry.name;
    if (!relativeName) continue;

    const destPath = path.join(DEST_DIR, 'carbon-builder', relativeName);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, extractEntry(zipBuffer, entry));
      written++;
    } catch {
      unreadable++;
    }
  }

  if (!fs.existsSync(SKILL_MARKER)) {
    return `carbon-builder skill: wrote ${written} file(s) but SKILL.md is missing, the zip layout may have changed; install manually from ${MANUAL}`;
  }
  return (
    `carbon-builder skill: installed ${written} files at .bob/skills/carbon-builder/` +
    (unreadable ? ` (${unreadable} could not be extracted)` : '')
  );
}

install()
  .catch(
    (err) => `carbon-builder skill: skipped, unexpected error (${err.message})`
  )
  .then((line) => console.log(line));
