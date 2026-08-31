import assert from 'node:assert/strict';
import test from 'node:test';
import { FtpService } from '../server/ftp-service.js';

const config = (overrides = {}) => ({
  host: 'ftp.example.test',
  user: 'tester',
  password: 'secret',
  uploadPath: '/public_html/uploads/images/',
  publicUrl: 'https://api.example.test/uploads/images/',
  ...overrides,
});

test('normalizes upload and public paths without exposing a host in asset URLs', () => {
  const service = new FtpService(config({ uploadPath: ' \\public_html\\uploads\\images\\ ', publicUrl: 'https//api.example.test/uploads/images/' }));

  assert.equal(service.config.uploadPath, '/public_html/uploads/images');
  assert.equal(service.publicPath(), '/uploads/images');
});

test('rejects deployed Node.js directories as FTP upload destinations', () => {
  assert.throws(() => new FtpService(config({ uploadPath: '/home/account/nodejs/app/uploads' })), (error) => error.code === 'UNSAFE_FTP_UPLOAD_PATH');
});

test('validates file signatures and rejects disabled storage before connecting', async () => {
  const service = new FtpService(config());
  const jpeg = { mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]) };

  assert.equal(service.validateImage(jpeg), 'jpg');
  assert.throws(() => service.validateImage({ mimetype: 'image/png', buffer: Buffer.from('not an image') }), (error) => error.code === 'INVALID_IMAGE');

  const disabled = new FtpService(config({ host: '', uploadPath: '' }));
  await assert.rejects(disabled.upload(jpeg, 'picture.jpg'), (error) => error.code === 'FTP_NOT_CONFIGURED');
});

test('does not allow path traversal when streaming or deleting images', async () => {
  const service = new FtpService(config());

  assert.equal(await service.streamImage('../secret.jpg', service.config.uploadPath, {}), false);
  assert.equal(await service.deleteArticleImage('../secret.jpg'), false);
  assert.equal(await service.deleteGroupCover('script.svg'), false);
});

test('downloads protected media before committing successful response headers', async () => {
  const service = new FtpService(config());
  let closed = 0;
  service.connect = async () => ({
    cd: async () => {},
    size: async () => 4,
    downloadTo: async (destination) => {
      destination.write(Buffer.from([137, 80]));
      destination.write(Buffer.from([78, 71]));
      destination.end();
    },
    close: () => { closed += 1; }
  });
  const response = {
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; }
  };

  assert.equal(await service.streamImage('cover.png', service.config.uploadPath, response, 'private, no-store, max-age=0'), true);
  assert.deepEqual(response.body, Buffer.from([137, 80, 78, 71]));
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(response.headers['content-length'], '4');
  assert.equal(closed, 1);
});

test('does not commit a 200 response when the FTP download fails', async () => {
  const service = new FtpService(config());
  service.connect = async () => ({
    cd: async () => {},
    size: async () => 4,
    downloadTo: async () => {
      const error = new Error('FTP data connection reset');
      error.code = 'ECONNRESET';
      throw error;
    },
    close: () => {}
  });
  const response = {
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; },
    end() { this.ended = true; }
  };

  await assert.rejects(
    service.streamImage('cover.png', service.config.uploadPath, response),
    /FTP data connection reset/
  );
  assert.deepEqual(response.headers, {});
  assert.equal(response.ended, undefined);
});
