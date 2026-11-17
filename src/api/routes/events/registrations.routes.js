import { isRegistrationStatus } from '../../../domain/events/registration-status.js';
import { isParticipantStatus } from '../../../domain/events/participant-status.js';

export function registerEventsRegistrationsRoutes(
  app,
  { authenticate, ensureTable, queries, emailService, requireManager },
) {
  app.post('/api/events/:id/registrations', authenticate, async (req, res) => {
    if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role))
      return res
        .status(403)
        .json({ error: 'Your account is not permitted to register for events.' });
    if (!req.user.isEmailConfirmed)
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email address before registering for an event.',
      });
    try {
      await ensureTable();
      if (!(await queries.canAcceptPaidRegistrations(req.params.id)))
        return res.status(422).json({
          code: 'PAYMENT_SETUP_REQUIRED',
          error: 'Complete payment setup before starting ticket sales.',
        });
      const result = await queries.registerForEvent(
        req.params.id,
        req.user.id,
        req.user.email,
        req.body?.selectedFoodOptions,
      );
      if (result.error === 'INVALID_FOOD_OPTIONS')
        return res
          .status(422)
          .json({ error: 'Choose only the food options currently offered for this event.' });
      if (result.error === 'EVENT_UNAVAILABLE')
        return res.status(409).json({ error: 'Event is not available for registration.' });
      if (result.error === 'ALREADY_REGISTERED')
        return res.status(409).json({ error: 'You are already registered for this event.' });
      const user = await queries.profile(req.user.id);
      try {
        await emailService.sendRegistrationConfirmation(user.email, user.name, result);
      } catch (emailError) {
        console.error('Registration confirmation email failed:', emailError.message);
      }
      try {
        await emailService.sendManagerRegistrationNotification(
          result.managerEmail,
          result.managerName,
          user.name,
          user.email,
          result.title,
          result.eventId,
          result.id,
        );
      } catch (emailError) {
        console.error('Manager registration notification failed:', emailError.message);
      }
      return res.status(201).json({ id: result.id, status: 'Pending' });
    } catch (error) {
      console.error('Event registration failed:', error.message);
      return res.status(500).json({ error: 'Unable to register for event.' });
    }
  });
  app.get('/api/my/registrations', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.userRegistrations(req.user.id));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load registrations.' });
    }
  });
  app.patch('/api/events/:eventId/withdraw', authenticate, async (req, res) => {
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(404).json({ error: 'Active registration not found.' });
    try {
      await ensureTable();
      const registration = await queries.findActiveRegistrationForUser(eventId, req.user.id);
      if (!registration || !(await queries.markRegistrationWithdrawn(registration)))
        return res.status(404).json({ error: 'Active registration not found.' });
      return res.json({ status: 'Withdrawn', registrationId: registration.id });
    } catch (error) {
      console.error('Event withdrawal failed:', error.message);
      return res.status(500).json({ error: 'Unable to withdraw from this event.' });
    }
  });
  app.patch('/api/registrations/:id/withdraw', authenticate, async (req, res) => {
    if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role))
      return res
        .status(403)
        .json({ error: 'Your account is not permitted to withdraw registrations.' });
    try {
      await ensureTable();
      const registration = await queries.customerRegistration(req.params.id, req.user.id);
      if (!registration || !(await queries.withdrawRegistration(req.params.id, req.user.id)))
        return res.status(404).json({ error: 'Registration not found or cannot be withdrawn.' });
      try {
        await emailService.sendRegistrationWithdrawal(
          registration.email,
          registration.name,
          registration,
        );
      } catch (emailError) {
        console.error('Registration withdrawal email failed:', emailError.message);
      }
      return res.json({ message: 'Registration withdrawn.', status: 'Withdrawn' });
    } catch (error) {
      console.error('Registration withdrawal failed:', error.message);
      return res.status(500).json({ error: 'Unable to withdraw registration.' });
    }
  });
  app.get('/api/events/:id/participants', authenticate, requireManager, async (req, res) => {
    try {
      await ensureTable();
      const event = await queries.richEvent(req.params.id, req.user.id, req.user.role);
      if (
        !event ||
        (!['manager', 'admin'].includes(req.user.role) && event.managerId !== req.user.id)
      )
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      return res.json(await queries.eventParticipants(req.params.id, true));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event participants.' });
    }
  });
  app.get('/api/events/:id/registrations', authenticate, requireManager, async (req, res) => {
    try {
      await ensureTable();
      return res.json(
        await queries.registrations(req.params.id, req.user.id, req.user.role === 'admin'),
      );
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event registrations.' });
    }
  });
  app.patch('/api/participants/:id/status', authenticate, requireManager, async (req, res) => {
    if (!isParticipantStatus(req.body.status) || req.body.status === 'Pending')
      return res.status(400).json({ error: 'Participant status must be Attended or No Show.' });
    try {
      await ensureTable();
      if (
        !(await queries.updateParticipantStatus(
          req.params.id,
          req.user.id,
          req.body.status,
          req.user.role === 'admin',
        ))
      )
        return res.status(404).json({ error: 'Participant not found.' });
      return res.json({ message: 'Participant status updated.', status: req.body.status });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update participant status.' });
    }
  });
  app.patch(
    '/api/participants/:id/payment-status',
    authenticate,
    requireManager,
    async (req, res) => {
      if (!['Not Required', 'Payment Required', 'Paid'].includes(req.body.status))
        return res.status(400).json({ error: 'Invalid payment status.' });
      try {
        await ensureTable();
        const fee = await queries.participantFee(req.params.id);
        if (req.body.status === 'Paid' && fee <= 0)
          return res.status(400).json({ error: 'This event does not require payment.' });
        if (
          !(await queries.updateParticipantPaymentStatus(
            req.params.id,
            req.user.id,
            req.body.status,
            req.user.role,
          ))
        )
          return res.status(404).json({ error: 'Participant not found.' });
        return res.json({
          message: 'Participant payment status updated.',
          paymentStatus: req.body.status,
        });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to update participant payment status.' });
      }
    },
  );
  app.patch(
    '/api/registrations/:id/payment-status',
    authenticate,
    requireManager,
    async (req, res) => {
      if (!['Not Required', 'Payment Required', 'Paid'].includes(req.body.status))
        return res.status(400).json({ error: 'Invalid payment status.' });
      try {
        await ensureTable();
        const fee = await queries.registrationFee(req.params.id);
        if (req.body.status === 'Paid' && fee <= 0)
          return res.status(400).json({ error: 'This event does not require payment.' });
        if (
          !(await queries.updateRegistrationPaymentStatus(
            req.params.id,
            req.user.id,
            req.body.status,
            req.user.role,
          ))
        )
          return res.status(404).json({ error: 'Pending registration not found.' });
        return res.json({
          message: 'Registration payment status updated.',
          paymentStatus: req.body.status,
        });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to update registration payment status.' });
      }
    },
  );
  app.patch('/api/registrations/:id/status', authenticate, requireManager, async (req, res) => {
    if (!isRegistrationStatus(req.body.status))
      return res.status(400).json({ error: 'Invalid registration status.' });
    try {
      await ensureTable();
      const registration = await queries.registration(req.params.id, req.user.id);
      if (!registration && req.user.role !== 'admin')
        return res.status(404).json({ error: 'Registration not found.' });
      if (
        !(await queries.updateRegistrationStatus(
          req.params.id,
          req.user.id,
          req.body.status,
          req.user.role === 'admin',
        ))
      )
        return res.status(404).json({ error: 'Registration not found.' });
      if (req.body.status === 'Confirmed' && registration) {
        try {
          await emailService.sendRegistrationApproved(
            registration.email,
            registration.name,
            registration,
          );
        } catch (emailError) {
          console.error('Registration approval email failed:', emailError.message);
        }
      }
      return res.json({ message: 'Registration status updated.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update registration status.' });
    }
  });
}
