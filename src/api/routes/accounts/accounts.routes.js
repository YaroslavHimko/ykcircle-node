import { registerEmailPreferenceRoutes } from './email-preferences.routes.js';
import { currentLegalDocument } from '../../../services/legal/legal-documents.js';
import { isValidIanaTimezone } from '../../../utils/time.js';

export function registerAccountsRoutes(
  app,
  {
    config,
    ensureTable,
    queries,
    hashPassword,
    createVerificationToken,
    hashToken,
    emailService,
    verifyPassword,
    createToken,
    authenticate,
    database,
    parseProfilePicture,
    ftpService,
  },
) {
  app.post('/api/auth/register', async (req, res) => {
    const {
      profilePicture = null,
      name,
      email,
      password,
      termsAccepted,
      termsVersion,
      ageConfirmed,
      marketingConsent = false,
    } = req.body;
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (termsAccepted !== true || typeof termsVersion !== 'string')
      return res
        .status(422)
        .json({ error: 'You must accept the current Terms of Service to register.' });
    if (ageConfirmed !== true)
      return res.status(422).json({
        error: `You must confirm that you are at least ${config.runtime.minimumUserAge} years old to register.`,
      });
    if (typeof marketingConsent !== 'boolean')
      return res.status(422).json({ error: 'marketingConsent must be a boolean when provided.' });
    try {
      await ensureTable();
      const terms = await currentLegalDocument('terms', config);
      await queries.ensureLegalDocumentVersion(terms);
      if (terms.version !== termsVersion)
        return res.status(409).json({
          error: 'The Terms of Service have changed. Review and accept the current version.',
          termsVersion: terms.version,
        });
      const normalizedEmail = email.trim().toLowerCase();
      if (await queries.emailExists(normalizedEmail))
        return res.status(409).json({ error: 'An account with that email already exists.' });
      const passwordHash = await hashPassword(password);
      const verificationToken = createVerificationToken();
      if (!config.email.smtp.host) throw new Error('SMTP_HOST is not configured');
      const userId = await queries.createUser(
        {
          profilePicture,
          name: name.trim(),
          email: normalizedEmail,
          passwordHash,
          phone: null,
          role: 'customer',
          tokenHash: hashToken(verificationToken),
          termsVersion: terms.version,
          marketingConsent,
          marketingPolicyVersion: '2026-08-26',
        },
        () => emailService.sendVerification(normalizedEmail, name.trim(), verificationToken),
      );
      return res.status(201).json({
        message: 'Registration successful. Please check your email to verify your account.',
        user: {
          id: userId,
          profilePicture,
          name: name.trim(),
          email: normalizedEmail,
          role: 'customer',
          isEmailConfirmed: false,
        },
        termsVersion: terms.version,
      });
    } catch (error) {
      console.error('Registration failed:', error.message);
      return res.status(500).json({ error: 'Unable to register right now.' });
    }
  });
  app.post('/api/auth/resend-verification', async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    const message =
      'If an unverified account exists for that email, a new verification email has been sent.';
    if (!email) return res.status(200).json({ message });
    try {
      await ensureTable();
      const token = createVerificationToken();
      const user = await queries.refreshVerification(email, hashToken(token));
      if (user?.cooldownSeconds)
        return res.status(429).set('Retry-After', String(user.cooldownSeconds)).json({
          error: 'Please wait before requesting another verification email.',
          retryAfter: user.cooldownSeconds,
        });
      if (user) {
        try {
          await emailService.sendVerification(user.email, user.name, token);
        } catch (emailError) {
          console.error('Verification resend email failed:', emailError.message);
        }
      }
      return res.json({ message });
    } catch (error) {
      console.error('Verification resend failed:', error.message);
      return res.status(500).json({ error: 'Unable to resend verification email.' });
    }
  });
  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    const message = 'If an account exists for that email, a password reset link has been sent.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'A valid email address is required.' });
    try {
      await ensureTable();
      const token = createVerificationToken();
      const user = await queries.createPasswordReset(email, hashToken(token));
      if (user && !user.cooldown) {
        try {
          await emailService.sendPasswordReset(user.email, user.name, token);
        } catch (emailError) {
          console.error('Password reset email failed:', emailError.message);
        }
      }
      return res.json({ message });
    } catch (error) {
      console.error('Password reset request failed:', error.message);
      return res.status(500).json({ error: 'Unable to request a password reset right now.' });
    }
  });
  app.post('/api/auth/reset-password', async (req, res) => {
    const token = String(req.body.token || '');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!token || password.length < 8)
      return res.status(400).json({
        error: 'A valid reset token and a password of at least 8 characters are required.',
      });
    try {
      await ensureTable();
      if (!(await queries.resetPassword(hashToken(token), await hashPassword(password))))
        return res.status(400).json({ error: 'Invalid or expired password reset token.' });
      return res.json({ message: 'Your password has been reset successfully.' });
    } catch (error) {
      console.error('Password reset failed:', error.message);
      return res.status(500).json({ error: 'Unable to reset your password right now.' });
    }
  });
  app.get('/api/auth/verify-email', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token is required.' });
    try {
      await ensureTable();
      if (!(await queries.verifyEmail(hashToken(token))))
        return res.status(400).json({ error: 'Invalid or expired verification token.' });
      return res.json({ message: 'Email address verified successfully.' });
    } catch (error) {
      console.error('Email verification failed:', error.message);
      return res.status(500).json({ error: 'Unable to verify email right now.' });
    }
  });
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
      await ensureTable();
      const user = await queries.findUserByEmail(email?.trim().toLowerCase());
      if (!user || !(await verifyPassword(password || '', user.password_hash)))
        return res.status(401).json({ error: 'Invalid email or password.' });
      if (!user.isEmailConfirmed)
        return res.status(403).json({
          code: 'EMAIL_NOT_VERIFIED',
          error: 'Please verify your email address before logging in.',
        });
      return res.json({ token: createToken(user), user: { ...user, password_hash: undefined } });
    } catch (error) {
      console.error('Login failed:', error.message);
      return res.status(500).json({ error: 'Unable to log in right now.' });
    }
  });
  registerEmailPreferenceRoutes(app, { authenticate, ensureTable, database: database });
  app.get('/api/auth/profile', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const user = await queries.profile(req.user.id);
      if (!user) return res.status(404).json({ error: 'User profile not found.' });
      return res.json({ user: { ...user, marketingConsent: Boolean(user.marketingConsent) } });
    } catch (error) {
      console.error('Profile lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load profile.' });
    }
  });
  app.post('/api/auth/profile/picture', authenticate, parseProfilePicture, async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: 'A JPEG, PNG, GIF, or WebP image is required.' });
    try {
      await ensureTable();
      const profilePicture = await ftpService.uploadProfilePicture(req.user.id, req.file);
      if (!(await queries.updateProfilePicture(req.user.id, profilePicture)))
        return res.status(404).json({ error: 'User profile not found.' });
      return res.json({ profilePicture });
    } catch (error) {
      if (error.code === 'INVALID_IMAGE') return res.status(400).json({ error: error.message });
      if (error.code === 'FTP_NOT_CONFIGURED')
        return res.status(503).json({ error: 'Profile picture storage is not configured.' });
      console.error('Profile picture upload failed:', error.message);
      return res.status(502).json({ error: 'Unable to upload profile picture.' });
    }
  });
  app.patch('/api/auth/profile/marketing-preferences', authenticate, async (req, res) => {
    if (typeof req.body.marketingConsent !== 'boolean')
      return res.status(400).json({ error: 'marketingConsent must be a boolean.' });
    try {
      await ensureTable();
      const profile = await queries.profile(req.user.id);
      if (!profile) return res.status(404).json({ error: 'User profile not found.' });
      const marketingConsent = await queries.setMarketingEmailPreference(
        profile.email,
        req.body.marketingConsent,
        '2026-08-26',
      );
      await queries.audit(req.user.id, 'marketing_consent_changed', 'user', req.user.id, {
        marketingConsent,
      });
      return res.json({ marketingConsent });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update marketing preferences.' });
    }
  });
  app.patch('/api/auth/profile/timezone-preference', authenticate, async (req, res) => {
    const timezoneDisplayMode = String(req.body.timezoneDisplayMode || 'device');
    const preferredTimezone =
      req.body.preferredTimezone == null || req.body.preferredTimezone === ''
        ? null
        : String(req.body.preferredTimezone);
    if (
      !['device', 'fixed'].includes(timezoneDisplayMode) ||
      (timezoneDisplayMode === 'fixed' && !isValidIanaTimezone(preferredTimezone))
    )
      return res.status(422).json({ error: 'Use device mode or a valid fixed IANA timezone.' });
    try {
      await ensureTable();
      if (
        !(await queries.updateTimezonePreference(
          req.user.id,
          timezoneDisplayMode,
          timezoneDisplayMode === 'fixed' ? preferredTimezone : null,
        ))
      )
        return res.status(404).json({ error: 'User profile not found.' });
      return res.json({
        timezoneDisplayMode,
        preferredTimezone: timezoneDisplayMode === 'fixed' ? preferredTimezone : null,
      });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update timezone preference.' });
    }
  });
  app.get('/api/auth/export', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const exportData = await queries.dataExport(req.user.id);
      if (!exportData) return res.status(404).json({ error: 'User profile not found.' });
      await queries.audit(req.user.id, 'data_export_requested', 'user', req.user.id);
      res.set({
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="ykcircle-data-export-${req.user.id}.json"`,
      });
      return res.json(exportData);
    } catch (error) {
      console.error('Data export failed:', error.message);
      return res.status(500).json({ error: 'Unable to create data export.' });
    }
  });
  app.delete('/api/auth/profile', authenticate, async (req, res) => {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password)
      return res.status(400).json({ error: 'Confirm your password to delete your account.' });
    try {
      await ensureTable();
      const currentUser = await queries.findUserByEmail(req.user.email);
      if (!currentUser || !(await verifyPassword(password, currentUser.password_hash)))
        return res.status(403).json({ error: 'Password confirmation failed.' });
      const deletedUser = await queries.deleteUser(req.user.id);
      if (!deletedUser) return res.status(404).json({ error: 'User account not found.' });
      try {
        await emailService.sendAccountDeleted(deletedUser.email, deletedUser.name);
      } catch (emailError) {
        console.error('Account deletion email failed:', emailError.message);
      }
      return res.json({
        message:
          'Your account has been deleted and eligible content has been removed or anonymised.',
      });
    } catch (error) {
      console.error('Account deletion failed:', error.message);
      return res.status(500).json({ error: 'Unable to delete account.' });
    }
  });
}
