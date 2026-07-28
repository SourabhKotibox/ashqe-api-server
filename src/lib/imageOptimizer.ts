/**
 * Server-side image optimize for movie covers / posters / banners.
 * WebP output — visually similar quality, less storage.
 */
import sharp from 'sharp';
import path from 'path';
import { logger } from './logger';

export type ImageOptimizePreset = 'poster' | 'thumbnail' | 'banner' | 'seo' | 'default';

const PRESETS: Record<
  ImageOptimizePreset,
  { maxWidth: number; maxHeight: number; quality: number }
> = {
  poster: { maxWidth: 1200, maxHeight: 1800, quality: 82 },
  thumbnail: { maxWidth: 800, maxHeight: 1200, quality: 82 },
  banner: { maxWidth: 1920, maxHeight: 1080, quality: 82 },
  seo: { maxWidth: 1200, maxHeight: 1200, quality: 80 },
  default: { maxWidth: 1920, maxHeight: 1920, quality: 82 },
};

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i;

export function isOptimizableImage(fileName: string, mimeType?: string): boolean {
  if (mimeType?.startsWith('image/') && !/svg|gif/i.test(mimeType)) return true;
  return IMAGE_EXT.test(fileName) && !/\.(svg|gif)$/i.test(fileName);
}

export function inferPreset(fileName: string, source?: string, uploadType?: string): ImageOptimizePreset {
  const n = `${fileName} ${source || ''} ${uploadType || ''}`.toLowerCase();
  if (/banner|backdrop|hero|landscape/.test(n)) return 'banner';
  if (/thumb|thumbnail|category-thumbnail/.test(n)) return 'thumbnail';
  if (/seo|og/.test(n)) return 'seo';
  if (/poster|cover|movie|actor|director|genre/.test(n)) return 'poster';
  return 'default';
}

export type OptimizeImageResult = {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  originalSize: number;
  optimizedSize: number;
  skipped: boolean;
};

/**
 * Compress buffer to WebP. Returns original if no savings or not an image.
 */
export async function optimizeImageBuffer(
  input: Buffer,
  fileName: string,
  mimeType?: string,
  preset: ImageOptimizePreset = 'default'
): Promise<OptimizeImageResult> {
  const originalSize = input.length;

  if (!isOptimizableImage(fileName, mimeType)) {
    return {
      buffer: input,
      mimeType: mimeType || 'application/octet-stream',
      extension: path.extname(fileName).toLowerCase() || '',
      originalSize,
      optimizedSize: originalSize,
      skipped: true,
    };
  }

  if (originalSize < 40 * 1024) {
    return {
      buffer: input,
      mimeType: mimeType || 'image/jpeg',
      extension: path.extname(fileName).toLowerCase() || '.jpg',
      originalSize,
      optimizedSize: originalSize,
      skipped: true,
    };
  }

  try {
    const { maxWidth, maxHeight, quality } = PRESETS[preset] || PRESETS.default;
    const optimized = await sharp(input, { failOn: 'none' })
      .rotate() // honour EXIF orientation
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality, effort: 4 })
      .toBuffer();

    if (optimized.length >= originalSize * 0.98) {
      return {
        buffer: input,
        mimeType: mimeType || 'image/jpeg',
        extension: path.extname(fileName).toLowerCase() || '.jpg',
        originalSize,
        optimizedSize: originalSize,
        skipped: true,
      };
    }

    logger.info(
      {
        fileName,
        preset,
        from: originalSize,
        to: optimized.length,
        savedPct: Math.round((1 - optimized.length / originalSize) * 100),
      },
      'Optimized image for storage'
    );

    return {
      buffer: optimized,
      mimeType: 'image/webp',
      extension: '.webp',
      originalSize,
      optimizedSize: optimized.length,
      skipped: false,
    };
  } catch (err) {
    logger.warn({ err, fileName }, 'Image optimize failed — keeping original');
    return {
      buffer: input,
      mimeType: mimeType || 'application/octet-stream',
      extension: path.extname(fileName).toLowerCase() || '',
      originalSize,
      optimizedSize: originalSize,
      skipped: true,
    };
  }
}
