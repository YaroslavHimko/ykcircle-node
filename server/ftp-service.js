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
    this.config = { ...config, uploadPath: this.normalizePath(config.uploadPath) };
    this.assertPersistentUploadPath();
    this.enabled = Boolean(this.config.host && this.config.user && this.config.password && this.config.uploadPath);
  }

  assertPersistentUploadPath() {
    const segments = this.config.uploadPath.toLowerCase().split('/').filter(Boolean);
    if (!segments.includes('nodejs')) return;
    const error = new Error('FTP upload paths must not be inside Hostinger\'s deployed nodejs directory. Use a persistent path such as /public_html/uploads/article-images.');
    error.code = 'UNSAFE_FTP_UPLOAD_PATH';
    throw error;
  }

  normalizePath(value) {
    const path = String(value || '').trim().replace(/\\/g, '/');
    if (!path) return '';
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  }

  publicPath() {
    const configured = String(this.config.publicUrl || '').trim();
    if (!configured) return '/uploads';
    try {
      return this.normalizePath(new URL(configured).pathname) || '/uploads';
    } catch {
      // Accept a common malformed scheme ("https//host/path") by retaining
      // only its path. API asset URLs must never contain a second host.
      const malformedUrl = configured.match(/^https?\/\/[^/]+(\/.*)?$/i);
      if (malformedUrl) return this.normalizePath(malformedUrl[1]) || '/uploads';
      return this.normalizePath(configured).replace(/^([^/])/, '/$1') || '/uploads';
    }
  }

  async connect() {
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({
        host: this.config.host,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure,
        secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined,
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async upload(file, remoteName) {
    if (!this.enabled) {
      const error = new Error('FTP image storage is not configured.');
      error.code = 'FTP_NOT_CONFIGURED';
      throw error;
    }
    const client = await this.connect();
    try {
      // ensureDir changes the current directory. Uploading the basename from
      // that directory avoids absolute-path/chroot differences between FTP
      // providers and makes reads and writes use exactly the same location.
      await client.ensureDir(this.config.uploadPath);
      await client.uploadFrom(Readable.from(file.buffer), remoteName);
      const uploadedSize = await client.size(remoteName);
      if (uploadedSize !== file.buffer.length) {
        const error = new Error(`FTP upload verification failed for ${remoteName}.`);
        error.code = 'FTP_UPLOAD_VERIFY_FAILED';
        throw error;
      }
      return remoteName;
    } finally {
      client.close();
    }
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
    const extension = this.validateImage(file);
    const remoteName = `user-${userId}-${Date.now()}.${extension}`;
    const filename = await this.upload(file, remoteName);
    return `${this.publicPath()}/${filename}`;
  }

  async uploadEventCover(eventId, file) {
    const extension = this.validateImage(file);
    const remoteName = `event-${eventId}-${Date.now()}.${extension}`;
    const filename = await this.upload(file, remoteName);
    return `${this.publicPath()}/${filename}`;
  }

  async uploadVenueImage(venueId, file) {
    const extension = this.validateImage(file);
    const remoteName = `venue-${venueId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    return this.upload(file, remoteName);
  }

  async uploadGroupCover(groupId, file) {
    const type = IMAGE_TYPES.get(file.mimetype);
    if (!type || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) || !type.signature(file.buffer)) {
      const error = new Error('Only valid JPEG, PNG, and WebP images are allowed.');
      error.code = 'INVALID_IMAGE';
      throw error;
    }
    const remoteName = `group-${groupId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${type.extension}`;
    return this.upload(file, remoteName);
  }

  async streamProfilePicture(filename, response) {
    return this.streamImage(filename, this.config.uploadPath, response);
  }

  // An omitted cacheControl inherits streamImage's public default, so the
  // canonical header value stays defined in exactly one place.
  async streamEventCover(filename, response, cacheControl) {
    return this.streamImage(filename, this.config.eventUploadPath || this.config.uploadPath, response, cacheControl);
  }

  async streamVenueImage(filename, response, cacheControl) {
    return this.streamImage(filename, this.config.uploadPath, response, cacheControl);
  }

  async streamGroupCover(filename, response, cacheControl) {
    return this.streamImage(filename, this.config.uploadPath, response, cacheControl);
  }

  async uploadArticleImage(articleId, file) {
    const extension = this.validateImage(file);
    const remoteName = `article-${articleId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    return this.upload(file, remoteName);
  }

  async streamArticleImage(filename, response) { return this.streamImage(filename, this.config.uploadPath, response); }

  async deleteArticleImage(filename) {
    if (!this.enabled || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(filename)) return false;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.cd(this.config.uploadPath);
      await client.remove(filename);
      return true;
    } catch (error) { if (String(error.code) === '550') return false; throw error; } finally { client.close(); }
  }

  async deleteGroupCover(filename) {
    if (!this.enabled || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(filename)) return false;
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      await client.cd(this.config.uploadPath);
      await client.remove(filename);
      return true;
    } catch (error) {
      if (String(error.code) === '550') return false;
      throw error;
    } finally { client.close(); }
  }

  async streamImage(filename, uploadPath, response, cacheControl = 'public, max-age=86400') {
    uploadPath = this.normalizePath(uploadPath || this.config.uploadPath);
    const validFilename = /^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(filename);
    const remotePath = validFilename && uploadPath ? `${uploadPath}/${filename}` : null;
    if (!this.enabled || !uploadPath || !validFilename) {
      console.warn('FTP image read skipped.', { filename, remotePath, configured: this.enabled });
      return false;
    }
    const contentTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const extension = filename.split('.').pop().toLowerCase();
    const client = new ftp.Client(this.config.timeoutMs);
    client.ftp.verbose = false;
    const stream = new PassThrough();
    let stage = 'connect';
    try {
      await client.access({ host: this.config.host, user: this.config.user, password: this.config.password, secure: this.config.secure, secureOptions: this.config.tlsServername ? { servername: this.config.tlsServername } : undefined });
      stage = 'change-directory';
      await client.cd(uploadPath);
      // Check existence before sending response headers. A missing file is a
      // genuine 404; connection/authentication failures must remain errors.
      stage = 'check-file';
      await client.size(filename);
      response.set('Content-Type', contentTypes[extension]);
      response.set('Cache-Control', cacheControl);
      stream.on('close', () => client.close());
      stream.pipe(response);
      stage = 'download-file';
      await client.downloadTo(stream, filename);
      stream.end();
      return true;
    } catch (error) {
      client.close();
      const code = String(error.code || '');
      // FTP 550/450 can also mean a bad directory or insufficient permission.
      // Treat them as a 404 only after the directory was entered successfully
      // and the individual file check failed; every other case remains a 502.
      if ((code === '550' || code === '450') && stage === 'check-file') {
        console.warn('FTP image is missing from configured storage.', { filename, remotePath, stage, code });
        return false;
      }
      console.error('FTP image read failed.', { filename, remotePath, stage, code: code || null });
      if (!response.headersSent) throw error;
      stream.destroy(error);
      return true;
    }
  }
}

export { IMAGE_TYPES };
