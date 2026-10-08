# Runbook: erasure

What the privacy policy promises ("Your rights"): we delete the sign-in identity and any record that links the org to the person, so the decision log can no longer be connected to them. We keep the decision log, spending records and settlements (hash-linked; integrity and legal claims) and screening records (evidence a sanctions check ran -- GDPR Art. 17(3)(b) and (e)). Public chain data cannot be deleted by anyone.

Run it only after `data-subject-requests.md` step 2 (identity verified). Log every step in the private register.

## Where the identity lives

| Place | What | Action |
|---|---|---|
| `rein.api_keys`, the org's owner key | `name` = `owner:github:<id>` or `owner:eth:<address>`, also on a released org's revoked key | erased by step 2 |
| `rein.api_keys`, console session keys | `name` = `session:<identity>`, one per sign-in, deleted a day after they expire | erased by step 2 |
| Console session cookie (`rein_session`) | identity + GitHub username | nothing to do: in the user's browser, expires in 7 days; the engine refuses it once step 2 has run |
| `rein.screenings` | the owner's wallet, if they signed in with Ethereum | **keep** (legal obligation; say so in the reply) |
| Railway application logs | claim and session lines | nothing to do: expire with the plan's log retention; say so in the reply |
| Nightly backups (private backup repo) | full copies of the above | not rewritten; see "Backups" |

The GitHub username is never stored server-side. Agent wallets are pseudonymous and stay with the decision log; once no key names the person, they no longer link to them through us.

## Steps

1. **Write down the identity** exactly as the engine stores it: `github:<numeric user id>` (not the login, which can be renamed) or `eth:<lowercase address>`.
2. **Erase it** with the unscoped operator admin key:
   ```
   curl -s -X POST https://engine.reinconsole.com/v1/owners/erase      -H "authorization: Bearer $REIN_ENGINE_API_KEY" -H "content-type: application/json"      -d '{"identity":"github:<id>"}'
   ```
   A `404` means the engine predates the route (added after 0.6.1): redeploy it from `main` first.
   Every key whose name carries the identity is revoked and renamed to `owner:erased` / `session:erased` in one engine write each, persisted before it answers. The running engine forgets the name with the write: no SQL, no restart. The answer is `{ orgIds, owners, sessions }`; note it in the register. Zeros mean the engine never saw that identity, or it was already erased.
3. **Check:** `GET /v1/keys` with the same key shows no key named after the identity, and the orgs from step 2 hold an `owner:erased` key, revoked. Signing in with the erased identity shows no org.
4. **Reply** with what was deleted, what was kept and why, and the backup note below.

What erasure leaves: the org itself, its agents, policies, keys and decisions. With no live owner key it reads as unclaimed, so whoever holds its admin key (`rein-agent.json`) can claim it again. If the person also wants the org shut, revoke its keys as a separate step (`POST /v1/keys/<id>/revoke` per key) and say so in the register.

## Backups

Backups are kept indefinitely today (privacy policy: moving to a 90-day rolling retention). We do not rewrite them. If a backup is ever restored, re-run step 2 for every erasure in the register made after that backup's date, before the restored engine serves traffic.
