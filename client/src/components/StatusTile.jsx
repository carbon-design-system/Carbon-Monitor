import React from 'react';
import { Tile, preview__IconIndicator as IconIndicator } from '@carbon/react';

/**
 * One dependency's health.
 *
 * The server returns Carbon's own IconIndicator `kind` vocabulary
 * (succeeded / caution-major / failed / unknown), so a status maps straight
 * onto an indicator with no translation table to drift out of sync.
 *
 * IconIndicator is used rather than a coloured Tag because it pairs a shape with
 * the colour — the state stays legible without relying on colour perception.
 *
 * Its `label` prop IS the visible text beside the icon, not an accessible name
 * for it, so the tile does not print the label again beneath: doing so showed
 * every dependency's name twice and had screen readers announce it twice.
 */
function StatusTile({ label, status, detail, hint }) {
  return (
    <Tile className="cm-status-tile">
      <IconIndicator kind={status} label={label} size={20} />
      <div className="cm-status-tile__detail">{detail}</div>
      {hint && <div className="cm-status-tile__hint">{hint}</div>}
    </Tile>
  );
}

export default StatusTile;
