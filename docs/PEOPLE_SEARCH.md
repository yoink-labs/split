# People search and the invitation inbox

Signed-in users can look up other Split accounts, for example to invite them to
a group. The directory is privacy-sensitive, so the Worker enforces these rules
(`worker/src/directory.ts`):

| Rule | Value |
| --- | --- |
| Fields returned | Opaque user ID, display name, avatar. Never email, username or phone. |
| Query | A full email address (exact match on the verified primary address), or a name prefix of at least 3 characters (start of the name or of any word in it). No substring or wildcard matching. |
| Results | At most 10 per query. You never see yourself. |
| Rate limit | 60 lookups per account per hour (search and profile views share it). Exceeding it returns 429. |
| Opt-out | **Let people find me** (Account), on by default. When off, the account is absent from search, cannot be invited by strangers, and its profile is visible only to people who already share a group. |
| Profile | Name, avatar and the groups the viewer *already* shares with that person. |
| Direct invitations | Only active group members can send them, at most 20 per sender per hour. They expire after 14 days. |

## Invitation inbox

`GET /v1/invitations` lists, for the signed-in account only:

- invitations sent to the account from people search (`direct_invites`), while the
  inviter is still an active member;
- email invitations (`invites.recipient_email`) addressed to the account's
  verified primary email.

Groups the account already belongs to are left out. The snapshot includes
`invitationCount` for the badge. `POST /v1/invitations/:id/accept|decline` only
matches invitations addressed to the caller, so another account gets a 404 and
learns nothing. An email invitation also rechecks the live verified address with
Clerk before claiming. Accepting reuses `claimSeat` to take over a linked
placeholder, then runs the existing sign-in claim so other placeholders with the
same verified email merge too. Migration `0024_people_directory.sql` is additive.
