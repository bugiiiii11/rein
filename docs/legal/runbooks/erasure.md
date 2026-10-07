# Runbook: erasure

What the privacy policy promises ("Your rights"): we delete the sign-in identity and any record that links the org to the person, so the decision log can no longer be connected to them. We keep the decision log, spending records and settlements (hash-linked; integrity and legal claims) and screening records (evidence a sanctions check ran -- GDPR Art. 17(3)(b) and (e)). Public chain data cannot be deleted by anyone.

Run it only after `data-subject-requests.md` step 2 (identity verified). Log every step in the private register.

## Where the identity lives

| Place | What | Action |
|---|---|---|
| `rein.api_keys`, the org's owner key | `name` = `owner:github:<id>` or `owner:eth:<address>` | revoke, then tombstone the name (below) |
| Console session cookie (`rein_session`) | identity + GitHub username | nothing to do: in the user's browser, expires in 7 days |
| `rein.screenings` | the owner's wallet, if they signed in with Ethereum | **keep** (legal obligation; say so in the reply) |
| Railway application logs | claim and session lines | nothing to do: expire with the plan's log retention; say so in the reply |
| Nightly backups (private backup repo) | full copies of the above | not rewritten; see "Backups" |

The GitHub username is never stored server-side. Agent wallets are pseudonymous and stay with the decision log; once the owner key no longer names the person, they no longer link to them through us.

## Steps

1. **Find the owner key.** `GET https://engine.reinconsole.com/v1/keys` with the unscoped operator key; note the `id` and `orgId` of the key whose name is `owner:<identity>`.
2. **Revoke it** through the API, so the revocation is persisted by the engine itself:
   `curl -s -X POST https://engine.reinconsole.com/v1/keys/<keyId>/revoke -H "authorization: Bearer $REIN_ENGINE_API_KEY"`
   A revoked key is never touched again (no `lastUsedAt` write-back), which is what makes step 3 safe on a running engine.
3. **Tombstone the name** in Supabase (project `phcdexxrwsgjnwdlhevk`, SQL editor):
   ```sql
   UPDATE rein.api_keys
      SET doc = jsonb_set(doc, '{name}', '"owner:erased"')
    WHERE id = '<keyId>' AND doc->>'name' = 'owner:<identity>';
   ```
   Exactly one row must change. The org then reads as claimed by `erased`: nobody can sign in to it and it cannot be claimed again.
4. **Restart the engine** in Railway (Deployments -> the active one -> Restart) so its in-memory key list reloads. The engine keeps keys in memory, and until a restart it still holds the old name.
5. **Check:** `GET /v1/keys` shows the key as `owner:erased` and revoked; signing in with the erased identity shows no org.
6. **Reply** with what was deleted, what was kept and why, and the backup note below.

## Backups

Backups are kept indefinitely today (privacy policy: moving to a 90-day rolling retention). We do not rewrite them. If a backup is ever restored, re-run steps 3-4 for every erasure in the register made after that backup's date, before the restored engine serves traffic.

## Open engineering ticket

The tombstone is manual SQL plus a restart. An operator route that revokes and tombstones in one engine call (no SQL, no restart) is tracked in `docs/legal/decisions.md`, "Still open".
