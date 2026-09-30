// Logos are resized and flattened to JPEG by the upload control. Keeping the
// bounded image in the record lets invoices/tickets snapshot it without remote
// downloads or mutable image URLs.
export const MAX_LOGO_BYTES = 48 * 1024;

export function logoImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 23) return null;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > MAX_LOGO_BYTES || bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let dimensions = null;
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) return null;
    if (marker === 0xda) return dimensions;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 17 || bytes[offset + 2] !== 8 || bytes[offset + 7] !== 3) return null;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 1024 || height > 1024) return null;
      dimensions = { bytes, width, height };
    }
    offset += length;
  }
  return null;
}

export function validateBranding(body, errors) {
  if (body.logoImage && !logoImage(body.logoImage)) errors.logoImage = 'Choose a logo using the image upload control (up to 48 KB after resizing).';
  if (body.brandName != null && (typeof body.brandName !== 'string' || body.brandName.trim().length > 160)) errors.brandName = 'Brand name must be at most 160 characters.';
}
