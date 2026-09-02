# Deployment

Flag Tag deploys to a Decentraland **World**, not Genesis City. The target realm is `flagtag.dcl.eth`.

---

## Prerequisites

- Node.js 24+, npm 9+
- Deploy permission on the World (owner or authorized signer of `flagtag.dcl.eth`)
- A local Decentraland identity (the SDK CLI will open a browser to sign if needed)
- A green `npm run test` and `npm run lint`

---

## Deploy

```bash
npm run build           # verify a clean compile
npm run test            # regression suite must pass
npm run deploy          # publishes to flagtag.dcl.eth
```

`sdk-commands deploy` reads the World target from `scene.json` (`worldConfiguration.name`) and uses your Decentraland identity to sign the deployment.

---

## What Actually Ships

The deploy uploads everything in the scene root **except** what's listed in `.dclignore`. That currently excludes:

- `node_modules/`
- `docs/`, `meeting-notes/`
- `test/`, `scripts/`, `logs/`, `bin/tests/`
- Editor + version-control metadata
- Stray `.log` and `nul` files

Confirm the shipped tree with:

```bash
sdk-commands build --skip-install
ls bin/
```

`bin/index.js` is the only compiled entry that ends up on-chain; everything else is served as static assets.

---

## Post-Deploy Verification

1. **Load the world:** `https://play.decentraland.org/?realm=flagtag.dcl.eth`
2. **Check server logs:** `npm run server-logs`
3. Confirm the server booted (`[Main] ✅ Server setup complete`) and the round manager is ticking.
4. Walk in, grab the flag, throw a boomerang — confirm end-to-end.

---

## Rolling Back

Decentraland deployments are immutable — a "rollback" is really "redeploy an earlier commit."

```bash
git checkout <previous-known-good-sha>
npm ci
npm run deploy
```

⚠️ **Persistence is one-way past the `player:{addr}` migration.** See [STORAGE.md](STORAGE.md) — do not redeploy a commit from before that migration against the current storage doc, or you will corrupt player wallets.

---

## Secrets & Environment

`.env` (gitignored) holds any local secrets for analytics or Discord reporting. The server reads them at boot via SDK env APIs. Never commit `.env`. When rotating keys, redeploy — env values are baked in at build time for the server bundle.

---

## SDK Upgrades

The scene tracks the `@dcl/sdk@auth-server` branch. To upgrade:

```bash
npm run upgrade-sdk
npm run build
npm run test:cli
npm audit
```

The `overrides` block in `package.json` patches vulnerable transitive dependencies (esbuild, undici, cookie, protobufjs). Expect to revisit these on every SDK bump — if `npm audit` flags new issues, add or update the override rather than downgrading the SDK.

---

## CI (recommended baseline)

If/when we wire GitHub Actions, the required-green checks are:

```bash
npm ci
npm run lint
npm run test
npm run build
npm run test:dependencies
```

Deploys should be manual-only (workflow_dispatch) — the World is public 24/7 and there is no staging environment.
