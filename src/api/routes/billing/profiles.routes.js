import { paymentsOverview } from '../../../services/billing/payments-overview.js';

export function registerBillingProfilesRoutes(
  app,
  {
    authenticate,
    ensureTable,
    queries,
    subscriptions,
    requireVerifiedUser,
    billingProfileData,
    stripe,
    refreshStripeAccount,
    config,
  },
) {
  app.get('/api/account/payments-overview', authenticate, async (req, res) => {
    try {
      await ensureTable();
      res.set('Cache-Control', 'private, no-store');
      return res.json(
        await paymentsOverview({ queries: queries, subscriptions: subscriptions, user: req.user }),
      );
    } catch (error) {
      console.error('Payments overview failed:', error.message);
      return res
        .status(500)
        .json({ error: 'Unable to load payments and business details. Please try again.' });
    }
  });
  app.get('/api/me/billing-profiles', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.billingProfiles(req.user.id, req.user.role));
    } catch (error) {
      console.error('Billing profile lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load billing profiles.' });
    }
  });
  app.post('/api/me/billing-profiles', authenticate, requireVerifiedUser, async (req, res) => {
    const { data, errors } = billingProfileData(req.body);
    if (Object.keys(errors).length)
      return res.status(422).json({ error: 'Billing profile is invalid.', fields: errors });
    try {
      await ensureTable();
      const profile = await queries.saveBillingProfile(req.user.id, req.user.role, null, data);
      return profile
        ? res.status(201).json(profile)
        : res
            .status(403)
            .json({ error: 'You cannot create a billing profile for this organization.' });
    } catch (error) {
      console.error('Billing profile creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to save billing profile.' });
    }
  });
  app.put('/api/me/billing-profiles/:id', authenticate, requireVerifiedUser, async (req, res) => {
    const id = Number(req.params.id);
    const { data, errors } = billingProfileData(req.body);
    if (!Number.isInteger(id) || id < 1 || Object.keys(errors).length)
      return res.status(422).json({ error: 'Billing profile is invalid.', fields: errors });
    try {
      await ensureTable();
      const profile = await queries.saveBillingProfile(req.user.id, req.user.role, id, data);
      return profile
        ? res.json(profile)
        : res.status(403).json({ error: 'Billing profile not found or not available to you.' });
    } catch (error) {
      console.error('Billing profile update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update billing profile.' });
    }
  });
  app.delete('/api/me/billing-profiles/:id', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid billing profile is required.' });
    try {
      await ensureTable();
      const result = await queries.archiveBillingProfile(id, req.user.id, req.user.role);
      if (result?.error === 'REFERENCED')
        return res.status(409).json({
          error: 'This billing profile is referenced by financial records and cannot be archived.',
        });
      return result
        ? res.status(204).end()
        : res.status(403).json({ error: 'Billing profile not found or not available to you.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to archive billing profile.' });
    }
  });
  app.get('/api/me/billing-profiles/:id/payment-accounts', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid billing profile is required.' });
    try {
      await ensureTable();
      const accounts = await queries.paymentAccounts(id, req.user.id, req.user.role);
      if (accounts === null)
        return res.status(403).json({ error: 'Billing profile not available to you.' });
      // Read fresh Stripe status after hosted onboarding; its redirect does not prove readiness.
      const result = await Promise.all(
        accounts.map(async (account) => {
          if (account.provider !== 'stripe' || !stripe.configured()) return account;
          const remote = await refreshStripeAccount(account.providerAccountId);
          return {
            ...account,
            onboardingStatus: remote.onboarding_status,
            chargesEnabled: remote.charges_enabled,
            payoutsEnabled: remote.payouts_enabled,
            detailsSubmitted: remote.details_submitted,
            requirementsStatus: remote.requirements_status,
            testMode: stripe.testMode(),
          };
        }),
      );
      return res.json(result);
    } catch (error) {
      console.error('Payment account refresh failed:', error.message);
      return res.status(502).json({
        error:
          'Unable to refresh payment accounts from Stripe. Verify that the seller account belongs to the configured Stripe environment.',
      });
    }
  });
  app.post(
    '/api/me/billing-profiles/:id/payment-accounts',
    authenticate,
    requireVerifiedUser,
    async (req, res) => {
      const profileId = Number(req.params.id);
      if (!Number.isInteger(profileId) || profileId < 1)
        return res.status(422).json({ error: 'A valid billing profile is required.' });
      if (!stripe.configured())
        return res.status(503).json({
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          error: 'Connected payments are not configured.',
        });
      try {
        await ensureTable();
        const profile = await queries.billingProfile(profileId, req.user.id, req.user.role);
        if (!profile)
          return res
            .status(403)
            .json({ error: 'Billing profile not found or not available to you.' });
        const stripeAccount = await stripe.createConnectedAccount(profile);
        const account = await queries.createPaymentAccount(profileId, req.user.id, req.user.role, {
          provider: 'stripe',
          providerAccountId: stripeAccount.id,
        });
        const base = `${config.site.siteUrl}/billing/payment-account`;
        const link = await stripe.createOnboardingLink(stripeAccount.id, {
          refreshUrl: `${base}/refresh?accountId=${account.id}`,
          returnUrl: `${base}/complete?accountId=${account.id}`,
        });
        return res.status(201).json({ account, onboardingUrl: stripe.onboardingUrl(link) });
      } catch (error) {
        console.error('Stripe connected-account creation failed:', error.message);
        if (error.code === 'UNSUPPORTED_STRIPE_COUNTRY')
          return res.status(422).json({ code: error.code, error: error.message });
        if (
          [
            'accounts_v2_access_blocked',
            'account_create_activation_required',
            'connect_profile_not_submitted',
          ].includes(error.code)
        )
          return res.status(422).json({
            code: 'STRIPE_CONNECT_NOT_READY',
            error:
              'Stripe Connect Accounts v2 is not ready for this sandbox. Activate Connect and complete the platform profile in Stripe before onboarding a seller.',
          });
        return res.status(502).json({ error: 'Unable to start payment-account onboarding.' });
      }
    },
  );
  app.post('/api/payment-accounts/:id/onboarding-link', authenticate, async (req, res) => {
    const accountId = Number(req.params.id);
    if (!Number.isInteger(accountId) || accountId < 1)
      return res.status(422).json({ error: 'A valid payment account is required.' });
    if (!stripe.configured())
      return res.status(503).json({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        error: 'Connected payments are not configured.',
      });
    try {
      await ensureTable();
      const account = await queries.paymentAccount(accountId, req.user.id, req.user.role);
      if (!account || account.provider !== 'stripe')
        return res
          .status(404)
          .json({ error: 'Payment account not found or not available to you.' });
      const stripeAccount = await refreshStripeAccount(account.providerAccountId);
      if (stripeAccount.charges_enabled)
        return res.json({
          account: {
            ...account,
            onboardingStatus: stripeAccount.onboarding_status,
            chargesEnabled: true,
          },
          onboardingUrl: null,
        });
      const base = `${config.site.siteUrl}/billing/payment-account`;
      const link = await stripe.createOnboardingLink(account.providerAccountId, {
        refreshUrl: `${base}/refresh?accountId=${account.id}`,
        returnUrl: `${base}/complete?accountId=${account.id}`,
      });
      return res.json({ onboardingUrl: stripe.onboardingUrl(link) });
    } catch (error) {
      console.error('Stripe onboarding link creation failed:', error.message);
      if (
        [
          'accounts_v2_access_blocked',
          'account_create_activation_required',
          'connect_profile_not_submitted',
        ].includes(error.code)
      )
        return res.status(422).json({
          code: 'STRIPE_CONNECT_NOT_READY',
          error:
            'Stripe Connect Accounts v2 is not ready for this sandbox. Activate Connect and complete the platform profile in Stripe before onboarding a seller.',
        });
      return res.status(502).json({ error: 'Unable to create payment-account onboarding link.' });
    }
  });
  app.get('/api/payment-accounts/:id/status', authenticate, async (req, res) => {
    const accountId = Number(req.params.id);
    if (!Number.isInteger(accountId) || accountId < 1)
      return res.status(422).json({ error: 'A valid payment account is required.' });
    try {
      await ensureTable();
      const account = await queries.paymentAccount(accountId, req.user.id, req.user.role);
      if (!account || account.provider !== 'stripe')
        return res
          .status(404)
          .json({ error: 'Payment account not found or not available to you.' });
      if (!stripe.configured())
        return res.status(503).json({ error: 'Connected payments are not configured.' });
      const remote = await refreshStripeAccount(account.providerAccountId);
      return res.json({
        id: account.id,
        testMode: stripe.testMode(),
        onboardingStatus: remote.onboarding_status,
        chargesEnabled: remote.charges_enabled,
        payoutsEnabled: remote.payouts_enabled,
        detailsSubmitted: remote.details_submitted,
        requirementsStatus: remote.requirements_status,
        needsOnboarding: !remote.charges_enabled,
      });
    } catch (error) {
      console.error('Stripe account status lookup failed:', error.message);
      return res.status(502).json({ error: 'Unable to read payment-account status from Stripe.' });
    }
  });
}
