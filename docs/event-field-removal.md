The event create/update requests and event responses no longer use `capacity`,
`minimumAttendees`, `languageCode`, `registrationDeadline`, `minimumAge`,
`whatToBring`, or `meetingInstructions`. Older clients sending these properties
have them ignored. Event forms, presets, detail pages, and registration emails
have been updated accordingly.

Database initialization removes the corresponding seven columns from `events`
when they exist. This migration is idempotent and also supports partially
migrated databases. The fresh-table definition omits them. Deploy the backend
and frontend together; running the migration deletes the stored values and
older backend versions must not be run against the migrated schema.

Registration no longer enforces an event-level capacity or registration deadline.
Ticket-type stock, pending reservations, sales windows, and the requirement that
checkout happens before the event starts are retained. Venue capacity fields
are unchanged.

The migration is covered with simulated existing, fresh, and partially migrated
schemas. API tests cover create/update requests, and SQL tests check that event
insert/update columns remain aligned with their values. No live database is
required or modified by those tests.
