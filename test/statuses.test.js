import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_STATUSES, isEventStatus } from '../src/domain/events/event-status.js';
import { INVITATION_STATUSES, isInvitationStatus } from '../src/domain/events/invitation-status.js';
import {
  PARTICIPANT_STATUSES,
  isParticipantStatus,
} from '../src/domain/events/participant-status.js';
import {
  REGISTRATION_STATUSES,
  isRegistrationStatus,
} from '../src/domain/events/registration-status.js';
import { EMAIL_UNSUBSCRIBE_REASONS } from '../src/domain/accounts/email-unsubscribe-reasons.js';

const statusModules = [
  [EVENT_STATUSES, isEventStatus],
  [INVITATION_STATUSES, isInvitationStatus],
  [PARTICIPANT_STATUSES, isParticipantStatus],
  [REGISTRATION_STATUSES, isRegistrationStatus],
];

test('status registries are immutable and validators accept only their declared values', () => {
  for (const [statuses, validator] of statusModules) {
    assert.ok(Object.isFrozen(statuses));
    for (const status of statuses) assert.equal(validator(status), true);
    assert.equal(validator('Unknown'), false);
    assert.equal(validator(statuses[0].toLowerCase()), false);
  }
});

test('unsubscribe reasons expose the supported customer choices', () => {
  assert.deepEqual(EMAIL_UNSUBSCRIBE_REASONS, [
    'Too many emails',
    'The content is not relevant to me',
    'I no longer use the service',
    'I never subscribed',
    'Other',
  ]);
  assert.ok(Object.isFrozen(EMAIL_UNSUBSCRIBE_REASONS));
});
