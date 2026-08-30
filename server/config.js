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
    authSecret: process.env.AUTH_SECRET,
    maps: {
      enabled: process.env.GOOGLE_MAPS_ENABLED === 'true',
      browserApiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY,
      serverApiKey: process.env.GOOGLE_MAPS_SERVER_API_KEY,
      requiresConsent: process.env.GOOGLE_MAPS_REQUIRES_CONSENT === 'true',
    },
  },
};
