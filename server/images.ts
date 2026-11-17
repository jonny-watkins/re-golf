import sharp from 'sharp';
import { maxPhotoBytes } from '../shared/listings.js';

export async function normalisePhoto(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > maxPhotoBytes) throw new Error('Choose a photo between 1 byte and 8 MB.');
  const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1) {
    throw new Error('Choose a still JPEG, PNG or WebP photo.');
  }
  // Decode/re-encode, auto-orient before stripping EXIF (including GPS), never copy metadata.
  return image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toBuffer();
}
