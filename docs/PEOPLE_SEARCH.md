# People settings and invitation inbox

The Friends screen lets you send a request to a full sign-in email or to an
active member of a group you share. Split uses the verified primary email from
the account profile. **Let people find me** controls email-addressed requests
and defaults to on. People with active memberships in a shared group can still request by account
ID. Split gives the same response for unknown, opted-out, pending and eligible
recipients, and never returns an address or phone number from these endpoints.
Each account can send up to 60 requests per hour. Requests expire after 14 days.

Only the recipient can see or answer a pending request. Acceptance makes the
friendship visible to both accounts. Either friend can remove the relationship.
Removing a friendship leaves existing group memberships intact.

## Link a placeholder

An active group member can link an active, unclaimed placeholder to a friend
or another active member of a shared group. The Worker rechecks group
membership and the relationship when it writes the link. It claims the
placeholder in place, or aliases it to the recipient’s existing seat so past
payers and shares resolve to one member without changing cent totals.

An archived recipient must restore their membership before that group can link
another seat to them. The recipient immediately gets a private inbox notification. Group members can
see the event in Member activity. Linking is permanent. The recipient cannot
unlink themselves because subsequent entries and settlements can combine the
histories of both seats. Dismissing the notice leaves the link in place.

## Invitation inbox

The invitation inbox and its badge include pending friend requests, unread
placeholder link notices, and group invitations from direct and verified-email
links. Only the addressed account can respond. Existing email invites still
recheck the recipient’s current verified email before claiming a placeholder.

Migration 0024 introduced the inbox and account privacy setting. The people
settings migration adds friendships and a member link activity log. Existing
invitations continue to work.
