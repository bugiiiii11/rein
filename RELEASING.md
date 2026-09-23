# Releasing

The 11 `@reinconsole/*` packages publish from `.github/workflows/release.yml` with npm Trusted
Publishing (OIDC). No npm token exists in the repo, its secrets, or the workflow: npm trusts that
one workflow file, running in the GitHub environment `release`, per package.

## One-time setup

### GitHub (done 2026-09-23)

Environment `release` at https://github.com/bugiiiii11/rein/settings/environments -- required
reviewer `bugiiiii11`, deployment limited to branch `main` and tags `v*`.

### npmjs.com -- once per package, 11 times

Packages: `core`, `sdk`, `gate`, `policy-engine`, `graph`, `erc8004`, `mock-rails`, `x402-rails`,
`mcp`, `signer`, `store`.

1. Sign in to https://www.npmjs.com as the account that owns the `@reinconsole` scope.
2. Open `https://www.npmjs.com/package/@reinconsole/<package>/access` -- the package's **Settings**
   tab (for example https://www.npmjs.com/package/@reinconsole/core/access).
3. In the **Trusted Publisher** section, under **Select your publisher**, click **GitHub Actions**.
4. Fill in exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `bugiiiii11` |
   | Repository | `rein` |
   | Workflow filename | `release.yml` (file name only, no `.github/workflows/` path) |
   | Environment name | `release` |
   | Allowed actions (if shown) | `npm publish` |

5. Click **Save** / **Add trusted publisher**. Your security key may be asked for (2FA).
6. Do NOT change **Publishing access** yet (see "After the first OIDC publish").

npm does not validate these fields when you save. A typo shows up only when a publish fails, and
each package fails on its own, so check every one against the table. A wrong value surfaces as
`ENEEDAUTH` or a 404/403 on `PUT` for that package in the workflow's Publish step.

Renaming `release.yml` or the `release` environment breaks the trust for all 11 packages until
npmjs.com is updated to match.

## Cutting a release

1. Bump every publishable package to the same version (a prerelease such as `0.3.0-rc.1` is fine)
   and push to `main` with CI green.
2. Rehearse: Actions -> Release -> Run workflow (dry run is the default) -> approve the pending
   deployment. It builds, typechecks, tests, smoke-tests, then `npm publish --dry-run`s all 11.
3. Tag and push: `git tag v0.3.0-rc.1 && git push origin v0.3.0-rc.1`, then approve the run.
   The tag must equal every package version or the run fails before publishing anything.
4. A prerelease goes under the `next` dist-tag and never under `latest`. Promote later with
   `npm dist-tag add @reinconsole/<package>@<version> latest` per package.

A run that fails partway is finished by re-running it: versions already on the registry are
skipped, and publishing is in dependency order and stops at the first failure.

## After the first OIDC publish

Once one release has published all 11 packages through the workflow, on each package's **Settings**
tab under **Publishing access** select **Require two-factor authentication and disallow tokens**,
then let the granular npm token expire (2026-12-08) or revoke it. From then on the workflow is the
only way to publish.
