# Runbook: security incident and personal-data breach

A breach is any loss of confidentiality, integrity or availability of personal data: a leaked database URL or backup, an exposed operator key, a console session forged, a tenant reading another tenant's rows. Vulnerability reports arrive through `SECURITY.md`. Record every incident, including ones that need no notification, in the private register ("Incidents").

## The clock

Start it when we have reasonable certainty that personal data was affected ("aware"), not when the investigation ends.

- **72 hours** from aware: notify the supervisory authority (GDPR Art. 33), unless the breach is unlikely to result in a risk to people. With no EU establishment and no representative yet, that means the data protection authority of each EU/EEA member state, and the UK ICO, where affected users live.
- **Without undue delay:** the UAE Data Office (PDPL Art. 9).
- **Without undue delay, to affected users**, when the risk to them is high (GDPR Art. 34): an email or console notice in plain words.
- Not everything known at 72 hours? Notify with what is known and follow up in phases.

## Steps

1. **Contain** (first hour). Pick what applies:
   - Leaked tenant key: revoke it, `POST /v1/keys/<id>/revoke`. Leaked operator key: issue a new one, swap it in Railway, revoke the old one.
   - Database credentials: rotate the Supabase password, update `DATABASE_URL` on the engine and `REIN_BACKUP_DATABASE_URL` in GitHub secrets, redeploy.
   - Console: rotate `REIN_CONSOLE_SESSION_SECRET` (signs every session out), and `REIN_GITHUB_CLIENT_SECRET` if the OAuth app is involved.
   - Other secrets: `REIN_TELEGRAM_BOT_TOKEN`, RPC keys, the backup repo token -- rotate whatever was exposed. The engine signing key: follow DEPLOY.md before touching it; a new key starts a new chain.
   - An agent spending badly: freeze it, `POST /v1/agents/<id>/freeze`.
2. **Preserve evidence** before it expires: export the Railway logs for the window, `GET /v1/chain/verify`, the relevant rows. Railway's log retention is short.
3. **Assess** in the register: what data, whose, how many people, since when, how it happened, whether the decision chain still verifies.
4. **Decide on notification.** Risk unlikely: record why and stop. Otherwise notify per "The clock", using each authority's online form. Include: what happened, data categories and approximate number of people, likely consequences, what we did, the contact (reinconsole@proton.me).
5. **Fix the cause**, add a regression test, and add an entry to SECURITY.md "Review history" if the fix is in code.
6. **Close** the register entry with the timeline: aware, contained, notified (whom, when), fixed.

When in doubt whether to notify, notify. A late notification is a finding in itself.
