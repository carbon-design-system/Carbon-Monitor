// Carbon Grid spans for the system-health tiles, so any count fills its rows.

/**
 * Spans for tile `index` of `count`. lg (16 columns) puts every tile on one row,
 * giving the columns that do not divide evenly to the first tiles; md (8) pairs
 * them and lets an odd last tile take the row; sm (4) stacks them.
 *
 * @returns {{ sm: number, md: number, lg: number }}
 */
export function healthTileSpans(index, count) {
  const base = Math.floor(16 / count);
  const lg = index < 16 % count ? base + 1 : base;
  const md = count % 2 === 1 && index === count - 1 ? 8 : 4;
  return { sm: 4, md, lg };
}
