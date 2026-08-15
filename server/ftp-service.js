import ftp from 'basic-ftp';
import { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';

const IMAGE_TYPES = new Map([
  ['image/jpeg', { extension: 'jpg', signature: (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: 'png', signature: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/gif', { extension: 'gif', signature: (buffer) => buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a' }],
  ['image/webp', { extension: 'webp', signature: (buffer) => buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' }],
]);

export class FtpService {
  constructor(config) {
    this.config = config;
    this.enabled = Boolean(config.host && config.user && config.password && config.uploadPath);
  }

  validateImage(file) {
    const type = IMAGE_TYPES.get(file.mimetype);
    if (!type || !type.signature(file.buffer)) {
      const error = new Error('Only valid JPEG, PNG, GIF, and WebP images are allowed.');
      error.code = 'INVALID_IMAGE';
      throw error;
    }
    return type.extension;
  }

  async uploadProfilePicture(userId, file) {
    if (!this.enabled) { const error = new Error('FTP profile picture storage is not configured.'); error.code = 'FTP_NOT_CONFIGURED'; throw error; }
    const extension = this.validateImage(file);
    const remoteName = `user-${userId}-${Date.now()}.${extension}`;
    const remotePath = `${this.config.uploadPath.replace(/[\\/]+$/, '')}/${remoteName}`;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.ensureDir(this.config.uploadPath);
      await client.uploadFrom(Readable.from(file.buffer), remotePath);
      return `/uploads/profile-pictures/${remoteName}`;
    } finally { client.close(); }
  }

  async uploadEventCover(eventId, file) {
    if (!this.enabled) { const error = new Error('FTP event image storage is not configured.'); error.code = 'FTP_NOT_CONFIGURED'; throw error; }
    const extension = this.validateImage(file);
    const remoteName = `event-${eventId}-${Date.now()}.${extension}`;
    const uploadPath = this.config.eventUploadPath || this.config.uploadPath;
    const remotePath = `${uploadPath.replace(/[\\/]+$/, '')}/${remoteName}`;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.ensureDir(uploadPath);
      await client.uploadFrom(Readable.from(file.buffer), remotePath);
      return `/uploads/event-covers/${remoteName}`;
    } finally { client.close(); }
  }

  async uploadGroupCover(groupId, file) {
    const type = IMAGE_TYPES.get(file.mimetype);
    if (!type || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) || !type.signature(file.buffer)) {
      const error = new Error('Only valid JPEG, PNG, and WebP images are allowed.');
      error.code = 'INVALID_IMAGE';
      throw error;
    }
    if (!this.enabled) { const error = new Error('FTP group image storage is not configured.'); error.code = 'FTP_NOT_CONFIGURED'; throw error; }
    const remoteName = `group-${groupId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${type.extension}`;
    const remotePath = `${this.config.uploadPath.replace(/[\\/]+$/, '')}/${remoteName}`;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.ensureDir(this.config.uploadPath);
      await client.uploadFrom(Readable.from(file.buffer), remotePath);
      return remoteName;
    } finally { client.close(); }
  }

  async streamProfilePicture(filename, response) {
    return this.streamImage(filename, this.config.uploadPath, response);
  }

  async streamEventCover(filename, response) {
    return this.streamImage(filename, this.config.eventUploadPath || this.config.uploadPath, response);
  }

  async streamGroupCover(filename, response) {
    return this.streamImage(filename, this.config.uploadPath, response, 'private, no-store');
  }

  async uploadArticleImage(articleId, file) {
    if (!this.enabled) { const error = new Error('FTP article image storage is not configured.'); error.code = 'FTP_NOT_CONFIGURED'; throw error; }
    const extension = this.validateImage(file);
    const remoteName = `article-${articleId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    const remotePath = `${this.config.uploadPath.replace(/[\\/]+$/, '')}/${remoteName}`;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.ensureDir(this.config.uploadPath);
      await client.uploadFrom(Readable.from(file.buffer), remotePath);
      return remoteName;
    } finally { client.close(); }
  }

  async streamArticleImage(filename, response) { return this.streamImage(filename, this.config.uploadPath, response); }

  async deleteArticleImage(filename) {
    if (!this.enabled || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(filename)) return false;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.remove(`${this.config.uploadPath.replace(/[\\/]+$/, '')}/${filename}`);
      return true;
    } catch (error) { if (String(error.code) === '550') return false; throw error; } finally { client.close(); }
  }

  async deleteGroupCover(filename) {
    if (!this.enabled || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(filename)) return false;
    const remotePath = `${this.config.uploadPath.replace(/[\\/]+$/, '')}/${filename}`;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.remove(remotePath);
      return true;
    } catch (error) {
      if (String(error.code) === '550') return false;
      throw error;
    } finally { client.close(); }
  }

  async streamImage(filename, uploadPath, response, cacheControl = 'public, max-age=86400') {
    if (!this.enabled || !uploadPath || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(filename)) return false;
    const remotePath = `${uploadPath.replace(/[\\/]+$/, '')}/${filename}`;
    const contentTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const extension = filename.split('.').pop().toLowerCase();
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    const stream = new PassThrough();
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      response.set('Content-Type', contentTypes[extension]);
      response.set('Cache-Control', cacheControl);
      stream.on('close', () => client.close());
      stream.pipe(response);
      await client.downloadTo(stream, remotePath);
      stream.end();
      return true;
    } catch (error) {
      client.close();
      if (!response.headersSent) return false;
      stream.destroy(error);
      return true;
    }
  }
}

export { IMAGE_TYPES };
