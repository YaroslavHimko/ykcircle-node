# Event registration food choices

The registration confirmation dialog lets a user select any number of the event's food options, including none. Choices are sent as `selectedFoodOptions`, checked against the current event options, and stored with the registration. Confirming the registration copies them to the participant record before removing the pending registration.

Organizer registration and participant views show the selected labels. Public participant responses omit them. Account data exports include the choices. A new registration after withdrawal replaces the old choices.

## Database deployment

The fresh-install schema includes nullable `selected_food_options` JSON columns on `event_registrations` and `event_participants`. No migration framework or automatic schema upgrade was added.

If retaining an existing database, check for these columns first and add only the missing columns before deploying the API:

```sql
SHOW COLUMNS FROM event_registrations LIKE 'selected_food_options';
SHOW COLUMNS FROM event_participants LIKE 'selected_food_options';

ALTER TABLE event_registrations ADD COLUMN selected_food_options JSON NULL;
ALTER TABLE event_participants ADD COLUMN selected_food_options JSON NULL;
```

Existing records have no selections. No production database changes were executed during implementation. Deploy the frontend and API together after preparing the schema.

Validation: 223 backend tests, frontend lint/build, and a local browser test using mocked APIs for multi-selection, submission, organizer confirmation, and public visibility.
