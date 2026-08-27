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
