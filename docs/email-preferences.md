# Optional email preferences

Profile offers separate switches for event invitations, private-group invitations, new-event announcements from joined groups, and existing YKCircle marketing messages.

`GET /api/auth/profile/email-preferences` returns `eventInvitations`, `groupInvitations`, and `groupEventAnnouncements`. Authenticated users can send a partial `PATCH` containing boolean values to the same endpoint. The authenticated user ID is used for all reads and writes; request bodies cannot select another account. Marketing consent keeps its existing endpoint and opt-in rules.

Database initialization adds `user_email_preferences` with a user foreign key. Missing rows keep existing invitation and group announcement delivery enabled. Changing one category preserves the others. Preferences are included in the account data export and removed on hard deletion through the foreign key.

The email service checks the recipient's saved preference before sending an event invitation (including resends), group invitation, or group event announcement. Suppressed emails do not remove invitations or group membership: those remain available in the app. Security messages, receipts, registration updates, and existing event follow-ups are unaffected.

Deploy the API and frontend together so the profile controls have their corresponding endpoints. Initialization creates the table automatically; no separate manual migration is required.
