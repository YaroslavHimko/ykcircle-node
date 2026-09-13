const ftpConfig = ({ host, user, password, uploadPath, publicUrl, tlsServername, secure, timeoutMs }) => ({
  host,
  user,
  password,
  uploadPath,
  publicUrl,
  tlsServername,
  secure,
  timeoutMs,
});

const environmentBoolean = (name) => {
  if (process.env[name] === undefined) return undefined;
  const value = String(process.env[name]).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off', ''].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
};

const configuredArray = (name, value) => {
  if (value == null || value === '') return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // The optional public inventory is a legal-launch blocker, not a reason
    // to take down all API traffic because a hosting-panel value was malformed.
    return null;
  }
};

export class Configuration {
  constructor(values = {}) {
    const siteValues = values.site || {};
    // Environment variables are deployment-specific and must take precedence
    // over an old ignored config.local.js left on the server.
    const domain = process.env.DOMAIN || siteValues.domain || values.domain || 'ykcircle.com';
    const siteUrl = (process.env.SITE_URL || siteValues.siteUrl || values.siteUrl || `https://${domain}`).replace(/\/$/, '');
    const apiUrl = (process.env.API_URL || siteValues.apiUrl || values.apiUrl || `https://api.${domain}`).replace(/\/$/, '');

    this.site = {
      domain,
      siteUrl,
      apiUrl,
      brandName: siteValues.brandName || values.brandName || process.env.BRAND_NAME || domain,
    };
    const operatorValues = values.operator || {};
    this.operator = {
      name: process.env.PLATFORM_OPERATOR_NAME || operatorValues.name || values.platformOperatorName || null,
      email: process.env.PLATFORM_OPERATOR_EMAIL || operatorValues.email || values.platformOperatorEmail || null,
      privacyEmail: process.env.PRIVACY_EMAIL || operatorValues.privacyEmail || values.privacyEmail || null,
      supportEmail: process.env.SUPPORT_EMAIL || operatorValues.supportEmail || values.supportEmail || null,
      moderationEmail: process.env.MODERATION_EMAIL || operatorValues.moderationEmail || values.moderationEmail || null,
      country: process.env.PLATFORM_COUNTRY || operatorValues.country || values.platformCountry || 'Sweden',
      organisationNumber: process.env.PLATFORM_ORGANISATION_NUMBER || operatorValues.organisationNumber || null,
      vatNumber: process.env.PLATFORM_VAT_NUMBER || operatorValues.vatNumber || null,
      registeredAddress: process.env.PLATFORM_REGISTERED_ADDRESS || operatorValues.registeredAddress || null,
    };
    const legalValues = values.legal || {};
    const directChargeVerified = environmentBoolean('PAYMENT_DIRECT_CHARGE_VERIFIED');
    this.legal = {
      paymentProvider: process.env.PAYMENT_PROVIDER ?? legalValues.paymentProvider ?? null,
      paymentProviderPrivacyUrl: process.env.PAYMENT_PROVIDER_PRIVACY_URL ?? legalValues.paymentProviderPrivacyUrl ?? null,
      billingSupportEmail: process.env.BILLING_SUPPORT_EMAIL ?? legalValues.billingSupportEmail ?? null,
      ticketSupportEmail: process.env.TICKET_SUPPORT_EMAIL ?? legalValues.ticketSupportEmail ?? null,
      ticketSupportUrl: process.env.TICKET_SUPPORT_URL ?? legalValues.ticketSupportUrl ?? null,
      venueSupportEmail: process.env.VENUE_SUPPORT_EMAIL ?? legalValues.venueSupportEmail ?? null,
      venueSupportUrl: process.env.VENUE_SUPPORT_URL ?? legalValues.venueSupportUrl ?? null,
      organizerSupportUrl: process.env.ORGANIZER_SUPPORT_URL ?? legalValues.organizerSupportUrl ?? null,
      businessSupportUrl: process.env.BUSINESS_SUPPORT_URL ?? legalValues.businessSupportUrl ?? null,
      withdrawalFunctionUrl: process.env.WITHDRAWAL_FUNCTION_URL ?? legalValues.withdrawalFunctionUrl ?? null,
      analyticsProviders: process.env.ANALYTICS_PROVIDERS ?? legalValues.analyticsProviders ?? null,
      marketingProviders: process.env.MARKETING_PROVIDERS ?? legalValues.marketingProviders ?? null,
      cookieInventory: process.env.COOKIE_INVENTORY ?? legalValues.cookieInventory ?? null,
      subprocessors: configuredArray('SUBPROCESSORS_JSON', process.env.SUBPROCESSORS_JSON ?? legalValues.subprocessors),
      directChargeVerified: directChargeVerified ?? legalValues.directChargeVerified === true,
    };
    const databaseValues = values.database && typeof values.database === 'object' ? values.database : null;
    this.database = databaseValues || {
      host: values.host ?? process.env.DB_HOST,
      user: values.user ?? process.env.DB_USER,
      password: values.password ?? process.env.DB_PASSWORD,
      database: typeof values.database === 'string' ? values.database : values.databaseName ?? process.env.DB_NAME,
      port: Number(values.port ?? process.env.DB_PORT ?? 3306),
    };

    const emailValues = values.email || {};
    const emailUrls = emailValues.urls || {};
    const emailFrom = emailValues.from || {};
    this.email = {
      smtp: emailValues.smtp || values.smtp || {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        verification: { user: process.env.SMTP_VERIFICATION_USER, password: process.env.SMTP_VERIFICATION_PASSWORD },
        applicationNotification: { user: process.env.APPLICATION_NOTIFICATION_USER, password: process.env.APPLICATION_NOTIFICATION_PASSWORD },
        invitation: { user: process.env.INVITATION_USER, password: process.env.INVITATION_PASSWORD },
      },
      from: {
        noReply: process.env.NO_REPLY_FROM || emailFrom.noReply || values.noReplyFrom || `no-reply@${domain}`,
        applicationNotification: process.env.APPLICATION_NOTIFICATION_FROM || emailFrom.applicationNotification || values.applicationNotificationFrom || `info@${domain}`,
        invitation: process.env.INVITATION_FROM || emailFrom.invitation || values.invitationFrom || `hello@${domain}`,
      },
      urls: {
        verification: process.env.EMAIL_VERIFICATION_URL || emailUrls.verification || values.emailVerificationUrl || `${siteUrl}/verify-email`,
        passwordReset: process.env.PASSWORD_RESET_URL || emailUrls.passwordReset || values.passwordResetUrl || `${siteUrl}/reset-password`,
        application: process.env.ADMIN_APPLICATION_URL || emailUrls.application || values.adminApplicationUrl || `${siteUrl}/admin/applications`,
        managerEvent: process.env.MANAGER_EVENT_URL || emailUrls.managerEvent || values.managerEventUrl || `${siteUrl}/manager/events`,
        eventDetails: process.env.EVENT_DETAILS_URL || emailUrls.eventDetails || values.eventDetailsUrl || `${siteUrl}/events`,
        invitationResponse: process.env.INVITATION_RESPONSE_URL || emailUrls.invitationResponse || values.invitationResponseUrl || `${siteUrl}/invitation-response`,
        groupInvitation: process.env.GROUP_INVITATION_URL || emailUrls.groupInvitation || values.groupInvitationUrl || `${siteUrl}/group-invitation`,
        login: process.env.LOGIN_URL || emailUrls.login || values.loginUrl || `${siteUrl}/login`,
        unsubscribe: process.env.UNSUBSCRIBE_URL || emailUrls.unsubscribe || values.unsubscribeUrl || `${siteUrl}/unsubscribe`,
        unsubscribeEndpoint: process.env.UNSUBSCRIBE_ENDPOINT_URL || emailUrls.unsubscribeEndpoint || values.unsubscribeEndpointUrl || `${apiUrl}/api/email/unsubscribe`,
      },
    };

    const ftpValues = values.ftp || {};
    const profile = ftpValues.profilePictures || values.ftpProfilePictures;
    const events = ftpValues.events || values.ftpEvents;
    const venues = ftpValues.venues || values.ftpVenues;
    const groups = ftpValues.groups || values.ftpGroups;
    const articles = ftpValues.articles || values.ftpArticles;
    this.ftp = {
      profilePictures: profile || ftpConfig({
        host: process.env.FTP_PROFILE_HOST || process.env.FTP_PROFILE_IP,
        user: process.env.FTP_PROFILE_USERNAME,
        password: process.env.FTP_PROFILE_PASSWORD,
        uploadPath: process.env.FTP_PROFILE_UPLOAD_PATH,
        publicUrl: process.env.FTP_PROFILE_PUBLIC_URL || `${apiUrl}/uploads/profile-pictures`,
        tlsServername: process.env.FTP_PROFILE_TLS_SERVERNAME,
        secure: process.env.FTP_PROFILE_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_PROFILE_TIMEOUT_MS || 30000),
      }),
      events: events || ftpConfig({
        host: process.env.FTP_EVENT_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_EVENT_USERNAME,
        password: process.env.FTP_EVENT_PASSWORD,
        uploadPath: process.env.FTP_EVENT_UPLOAD_PATH,
        publicUrl: process.env.FTP_EVENT_PUBLIC_URL || `${apiUrl}/uploads/event-covers`,
        tlsServername: process.env.FTP_EVENT_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_EVENT_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      venues: venues || ftpConfig({
        host: process.env.FTP_VENUE_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_VENUE_USERNAME,
        password: process.env.FTP_VENUE_PASSWORD,
        uploadPath: process.env.FTP_VENUE_UPLOAD_PATH,
        publicUrl: process.env.FTP_VENUE_PUBLIC_URL || `${apiUrl}/uploads/venue-images`,
        tlsServername: process.env.FTP_VENUE_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_VENUE_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      groups: groups || ftpConfig({
        host: process.env.FTP_GROUP_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_GROUP_USERNAME,
        password: process.env.FTP_GROUP_PASSWORD,
        uploadPath: process.env.FTP_GROUP_UPLOAD_PATH,
        publicUrl: process.env.FTP_GROUP_PUBLIC_URL || `${apiUrl}/uploads/group-covers`,
        tlsServername: process.env.FTP_GROUP_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_GROUP_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      articles: articles || ftpConfig({
        host: process.env.FTP_ARTICLE_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_ARTICLE_USERNAME,
        password: process.env.FTP_ARTICLE_PASSWORD,
        uploadPath: process.env.FTP_ARTICLE_UPLOAD_PATH,
        publicUrl: process.env.FTP_ARTICLE_PUBLIC_URL || `${apiUrl}/uploads/article-images`,
        tlsServername: process.env.FTP_ARTICLE_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_ARTICLE_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
    };

    // A local configuration file is intentionally ignored by git, but its
    // values should still be overridable in deployment. This is particularly
    // important for FTP roots: Hostinger accounts may be rooted at
    // public_html or one level above it.
    const overrideFtp = (current, prefix, genericPrefix = null) => {
      const env = (name) => process.env[name];
      const first = (...names) => names.map(env).find((value) => value !== undefined);
      const value = (key, ...names) => {
        const selected = first(...names);
        if (selected !== undefined) current[key] = selected;
      };
      value('host', `${prefix}_HOST`, ...(genericPrefix ? [`${genericPrefix}_HOST`, `${genericPrefix}_IP`] : []));
      value('user', `${prefix}_USERNAME`, ...(genericPrefix ? [`${genericPrefix}_USER`] : []));
      value('password', `${prefix}_PASSWORD`, ...(genericPrefix ? [`${genericPrefix}_PASSWORD`] : []));
      value('uploadPath', `${prefix}_UPLOAD_PATH`, ...(genericPrefix ? [`${genericPrefix}_UPLOAD_PATH`] : []));
      value('publicUrl', `${prefix}_PUBLIC_URL`, ...(genericPrefix ? [`${genericPrefix}_PUBLIC_URL`] : []));
      value('tlsServername', `${prefix}_TLS_SERVERNAME`, ...(genericPrefix ? [`${genericPrefix}_TLS_SERVERNAME`] : []));
      value('secure', `${prefix}_SECURE`, ...(genericPrefix ? [`${genericPrefix}_SECURE`] : []));
      const timeout = first(`${prefix}_TIMEOUT_MS`, ...(genericPrefix ? [`${genericPrefix}_TIMEOUT_MS`] : []));
      if (timeout !== undefined) current.timeoutMs = Number(timeout || 30000);
      current.secure = current.secure === true || current.secure === 'true';
      return current;
    };
    overrideFtp(this.ftp.profilePictures, 'FTP_PROFILE');
    overrideFtp(this.ftp.events, 'FTP_EVENT');
    overrideFtp(this.ftp.venues, 'FTP_VENUE');
    overrideFtp(this.ftp.groups, 'FTP_GROUP');
    overrideFtp(this.ftp.articles, 'FTP_ARTICLE');

    const runtimeValues = values.runtime || {};
    const retentionValues = runtimeValues.retention || values.retention || {};
    // Environment values are evaluated here (rather than trusting the
    // imported config module) so deployment-pipeline variables always win,
    // including when an old ignored config.local.js remains on a server.
    const mapsEnabled = environmentBoolean('GOOGLE_MAPS_ENABLED');
    const mapsRequiresConsent = environmentBoolean('GOOGLE_MAPS_REQUIRES_CONSENT');
    this.runtime = {
      uploadsDir: runtimeValues.uploadsDir || values.uploadsDir || process.env.UPLOADS_DIR || 'uploads',
      port: Number(runtimeValues.port ?? values.port ?? process.env.PORT ?? 3001),
      authSecret: runtimeValues.authSecret || values.authSecret || process.env.AUTH_SECRET,
      allowedOrigins: runtimeValues.allowedOrigins || this.getAllowedOrigins(),
      minimumUserAge: Number(process.env.MINIMUM_USER_AGE || runtimeValues.minimumUserAge || values.minimumUserAge || 18),
      paidEventsEnabled: process.env.ENABLE_PAID_EVENTS === 'true' || runtimeValues.paidEventsEnabled === true || values.paidEventsEnabled === true,
      paidServicesEnabled: process.env.ENABLE_PAID_SERVICES === 'true' || runtimeValues.paidServicesEnabled === true || values.paidServicesEnabled === true,
      legalRequireReady: process.env.LEGAL_REQUIRE_READY === 'true' || runtimeValues.legalRequireReady === true || values.legalRequireReady === true,
      maps: {
        enabled: mapsEnabled ?? (runtimeValues.maps?.enabled === true || values.maps?.enabled === true),
        browserApiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY ?? runtimeValues.maps?.browserApiKey ?? values.maps?.browserApiKey ?? null,
        // This value is never exposed through an API response.
        serverApiKey: process.env.GOOGLE_MAPS_SERVER_API_KEY ?? runtimeValues.maps?.serverApiKey ?? values.maps?.serverApiKey ?? null,
        requiresConsent: mapsRequiresConsent ?? (runtimeValues.maps?.requiresConsent === true || values.maps?.requiresConsent === true),
      },
      stripe: {
        // These are intentionally retained only in server runtime
        // configuration. API responses never serialize this object.
        secretKey: process.env.STRIPE_SECRET_KEY ?? runtimeValues.stripe?.secretKey ?? values.stripe?.secretKey ?? null,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? runtimeValues.stripe?.publishableKey ?? values.stripe?.publishableKey ?? null,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? runtimeValues.stripe?.webhookSecret ?? values.stripe?.webhookSecret ?? null,
        thinWebhookSecret: process.env.STRIPE_THIN_WEBHOOK_SECRET ?? runtimeValues.stripe?.thinWebhookSecret ?? null,
        applicationFeePercent: Number(process.env.STRIPE_APPLICATION_FEE_PERCENT ?? runtimeValues.stripe?.applicationFeePercent ?? 0),
      },
      retention: {
        passwordResetDays: Number(process.env.RETENTION_PASSWORD_RESET_DAYS || retentionValues.passwordResetDays || 7),
        verificationTokenDays: Number(process.env.RETENTION_VERIFICATION_TOKEN_DAYS || retentionValues.verificationTokenDays || 30),
        invitationDays: Number(process.env.RETENTION_INVITATION_DAYS || retentionValues.invitationDays || 30),
        securityLogDays: Number(process.env.RETENTION_SECURITY_LOG_DAYS || retentionValues.securityLogDays || 180),
      },
    };
    if (typeof this.runtime.authSecret !== 'string' || this.runtime.authSecret.length < 32 || /^(?:change-this-auth-secret|password|secret|test)$/i.test(this.runtime.authSecret.trim()) || /^(.)\1+$/.test(this.runtime.authSecret.trim())) {
      throw new Error('AUTH_SECRET must be configured with at least 32 random characters.');
    }
    if (!Array.isArray(this.runtime.allowedOrigins) || this.runtime.allowedOrigins.some((origin) => origin === '*')) {
      throw new Error('CORS origins must be an explicit allowlist and cannot include "*".');
    }
    if (!Number.isInteger(this.runtime.minimumUserAge) || this.runtime.minimumUserAge < 18 || this.runtime.minimumUserAge > 120) {
      throw new Error('MINIMUM_USER_AGE must be a whole number from 18 to 120 while minors are unsupported.');
    }
    if (process.env.NODE_ENV === 'production' && ['name', 'email', 'privacyEmail', 'supportEmail', 'moderationEmail'].some((key) => !this.operator[key])) {
      throw new Error('Production requires PLATFORM_OPERATOR_NAME, PLATFORM_OPERATOR_EMAIL, PRIVACY_EMAIL, SUPPORT_EMAIL and MODERATION_EMAIL.');
    }
    if (process.env.NODE_ENV === 'production' && this.runtime.maps.enabled && !this.runtime.maps.browserApiKey) {
      throw new Error('GOOGLE_MAPS_BROWSER_API_KEY is required when GOOGLE_MAPS_ENABLED=true in production.');
    }
    if (this.runtime.maps.serverApiKey && this.runtime.maps.serverApiKey === this.runtime.maps.browserApiKey) {
      throw new Error('GOOGLE_MAPS_BROWSER_API_KEY and GOOGLE_MAPS_SERVER_API_KEY must be separate keys.');
    }
    for (const [name, days] of Object.entries(this.runtime.retention)) {
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error(`Retention setting ${name} must be a whole number from 1 to 3650.`);
    }
  }

  getAllowedOrigins() {
    const configured = process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
    const localOrigins = process.env.NODE_ENV === 'production' ? [] : [
      'http://localhost:5173', 'http://127.0.0.1:5173',
      'http://localhost:4173', 'http://127.0.0.1:4173',
      'http://localhost:3000', 'http://127.0.0.1:3000',
    ];
    return [...new Set([`https://${this.site.domain}`, `https://www.${this.site.domain}`, ...localOrigins, ...(configured || [])])];
  }
}
