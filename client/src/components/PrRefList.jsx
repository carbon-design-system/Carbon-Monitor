import React from 'react';
import RepoTag from './RepoTag';
import { groupByRepo } from '../utils/prRefs';

// PR refs grouped by repo: a tag, then that repo's numbers. The numbers sit
// directly in the item, so the flex rules in styles.scss can wrap them.
function PrRefList({ refs, repos, label }) {
  return (
    <ul className="cm-pr-refs" aria-label={label}>
      {groupByRepo(refs, repos).map(({ repo, numbers }) => (
        <li key={repo} className="cm-pr-refs__group">
          <RepoTag repo={repo} repos={repos} />
          {numbers.map((n, i) => (
            <span key={n} className="cm-pr-refs__num">
              #{n}
              {i < numbers.length - 1 ? ',' : ''}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

export default PrRefList;
