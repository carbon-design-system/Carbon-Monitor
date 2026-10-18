const { EFFECTIVE_REVIEW_CONCURRENCY } = require('../constants');

// reviewPRs reports through an onProgress callback so src/index.js never
// imports server state; the server and the scheduler both feed it into
// reviewState with these helpers.

/** Reset the progress fields when a batch claims reviewState. */
function startProgress(state, queued = []) {
  state.inFlight = [];
  state.queued = [...queued];
  state.concurrency = EFFECTIVE_REVIEW_CONCURRENCY;
}

/** Copy a { inFlight, queued, concurrency } snapshot from reviewPRs. */
function applyProgress(state, snapshot) {
  state.inFlight = snapshot.inFlight;
  state.queued = snapshot.queued;
  state.concurrency = snapshot.concurrency;
}

/** Clear what is running or waiting when the batch ends, however it ends. */
function endProgress(state) {
  state.inFlight = [];
  state.queued = [];
}

module.exports = { startProgress, applyProgress, endProgress };
