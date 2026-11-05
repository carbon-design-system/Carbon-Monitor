import React from 'react';
import { Tag } from '@carbon/react';
import { tagTypeFor } from '../utils/prRefs';

// The repo name is the tag text, so the colour is a convenience and never the
// only way to tell two repositories apart.
function RepoTag({ repo, repos }) {
  return (
    <Tag as="span" size="sm" type={tagTypeFor(repo, repos)}>
      {repo}
    </Tag>
  );
}

export default RepoTag;
