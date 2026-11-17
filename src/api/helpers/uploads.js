import multer from 'multer';

export function createHttpUploads({
  ftpService,
  eventFtpService,
  venueFtpService,
  groupFtpService,
  articleFtpService,
}) {
  const uploadProfilePicture = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) =>
      callback(
        null,
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype),
      ),
  });
  const parseProfilePicture = (req, res, next) =>
    uploadProfilePicture.single('profilePicture')(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'Profile picture must not exceed 5 MB.' });
      return res.status(400).json({ error: 'Only one JPEG, PNG, GIF, or WebP image is allowed.' });
    });
  const uploadEventCover = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) =>
      callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
  });
  const parseEventCover = (req, res, next) =>
    uploadEventCover.single('coverImage')(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'Event cover must not exceed 10 MB.' });
      return res.status(400).json({ error: 'Only one JPEG, PNG, or WebP event cover is allowed.' });
    });
  const parseVenueImage = (req, res, next) =>
    uploadEventCover.single('image')(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'Venue images must not exceed 10 MB.' });
      return res.status(400).json({ error: 'Only one JPEG, PNG, or WebP venue image is allowed.' });
    });
  const uploadGroupCover = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  const parseGroupCover = (req, res, next) =>
    uploadGroupCover.single('coverImage')(req, res, (error) => {
      if (!error) return next();
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Group cover must not exceed 10 MB.'
          : 'Upload one JPEG, PNG, or WebP image using the coverImage field.';
      return res
        .status(422)
        .json({ error: 'Group cover is invalid.', fields: { coverImage: message } });
    });
  const uploadArticleImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) =>
      callback(
        null,
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype),
      ),
  });
  const parseArticleImage = (req, res, next) =>
    uploadArticleImage.single('image')(req, res, (error) => {
      if (!error) return next();
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Article image must not exceed 10 MB.'
          : 'Only one JPEG, PNG, GIF, or WebP image is allowed.';
      return res
        .status(422)
        .json({ error: 'Article image is invalid.', fields: { image: message } });
    });
  const profileUploadRoute = `${ftpService.publicPath()}/:filename`;
  const eventUploadRoute = `${eventFtpService.publicPath()}/:filename`;
  const venueUploadRoute = `${venueFtpService.publicPath()}/:filename`;
  const groupUploadRoute = `${groupFtpService.publicPath()}/:filename`;
  const articleUploadRoute = `${articleFtpService.publicPath()}/:filename`;
  return {
    parseProfilePicture,
    parseEventCover,
    parseVenueImage,
    parseGroupCover,
    parseArticleImage,
    profileUploadRoute,
    eventUploadRoute,
    venueUploadRoute,
    groupUploadRoute,
    articleUploadRoute,
  };
}
