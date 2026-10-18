/******************************************************************************
 * Environment bootstrap
 *
 * Loads .env with { override: true } so the FILE — not a value that happens to
 * be exported in the shell — is the single source of truth for a local run.
 *
 * Why override, when dotenv's default is to leave an already-set variable alone:
 * the deploy path (deploy_ce.sh) mirrors credentials into the Code Engine secret
 * with `set -o allexport && source .env`, and sourcing OVERWRITES the shell. The
 * two loaders disagreeing is how a developer ends up exercising one GitHub
 * identity locally (a token exported in their shell) while shipping a different
 * one to cloud (the token in .env) — the exact split that let a read-only bot
 * pass every local health check and then fail the labelling step on every review
 * in production. Making dotenv authoritative here means `npm start`,
 * `npm run api`, the review subprocess, and a cloud deploy all run whatever
 * identity .env names — a common experience for testing.
 *
 * Safe in the container: .env is git-ignored, docker-ignored, and never COPYed
 * into the image, so there is no file to find at runtime. dotenv becomes a no-op
 * and the injected Code Engine secret stands untouched. override only changes
 * behaviour on a machine that actually has a .env — which is where we want it.
 *
 * Trade-off worth knowing: a one-off `GITHUB_AI_AGENT_TOKEN=… npm start` no
 * longer wins over .env. To test a different identity, change .env — the same
 * source of truth the deploy reads — so local and cloud can never silently
 * diverge again.
 *****************************************************************************/

// Tests spawn children with this set so a developer's .env cannot override theirs.
if (process.env.CARBON_MONITOR_SKIP_DOTENV !== '1') {
  require('dotenv').config({ override: true });
}
