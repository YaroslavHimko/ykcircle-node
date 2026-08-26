const domain = process.env.DOMAIN || 'ykcircle.com';
const siteUrl = (process.env.SITE_URL || `https://${domain}`).replace(/\/$/, '');
const apiUrl = (process.env.API_URL || `https://api.${domain}`).replace(/\/$/, '');

export default {
  site: {
    domain,
    siteUrl,
    apiUrl,
    brandName: process.env.BRAND_NAME || domain,
  },
  operator: {
    // The pre-incorporation controller is the founder personally. Do not put a
    // future company name here until the company migration has been approved.
    name: process.env.PLATFORM_OPERATOR_NAME,
    email: process.env.PLATFORM_OPERATOR_EMAIL,
    privacyEmail: process.env.PRIVACY_EMAIL,
    supportEmail: process.env.SUPPORT_EMAIL,
    moderationEmail: process.env.MODERATION_EMAIL,
    country: process.env.PLATFORM_COUNTRY || 'Sweden',
    organisationNumber: process.env.PLATFORM_ORGANISATION_NUMBER || null,
    registeredAddress: process.env.PLATFORM_REGISTERED_ADDRESS || null,
  },
  database: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
  },
  email: {
    smtp: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      verification: { user: process.env.SMTP_VERIFICATION_USER, password: process.env.SMTP_VERIFICATION_PASSWORD },
      applicationNotification: { user: process.env.APPLICATION_NOTIFICATION_USER, password: process.env.APPLICATION_NOTIFICATION_PASSWORD },
      invitation: { user: process.env.INVITATION_USER, password: process.env.INVITATION_PASSWORD },
    },
    from: {
      noReply: process.env.NO_REPLY_FROM || `no-reply@${domain}`,
      applicationNotification: process.env.APPLICATION_NOTIFICATION_FROM || `info@${domain}`,
      invitation: process.env.INVITATION_FROM || `hello@${domain}`,
    },
    urls: {
      verification: process.env.EMAIL_VERIFICATION_URL || `${siteUrl}/verify-email`,
      passwordReset: process.env.PASSWORD_RESET_URL || `${siteUrl}/reset-password`,
      application: process.env.ADMIN_APPLICATION_URL || `${siteUrl}/admin/applications`,
      managerEvent: process.env.MANAGER_EVENT_URL || `${siteUrl}/manager/events`,
      eventDetails: process.env.EVENT_DETAILS_URL || `${siteUrl}/events`,
      invitationResponse: process.env.INVITATION_RESPONSE_URL || `${siteUrl}/invitation-response`,
      groupInvitation: process.env.GROUP_INVITATION_URL || `${siteUrl}/group-invitation`,
      login: process.env.LOGIN_URL || `${siteUrl}/login`,
      unsubscribe: process.env.UNSUBSCRIBE_URL || `${siteUrl}/unsubscribe`,
      unsubscribeEndpoint: process.env.UNSUBSCRIBE_ENDPOINT_URL || `${apiUrl}/api/email/unsubscribe`,
    },
  },
  ftp: {
    // Store media outside Hostinger's redeployed `nodejs` application folder.
    // With a main FTP account, use persistent paths such as
    // /public_html/uploads/article-images. A domain FTP account may already
    // be chrooted to public_html, in which case use /uploads/article-images.
    // Set every matching *_UPLOAD_PATH environment variable in production.
    // Profile-picture settings use the FTP_PROFILE_* prefix.
    profilePictures: {
      host: process.env.FTP_PROFILE_HOST || process.env.FTP_PROFILE_IP,
      user: process.env.FTP_PROFILE_USERNAME,
      password: process.env.FTP_PROFILE_PASSWORD,
      uploadPath: process.env.FTP_PROFILE_UPLOAD_PATH,
      publicUrl: process.env.FTP_PROFILE_PUBLIC_URL || `${apiUrl}/uploads/profile-pictures`,
      tlsServername: process.env.FTP_PROFILE_TLS_SERVERNAME,
      secure: process.env.FTP_PROFILE_SECURE === 'true',
      timeoutMs: Number(process.env.FTP_PROFILE_TIMEOUT_MS || 30000),
    },
    events: {
      host: process.env.FTP_EVENT_HOST || process.env.FTP_HOST || process.env.FTP_HOSTNAME || process.env.FTP_IP,
      user: process.env.FTP_EVENT_USERNAME,
      password: process.env.FTP_EVENT_PASSWORD,
      uploadPath: process.env.FTP_EVENT_UPLOAD_PATH,
      publicUrl: process.env.FTP_EVENT_PUBLIC_URL || `${apiUrl}/uploads/event-covers`,
      tlsServername: process.env.FTP_EVENT_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
      secure: process.env.FTP_EVENT_SECURE === 'true',
      timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
    },
    groups: {
      host: process.env.FTP_GROUP_HOST || process.env.FTP_HOST || process.env.FTP_HOSTNAME || process.env.FTP_IP,
      user: process.env.FTP_GROUP_USERNAME,
      password: process.env.FTP_GROUP_PASSWORD,
      uploadPath: process.env.FTP_GROUP_UPLOAD_PATH,
      publicUrl: process.env.FTP_GROUP_PUBLIC_URL || `${apiUrl}/uploads/group-covers`,
      tlsServername: process.env.FTP_GROUP_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
      secure: process.env.FTP_GROUP_SECURE === 'true',
      timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
    },
    articles: {
      host: process.env.FTP_ARTICLE_HOST || process.env.FTP_HOST || process.env.FTP_HOSTNAME || process.env.FTP_IP,
      user: process.env.FTP_ARTICLE_USERNAME,
      password: process.env.FTP_ARTICLE_PASSWORD,
      uploadPath: process.env.FTP_ARTICLE_UPLOAD_PATH,
      publicUrl: process.env.FTP_ARTICLE_PUBLIC_URL || `${apiUrl}/uploads/article-images`,
      tlsServername: process.env.FTP_ARTICLE_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
      secure: process.env.FTP_ARTICLE_SECURE === 'true',
      timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
    },
  },
  runtime: {
    uploadsDir: process.env.UPLOADS_DIR || 'uploads',
    port: Number(process.env.PORT || 3001),
    authSecret: process.env.AUTH_SECRET || 'change-this-auth-secret',
    minimumUserAge: Number(process.env.MINIMUM_USER_AGE || 18),
    paidEventsEnabled: process.env.ENABLE_PAID_EVENTS === 'true',
    retention: {
      passwordResetDays: Number(process.env.RETENTION_PASSWORD_RESET_DAYS || 7),
      verificationTokenDays: Number(process.env.RETENTION_VERIFICATION_TOKEN_DAYS || 30),
      invitationDays: Number(process.env.RETENTION_INVITATION_DAYS || 30),
      securityLogDays: Number(process.env.RETENTION_SECURITY_LOG_DAYS || 180),
    },
  },
};
