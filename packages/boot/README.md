# @reinconsole/boot

Boot-time container concerns for Rein's deployed services: take ownership of the
data volume, then drop from root to an unprivileged user, before anything opens
the database.

## Why this is a package, and why it is private

Two deployments need the identical sequence -- the console and the hosted engine
-- and the invariants inside it were bought with two outages (S59, S60): fail
soft rather than crash-loop a public page, and drop BEFORE the dynamic import
that opens PGlite. A copy in each service would put those two rules in two
places, which is exactly the shape of failure S53 recorded when `rein-engine`
composed a tier it never ran.

It is `private: true` on purpose. `scripts/package-smoke.mjs` packs every
NON-private workspace under `packages/` and `services/`, so this one is excluded
automatically and the published set stays at 11. That matters because this is
deployment plumbing for Rein's own containers, not API: publishing `chownTree`
and `dropPrivileges` would mean owning their semantics for self-hosters forever.

Being unpublished has one consequence worth knowing. `@reinconsole/store`
publishes its `bin/`, and the `rein-engine` bin drops privileges -- so it cannot
import this package by name, or an npm consumer would hit an unresolvable
specifier. `services/store/src/privileges.ts` re-exports this module and
`services/store/tsup.config.ts` names it in `noExternal`, so `dist/privileges.js`
lands self-contained. That is the one indirection; see the comments in both
files for why it is not optional.

See `src/privileges.ts` for the full account of why the chown has to happen
inside the container that will serve, and why an ENTRYPOINT cannot do it.
