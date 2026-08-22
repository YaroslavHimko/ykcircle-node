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
    overrideFtp(this.ftp.groups, 'FTP_GROUP');
    overrideFtp(this.ftp.articles, 'FTP_ARTICLE');

    const runtimeValues = values.runtime || {};
    this.runtime = {
      uploadsDir: runtimeValues.uploadsDir || values.uploadsDir || process.env.UPLOADS_DIR || 'uploads',
      port: Number(runtimeValues.port ?? values.port ?? process.env.PORT ?? 3001),
      authSecret: runtimeValues.authSecret || values.authSecret || process.env.AUTH_SECRET,
      allowedOrigins: runtimeValues.allowedOrigins || this.getAllowedOrigins(),
    };
    if (typeof this.runtime.authSecret !== 'string' || this.runtime.authSecret.length < 32) {
      throw new Error('AUTH_SECRET must be configured with at least 32 random characters.');
    }
    if (!Array.isArray(this.runtime.allowedOrigins) || this.runtime.allowedOrigins.some((origin) => origin === '*')) {
      throw new Error('CORS origins must be an explicit allowlist and cannot include "*".');
    }
    this.allowedOrigins = this.runtime.allowedOrigins;

    // Compatibility aliases for consumers that have not moved to grouped config yet.
    this.domain = this.site.domain;
    this.siteUrl = this.site.siteUrl;
    this.apiUrl = this.site.apiUrl;
    this.brandName = this.site.brandName;
    this.smtp = this.email.smtp;
    this.emailVerificationUrl = this.email.urls.verification;
    this.passwordResetUrl = this.email.urls.passwordReset;
    this.adminApplicationUrl = this.email.urls.application;
    this.managerEventUrl = this.email.urls.managerEvent;
    this.eventDetailsUrl = this.email.urls.eventDetails;
    this.invitationResponseUrl = this.email.urls.invitationResponse;
    this.groupInvitationUrl = this.email.urls.groupInvitation;
    this.loginUrl = this.email.urls.login;
    this.unsubscribeUrl = this.email.urls.unsubscribe;
    this.unsubscribeEndpointUrl = this.email.urls.unsubscribeEndpoint;
    this.noReplyFrom = this.email.from.noReply;
    this.applicationNotificationFrom = this.email.from.applicationNotification;
    this.invitationFrom = this.email.from.invitation;
    this.authSecret = this.runtime.authSecret;
    this.uploadsDir = this.runtime.uploadsDir;
    this.port = this.runtime.port;
    this.ftpProfilePictures = this.ftp.profilePictures;
    this.ftpEvents = this.ftp.events;
    this.ftpGroups = this.ftp.groups;
    this.ftpArticles = this.ftp.articles;
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
