# Contributing to Carbon Monitor

## Prerequisites

- Node.js >= 22.15.0
- Bob Shell
- For deploys only: zsh, podman, the ibmcloud CLI with the `code-engine` and `container-registry` plugins, and kubectl

## Setup

```bash
cp .env.example .env   # fill in credentials; see the comments in the file
npm install
```

## Run locally

```bash
npm run build:client && npm run api   # console + API on http://localhost:3000
npm start -- --pr <number>            # review a single PR from the CLI
```

## Tests

```bash
npm run test:all
```

## Deploy

`./deploy_ce.sh` reads everything it needs from `.env`. See README → Deployment.

## Pull requests

- Branch from `main`.
- Run the tests before you push.
- Keep changes focused: one concern per pull request.
- Never commit secrets or `.env`.
- Say why in the description, not just what changed.

## Conduct

This project follows the Carbon Design System code of conduct: https://github.com/carbon-design-system/.github
