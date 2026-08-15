export class Configuration {
  constructor(values = {}) {
    this.domain = values.domain || process.env.DOMAIN || 'yarohimko.com';
    this.siteUrl = values.siteUrl || process.env.SITE_URL || `https://${this.domain}`;
    this.brandName = values.brandName || process.env.BRAND_NAME || this.domain;
    this.noReplyFrom = values.noReplyFrom || process.env.NO_REPLY_FROM || `no-reply@${this.domain}`;
    const siteUrl = this.siteUrl.replace(/\/$/, '');
    this.database = {
      host: values.host ?? process.env.DB_HOST,
      user: values.user ?? process.env.DB_USER,
      password: values.password ?? process.env.DB_PASSWORD,
      database: values.database ?? process.env.DB_NAME,
      port: Number(values.port ?? process.env.DB_PORT ?? 3306),
    };
    this.smtp = values.smtp ?? {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      verification: { user: process.env.SMTP_VERIFICATION_USER, password: process.env.SMTP_VERIFICATION_PASSWORD },
      applicationNotification: { user: process.env.APPLICATION_NOTIFICATION_USER, password: process.env.APPLICATION_NOTIFICATION_PASSWORD },
      invitation: { user: process.env.INVITATION_USER, password: process.env.INVITATION_PASSWORD },
    };
    this.emailVerificationUrl = values.emailVerificationUrl || process.env.EMAIL_VERIFICATION_URL || `${siteUrl}/verify-email`;
    this.applicationNotificationFrom = values.applicationNotificationFrom || process.env.APPLICATION_NOTIFICATION_FROM || `info@${this.domain}`;
    this.invitationFrom = values.invitationFrom || process.env.INVITATION_FROM || `hello@${this.domain}`;
    this.adminApplicationUrl = values.adminApplicationUrl || process.env.ADMIN_APPLICATION_URL || `${siteUrl}/admin/applications`;
    this.managerEventUrl = values.managerEventUrl || process.env.MANAGER_EVENT_URL || `${siteUrl}/manager/events`;
    this.eventDetailsUrl = values.eventDetailsUrl || process.env.EVENT_DETAILS_URL || `${siteUrl}/events`;
    this.invitationResponseUrl = values.invitationResponseUrl || process.env.INVITATION_RESPONSE_URL || `${siteUrl}/invitation-response`;
    this.loginUrl = values.loginUrl || process.env.LOGIN_URL || `${siteUrl}/login`;
    this.unsubscribeUrl = values.unsubscribeUrl || process.env.UNSUBSCRIBE_URL || `${siteUrl}/unsubscribe`;
    this.unsubscribeEndpointUrl = values.unsubscribeEndpointUrl || process.env.UNSUBSCRIBE_ENDPOINT_URL || `${siteUrl}/api/email/unsubscribe`;
    this.ftp = values.ftp ?? { host: process.env.FTP_HOST || process.env.FTP_IP, user: process.env.FTP_USERNAME, password: process.env.FTP_PASSWORD, uploadPath: process.env.FTP_UPLOAD_PATH, publicUrl: process.env.FTP_PUBLIC_URL || `${siteUrl}/uploads/profile-pictures`, eventUploadPath: process.env.FTP_EVENT_UPLOAD_PATH, eventPublicUrl: process.env.FTP_EVENT_PUBLIC_URL || `${siteUrl}/uploads/event-covers`, tlsServername: process.env.FTP_TLS_SERVERNAME, secure: process.env.FTP_SECURE === 'true', timeoutMs: Number(process.env.FTP_TIMEOUT_MS || 30000) };
    this.ftpEvents = values.ftpEvents ?? { host: process.env.FTP_EVENT_HOST || process.env.FTP_HOST || process.env.FTP_IP, user: process.env.FTP_EVENT_USERNAME || 'u767010421.event', password: process.env.FTP_EVENT_PASSWORD, uploadPath: process.env.FTP_EVENT_UPLOAD_PATH, publicUrl: process.env.FTP_EVENT_PUBLIC_URL || `${siteUrl}/uploads/event-covers`, tlsServername: process.env.FTP_EVENT_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME, secure: process.env.FTP_EVENT_SECURE === 'true', timeoutMs: Number(process.env.FTP_EVENT_TIMEOUT_MS || process.env.FTP_TIMEOUT_MS || 30000) };
    this.ftpGroups = values.ftpGroups ?? { host: process.env.FTP_GROUP_HOST || process.env.FTP_HOST || process.env.FTP_IP, user: process.env.FTP_GROUP_USERNAME || 'u767010421.group', password: process.env.FTP_GROUP_PASSWORD, uploadPath: process.env.FTP_GROUP_UPLOAD_PATH, publicUrl: process.env.FTP_GROUP_PUBLIC_URL || `${siteUrl}/uploads/group-covers`, tlsServername: process.env.FTP_GROUP_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME, secure: process.env.FTP_GROUP_SECURE === 'true', timeoutMs: Number(process.env.FTP_GROUP_TIMEOUT_MS || process.env.FTP_TIMEOUT_MS || 30000) };
    this.ftpArticles = values.ftpArticles ?? { host: process.env.FTP_ARTICLE_HOST || process.env.FTP_HOST || process.env.FTP_IP, user: process.env.FTP_ARTICLE_USERNAME || 'u767010421.article', password: process.env.FTP_ARTICLE_PASSWORD, uploadPath: process.env.FTP_ARTICLE_UPLOAD_PATH, publicUrl: process.env.FTP_ARTICLE_PUBLIC_URL || `${siteUrl}/uploads/article-images`, tlsServername: process.env.FTP_ARTICLE_TLS_SERVERNAME || process.env.FTP_TLS_SERVERNAME, secure: process.env.FTP_ARTICLE_SECURE === 'true', timeoutMs: Number(process.env.FTP_ARTICLE_TIMEOUT_MS || process.env.FTP_TIMEOUT_MS || 30000) };
    this.uploadsDir = values.uploadsDir || process.env.UPLOADS_DIR || 'uploads';
    this.authSecret = process.env.AUTH_SECRET || 'change-this-auth-secret';
    this.port = Number(process.env.PORT || 3001);
    this.allowedOrigins = this.getAllowedOrigins();
  }

  getAllowedOrigins() {
    const configured = process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
    return configured?.length ? [`https://${this.domain}`, `https://www.${this.domain}`, ...configured] : undefined;
  }
}
