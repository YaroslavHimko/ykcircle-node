import crypto from 'node:crypto';

export function createMediaAccess({ authSecret, ensureTable, optionalAuthenticate, queries, app }) {
  const imageTokenTtlMs = 15 * 60 * 1000;
  const signImagePayload = (kind, payload) =>
    crypto.createHmac('sha256', authSecret).update(`${kind}:${payload}`).digest('base64url');
  const createImageToken = (kind) => (filename) => {
    const payload = Buffer.from(
      JSON.stringify({ filename, exp: Date.now() + imageTokenTtlMs }),
    ).toString('base64url');
    return `${payload}.${signImagePayload(kind, payload)}`;
  };
  const validateImageToken = (kind, token, filename) => {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return { valid: false, expired: false };
    const expected = signImagePayload(kind, payload);
    // timingSafeEqual throws on a length mismatch, so compare lengths first.
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return { valid: false, expired: false };
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (data.filename !== filename) return { valid: false, expired: false };
      return { valid: data.exp > Date.now(), expired: data.exp <= Date.now() };
    } catch {
      return { valid: false, expired: false };
    }
  };
  const venueImageToken = createImageToken('venue-image');
  const groupCoverToken = createImageToken('group-cover');
  const eventCoverToken = createImageToken('event-cover');
  const imageNotFound = (req, res, label, message, reason, extra = {}) => {
    console.warn(`${label} image request denied.`, {
      requestId: req.mediaRequestId || null,
      filename: req.params.filename,
      reason,
      tokenPresent: Boolean(req.query.token),
      userId: req.user?.id ?? null,
      role: req.user?.role ?? null,
      ...extra,
    });
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: message });
  };
  const mediaRequestId = () => crypto.randomBytes(12).toString('hex');
  const redactedMediaUrl = (url) =>
    String(url || '')
      .replace(/(\/api\/media\/(?:event|venue|group)\/)[^/?]+(?=\/)/i, '$1[TOKEN]')
      .replace(/([?&]token=)[^&]*/gi, '$1[present]');
  const attachMediaResponseLog = (req, res, details) => {
    res.once('finish', () =>
      console.info('Media response completed.', {
        requestId: req.mediaRequestId,
        route: redactedMediaUrl(req.path),
        originalUrl: redactedMediaUrl(req.originalUrl || req.url),
        filename: req.params.filename,
        tokenPresent: Boolean(req.mediaTokenPresent ?? req.query.token),
        status: res.statusCode,
        location: res.getHeader('location') || null,
        contentType: res.getHeader('content-type') || null,
        cacheControl: res.getHeader('cache-control') || null,
        ...details(),
      }),
    );
  };
  const mediaAccess = async ({ req, tokenKind, visible, allowSignedToken }) => {
    const tokenPresent = allowSignedToken && Boolean(req.mediaToken);
    const token = allowSignedToken
      ? validateImageToken(tokenKind, req.mediaToken, req.params.filename)
      : { valid: false, expired: false };
    const access = {
      publicAccess: false,
      signedTokenAccess: token.valid,
      authenticatedUserAccess: false,
      adminAccess: false,
    };
    // A supplied but invalid token is never silently ignored, even if the
    // caller also has credentials. This keeps signature failures observable
    // and prevents a malformed signed URL from changing authorization flow.
    if (tokenPresent && !token.valid)
      return {
        access,
        tokenPresent,
        token,
        media: null,
        allowed: false,
        authorizationReason: 'invalid-signed-media-token',
      };

    // A valid signed token is a capability for precisely this filename. It
    // must survive all later work; no visibility lookup may overwrite it.
    const media = token.valid
      ? null
      : await visible(req.params.filename, req.user?.id ?? null, req.user?.role ?? null);
    access.publicAccess = Boolean(media?.publiclyVisible);
    if (media && req.user && !access.publicAccess) {
      access.adminAccess = ['manager', 'admin'].includes(req.user.role);
      access.authenticatedUserAccess = !access.adminAccess;
    }
    const allowed =
      access.publicAccess ||
      access.signedTokenAccess ||
      access.authenticatedUserAccess ||
      access.adminAccess;
    const authorizationReason = access.signedTokenAccess
      ? 'signed-media-token'
      : access.publicAccess
        ? 'public-media'
        : access.adminAccess
          ? 'administrator'
          : access.authenticatedUserAccess
            ? 'authenticated-user'
            : 'denied';
    return { access, tokenPresent, token, media, allowed, authorizationReason };
  };
  const publicMediaRoute = ({ route, label, visible, stream, message }) =>
    app.get(route, async (req, res) => {
      req.mediaRequestId = mediaRequestId();
      attachMediaResponseLog(req, res, () => ({
        mediaType: label,
        authorizationSurface: 'public-uploads',
      }));
      try {
        await ensureTable();
        // Do not use supplied credentials or tokens here: /uploads is public
        // only, and private media must be requested through /api/media.
        const result = await mediaAccess({
          req,
          tokenKind: null,
          visible: (...args) => visible(args[0], null, null),
          allowSignedToken: false,
        });
        if (!result.access.publicAccess)
          return imageNotFound(req, res, label, message, 'not-public');
        if (!(await stream(req.params.filename, res)))
          return imageNotFound(req, res, label, message, 'missing-from-storage');
      } catch (error) {
        console.error(`${label} public image proxy failed:`, error.message);
        if (!res.headersSent) {
          res.set('Cache-Control', 'no-store');
          return res.status(502).json({ error: 'Unable to load image.' });
        }
      }
    });
  const logProtectedMedia = (req, details) =>
    console.info('Protected media request.', {
      route: redactedMediaUrl(req.path),
      mediaType: req.params.kind,
      filename: req.params.filename,
      requestId: req.mediaRequestId,
      tokenPresent: Boolean(req.mediaTokenPresent ?? req.query.token),
      userId: req.user?.id ?? null,
      ...details,
    });
  const protectedMediaRoute = ({ kind, tokenKind, visible, stream, message }) => {
    const handler = async (req, res) => {
      req.mediaRequestId = mediaRequestId();
      // Path tokens are the canonical format. Query tokens remain accepted
      // temporarily for existing clients, but are no longer generated.
      req.mediaToken = req.params.token || req.query.token || null;
      req.mediaTokenPresent = Boolean(req.mediaToken);
      const routeToken = validateImageToken(tokenKind, req.mediaToken, req.params.filename);
      let result = null;
      let finalAuthorization = null;
      attachMediaResponseLog(req, res, () => ({
        mediaType: kind,
        authorizationSurface: 'protected-api',
        tokenValid: result?.token.valid ?? routeToken.valid,
        tokenExpired: result?.token.expired ?? routeToken.expired,
        signedTokenAccess: result?.access.signedTokenAccess ?? routeToken.valid,
        publicAccess: result?.access.publicAccess ?? false,
        authenticatedUserAccess: result?.access.authenticatedUserAccess ?? false,
        adminAccess: result?.access.adminAccess ?? false,
        finalAuthorization: finalAuthorization ?? (result?.allowed ? 'allowed' : 'denied'),
        authorizationReason: result?.authorizationReason ?? null,
      }));
      logProtectedMedia(req, {
        mediaType: kind,
        stage: 'route-reached',
        tokenValid: routeToken.valid,
        tokenExpired: routeToken.expired,
        signedTokenAccess: routeToken.valid,
      });
      try {
        // A verified, filename-bound token is the authorization capability for
        // browser image loads. Do not revalidate it after asynchronous work or
        // apply event visibility rules that require a logged-in user.
        if (routeToken.valid) {
          result = {
            access: {
              publicAccess: false,
              signedTokenAccess: true,
              authenticatedUserAccess: false,
              adminAccess: false,
            },
            tokenPresent: true,
            token: routeToken,
            media: null,
            allowed: true,
            authorizationReason: 'signed-media-token',
          };
          finalAuthorization = 'allowed';
          // Vary does not commit the response. streamImage sets the success
          // cache/content headers only after its FTP transfer completes.
          res.set('Vary', 'Authorization');
          if (!(await stream(req.params.filename, res, 'private, no-store, max-age=0'))) {
            res.set('Cache-Control', 'private, no-store, max-age=0');
            logProtectedMedia(req, {
              mediaType: kind,
              tokenValid: true,
              tokenExpired: false,
              ...result.access,
              finalAuthorization: 'allowed',
              authorization: 'allowed',
              authorizationReason: result.authorizationReason,
              status: 404,
              denialBranch: 'missing-from-storage',
            });
            return res.status(404).json({ error: message });
          }
          logProtectedMedia(req, {
            mediaType: kind,
            tokenValid: true,
            tokenExpired: false,
            ...result.access,
            finalAuthorization: 'allowed',
            authorization: 'allowed',
            authorizationReason: result.authorizationReason,
            status: 200,
          });
          return;
        }
        await ensureTable();
        result = await mediaAccess({ req, tokenKind, visible, allowSignedToken: true });
        const privateResponse = result.access.signedTokenAccess || !result.access.publicAccess;
        if (!result.allowed) {
          res.set({
            'Cache-Control': privateResponse
              ? 'private, no-store, max-age=0'
              : 'public, max-age=86400',
            Vary: 'Authorization',
          });
          finalAuthorization = 'denied';
          logProtectedMedia(req, {
            mediaType: kind,
            tokenValid: result.token.valid,
            tokenExpired: result.token.expired,
            ...result.access,
            finalAuthorization: 'denied',
            authorization: 'denied',
            authorizationReason: result.authorizationReason,
            status: 403,
            denialBranch: 'final-authorization',
          });
          return res.status(403).json({ error: 'Protected media access denied.' });
        }
        // Preparing Vary does not send a response; the FTP service commits
        // Cache-Control, Content-Type, and 200 only after it has the bytes.
        res.set('Vary', 'Authorization');
        if (
          !(await stream(
            req.params.filename,
            res,
            privateResponse ? 'private, no-store, max-age=0' : undefined,
          ))
        ) {
          res.set(
            'Cache-Control',
            privateResponse ? 'private, no-store, max-age=0' : 'public, max-age=86400',
          );
          finalAuthorization = 'allowed';
          logProtectedMedia(req, {
            mediaType: kind,
            tokenValid: result.token.valid,
            tokenExpired: result.token.expired,
            ...result.access,
            finalAuthorization: 'allowed',
            authorization: 'allowed',
            authorizationReason: result.authorizationReason,
            status: 404,
            denialBranch: 'missing-from-storage',
          });
          return res.status(404).json({ error: message });
        }
        finalAuthorization = 'allowed';
        logProtectedMedia(req, {
          mediaType: kind,
          tokenValid: result.token.valid,
          tokenExpired: result.token.expired,
          ...result.access,
          finalAuthorization: 'allowed',
          authorization: 'allowed',
          authorizationReason: result.authorizationReason,
          status: 200,
        });
      } catch (error) {
        console.error(`${kind} protected media proxy failed:`, error.message);
        if (!res.headersSent) {
          finalAuthorization = 'error';
          res.set('Cache-Control', 'private, no-store, max-age=0');
          logProtectedMedia(req, {
            mediaType: kind,
            tokenValid: result?.token.valid ?? routeToken.valid,
            tokenExpired: result?.token.expired ?? routeToken.expired,
            ...(result?.access || {}),
            finalAuthorization,
            authorization: 'error',
            authorizationReason: 'internal-error',
            status: 502,
            denialBranch: 'internal-error',
          });
          return res.status(502).json({ error: 'Unable to load image.' });
        }
      }
    };
    app.get(`/api/media/${kind}/:token/:filename`, optionalAuthenticate, handler);
    app.get(`/api/media/${kind}/:filename`, optionalAuthenticate, handler);
  };
  const mediaVisibility =
    (method) =>
    (...args) =>
      queries[method](...args);
  const mediaStream =
    (service, method) =>
    (...args) =>
      service[method](...args);
  return {
    venueImageToken,
    groupCoverToken,
    eventCoverToken,
    publicMediaRoute,
    protectedMediaRoute,
    mediaVisibility,
    mediaStream,
  };
}
