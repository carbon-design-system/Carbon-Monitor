import React, { useEffect, useState } from 'react';
import { Modal, RadioTile, TileGroup } from '@carbon/react';
import RepoTag from './RepoTag';
import { joinList, relativeTime, stateSuffix } from '../utils/prRefs';

// "open in both repositories", "closed in all 3 repositories", "open in 1 of 3".
function stateSentence(number, matches) {
  const open = matches.filter((m) => m.state === 'open').length;
  const all = matches.length === 2 ? 'both' : `all ${matches.length}`;
  if (open === matches.length)
    return `Pull request #${number} is open in ${all} repositories.`;
  if (open === 0)
    return `Pull request #${number} exists in ${all} repositories and is closed in each.`;
  return `Pull request #${number} exists in ${matches.length} repositories and is open in ${open}.`;
}

/**
 * Asks which repository a typed number means, only when GitHub has it in more
 * than one and the open-PR rule cannot pick. No tile starts selected: a wrong
 * silent default would post a review on the wrong pull request.
 *
 * `collision` is { groups: [{ number, matches }], others, total, launcherLabel }
 * and stays set after the dialog closes so the fade-out keeps its content.
 * `onConfirm` receives { [number]: repo }.
 */
function CollisionDialog({
  open,
  collision,
  repos,
  onCancel,
  onConfirm,
  launcherButtonRef,
}) {
  const [chosen, setChosen] = useState({});

  // A new lookup starts with nothing chosen.
  useEffect(() => {
    setChosen({});
  }, [collision]);

  const groups = collision?.groups || [];
  const others = collision?.others || 0;
  const total = collision?.total || 0;
  const allChosen = groups.every((g) => chosen[g.number]);

  const heading =
    groups.length === 1
      ? `Which #${groups[0].number}?`
      : `Choose a repository for ${groups.length} pull requests`;

  let intro =
    groups.length === 1
      ? stateSentence(groups[0].number, groups[0].matches)
      : `Pull requests ${joinList(groups.map((g) => `#${g.number}`))} each exist in more than one repository.`;
  if (others === 1)
    intro +=
      ' The other pull request was found in one repository and needs nothing from you.';
  else if (others > 1)
    intro += ` The other ${others} were found in one repository each and need nothing from you.`;

  return (
    <Modal
      open={open}
      size="sm"
      modalLabel={collision?.launcherLabel || 'Review listed PRs'}
      modalHeading={heading}
      primaryButtonText={`Review ${total} ${total === 1 ? 'PR' : 'PRs'}`}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!allChosen}
      onRequestClose={onCancel}
      onSecondarySubmit={onCancel}
      onRequestSubmit={() => {
        if (allChosen) onConfirm(chosen);
      }}
      launcherButtonRef={launcherButtonRef}
    >
      <p>{intro}</p>
      {groups.map((group) => (
        <div className="cm-collision__group" key={group.number}>
          <TileGroup
            legend={`Pull request #${group.number}`}
            name={`cm-collision-${group.number}`}
            valueSelected={chosen[group.number] ?? ''}
            onChange={(repo) =>
              setChosen((prev) => ({ ...prev, [group.number]: repo }))
            }
          >
            {group.matches.map((match) => (
              <RadioTile
                key={match.repo}
                id={`cm-collision-${group.number}-${match.repo}`}
                value={match.repo}
              >
                <span className="cm-collision__tile-head">
                  <RepoTag repo={match.repo} repos={repos} />
                </span>
                <span className="cm-collision__title">{match.title}</span>
                <span className="cm-collision__meta">
                  {match.author ? `@${match.author} · ` : ''}opened{' '}
                  {relativeTime(match.createdAt)}
                  {stateSuffix(match)}
                </span>
              </RadioTile>
            ))}
          </TileGroup>
        </div>
      ))}
    </Modal>
  );
}

export default CollisionDialog;
