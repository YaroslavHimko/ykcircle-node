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
    const domain = siteValues.domain || values.domain || process.env.DOMAIN || 'ykcircle.com';
    const siteUrl = (siteValues.siteUrl || values.siteUrl || process.env.SITE_URL || `https://${domain}`).replace(/\/$/, '');
    const apiUrl = (siteValues.apiUrl || values.apiUrl || process.env.API_URL || `https://api.${domain}`).replace(/\/$/, '');

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
        noReply: emailFrom.noReply || values.noReplyFrom || process.env.NO_REPLY_FROM || `no-reply@${domain}`,
        applicationNotification: emailFrom.applicationNotification || values.applicationNotificationFrom || process.env.APPLICATION_NOTIFICATION_FROM || `info@${domain}`,
        invitation: emailFrom.invitation || values.invitationFrom || process.env.INVITATION_FROM || `hello@${domain}`,
      },
      urls: {
        verification: emailUrls.verification || values.emailVerificationUrl || process.env.EMAIL_VERIFICATION_URL || `${siteUrl}/verify-email`,
        application: emailUrls.application || values.adminApplicationUrl || process.env.ADMIN_APPLICATION_URL || `${siteUrl}/admin/applications`,
        managerEvent: emailUrls.managerEvent || values.managerEventUrl || process.env.MANAGER_EVENT_URL || `${siteUrl}/manager/events`,
        eventDetails: emailUrls.eventDetails || values.eventDetailsUrl || process.env.EVENT_DETAILS_URL || `${siteUrl}/events`,
        invitationResponse: emailUrls.invitationResponse || values.invitationResponseUrl || process.env.INVITATION_RESPONSE_URL || `${siteUrl}/invitation-response`,
        groupInvitation: emailUrls.groupInvitation || values.groupInvitationUrl || process.env.GROUP_INVITATION_URL || `${siteUrl}/group-invitation`,
        login: emailUrls.login || values.loginUrl || process.env.LOGIN_URL || `${siteUrl}/login`,
        unsubscribe: emailUrls.unsubscribe || values.unsubscribeUrl || process.env.UNSUBSCRIBE_URL || `${siteUrl}/unsubscribe`,
        unsubscribeEndpoint: emailUrls.unsubscribeEndpoint || values.unsubscribeEndpointUrl || process.env.UNSUBSCRIBE_ENDPOINT_URL || `${apiUrl}/api/email/unsubscribe`,
      },
    };

    const ftpValues = values.ftp || {};
    const profile = ftpValues.profilePictures || values.ftpProfilePictures;
    const events = ftpValues.events || values.ftpEvents;
    const groups = ftpValues.groups || values.ftpGroups;
    const articles = ftpValues.articles || values.ftpArticles;
    this.ftp = {
      profilePictures: profile || ftpConfig({
        host: process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_USERNAME,
        password: process.env.FTP_PASSWORD,
        uploadPath: process.env.FTP_UPLOAD_PATH,
        publicUrl: process.env.FTP_PUBLIC_URL || `${apiUrl}/uploads/profile-pictures`,
        tlsServername: process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      events: events || ftpConfig({
        host: process.env.FTP_EVENT_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_EVENT_USERNAME || 'u767010421.event',
        password: process.env.FTP_EVENT_PASSWORD,
        uploadPath: process.env.FTP_EVENT_UPLOAD_PATH,
        publicUrl: process.env.FTP_EVENT_PUBLIC_URL || `${apiUrl}/uploads/event-covers`,
        tlsServername: process.env.FTP_EVENT_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_EVENT_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      groups: groups || ftpConfig({
        host: process.env.FTP_GROUP_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_GROUP_USERNAME || 'u767010421.group',
        password: process.env.FTP_GROUP_PASSWORD,
        uploadPath: process.env.FTP_GROUP_UPLOAD_PATH,
        publicUrl: process.env.FTP_GROUP_PUBLIC_URL || `${apiUrl}/uploads/group-covers`,
        tlsServername: process.env.FTP_GROUP_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_GROUP_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
      articles: articles || ftpConfig({
        host: process.env.FTP_ARTICLE_HOST || process.env.FTP_HOST || process.env.FTP_IP,
        user: process.env.FTP_ARTICLE_USERNAME || 'u767010421.article',
        password: process.env.FTP_ARTICLE_PASSWORD,
        uploadPath: process.env.FTP_ARTICLE_UPLOAD_PATH,
        publicUrl: process.env.FTP_ARTICLE_PUBLIC_URL || `${apiUrl}/uploads/article-images`,
        tlsServername: process.env.FTP_ARTICLE_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME,
        secure: process.env.FTP_ARTICLE_SECURE === 'true',
        timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000),
      }),
    };

    const runtimeValues = values.runtime || {};
    this.runtime = {
      uploadsDir: runtimeValues.uploadsDir || values.uploadsDir || process.env.UPLOADS_DIR || 'uploads',
      port: Number(runtimeValues.port ?? values.port ?? process.env.PORT ?? 3001),
      authSecret: runtimeValues.authSecret || values.authSecret || process.env.AUTH_SECRET || 'change-this-auth-secret',
      allowedOrigins: runtimeValues.allowedOrigins || this.getAllowedOrigins(),
    };
    this.allowedOrigins = this.runtime.allowedOrigins;

    // Compatibility aliases for consumers that have not moved to grouped config yet.
    this.domain = this.site.domain;
    this.siteUrl = this.site.siteUrl;
    this.apiUrl = this.site.apiUrl;
    this.brandName = this.site.brandName;
    this.smtp = this.email.smtp;
    this.emailVerificationUrl = this.email.urls.verification;
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
    return configured?.length ? [`https://${this.site.domain}`, `https://www.${this.site.domain}`, ...configured] : undefined;
  }
}
