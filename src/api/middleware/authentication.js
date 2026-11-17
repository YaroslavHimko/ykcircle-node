import crypto from 'node:crypto';

export function createAccountsAuthentication({ authSecret, ensureTable, queries }) {
  const hashPassword = (password) =>
    new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(16).toString('hex');
      crypto.scrypt(password, salt, 64, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(`${salt}:${derivedKey.toString('hex')}`);
      });
    });
  const createVerificationToken = () => crypto.randomBytes(32).toString('hex');
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const verifyPassword = (password, stored) =>
    new Promise((resolve, reject) => {
      const [salt, hash] = stored.split(':');
      crypto.scrypt(password, salt, 64, (error, derivedKey) => {
        if (error) reject(error);
        else
          resolve(
            hash.length === derivedKey.toString('hex').length &&
              crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey),
          );
      });
    });
  const createToken = (user) => {
    const payload = Buffer.from(
      JSON.stringify({
        id: user.id,
        sessionVersion: user.sessionVersion,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
    ).toString('base64url');
    const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  };
  const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const [payload, signature] = token.split('.');
    try {
      const expected = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
      if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        throw new Error('Invalid token');
      const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (user.exp < Date.now()) throw new Error('Expired token');
      await ensureTable();
      req.user = await queries.findUserById(user.id);
      if (!req.user || user.sessionVersion !== req.user.sessionVersion)
        throw new Error('User not found');
      res.set('Cache-Control', 'no-store');
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
  };
  const optionalAuthenticate = async (req, _res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next();
    const [payload, signature] = token.split('.');
    try {
      const expected = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
      if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        return next();
      const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (user.exp >= Date.now()) {
        const currentUser = await queries.findUserById(user.id);
        if (currentUser && user.sessionVersion === currentUser.sessionVersion) {
          req.user = currentUser;
          _res.set('Cache-Control', 'no-store');
        }
      }
    } catch {
      /* Treat invalid optional credentials as anonymous. */
    }
    return next();
  };
  const requireAdmin = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });
  const requirePlatformStaff = (req, res, next) =>
    ['admin', 'manager'].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Administrator or manager access required.' });
  const requireManager = (req, res, next) =>
    ['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Event-management access required.' });
  const requireVerifiedUser = (req, res, next) =>
    req.user.isEmailConfirmed
      ? next()
      : res.status(403).json({
          code: 'EMAIL_NOT_VERIFIED',
          error: 'Please verify your email address to continue.',
        });
  const requireRoleManager = (req, res, next) =>
    ['manager', 'admin'].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Manager access required.' });
  const requireVenueOwner = (req, res, next) =>
    req.user.isEmailConfirmed
      ? next()
      : res
          .status(403)
          .json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before managing venues.' });
  return {
    hashPassword,
    createVerificationToken,
    hashToken,
    verifyPassword,
    createToken,
    authenticate,
    optionalAuthenticate,
    requireAdmin,
    requirePlatformStaff,
    requireManager,
    requireVerifiedUser,
    requireRoleManager,
    requireVenueOwner,
  };
}
