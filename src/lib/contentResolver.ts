import mongoose from 'mongoose';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { EpisodeModel } from '../models/Episode';

export type ContentModelType = 'Movie' | 'TVShow' | 'Episode';

export type ResolvedContent = {
  type: ContentModelType;
  model: typeof MovieModel | typeof TVShowModel | typeof EpisodeModel;
  doc: any;
};

const TYPE_ALIASES: Record<string, ContentModelType> = {
  movie: 'Movie',
  movies: 'Movie',
  show: 'TVShow',
  series: 'TVShow',
  tvshow: 'TVShow',
  tvshows: 'TVShow',
  drama: 'TVShow',
  episode: 'Episode',
  episodes: 'Episode',
};

export function normalizeContentModelType(raw?: string | null): ContentModelType | null {
  if (!raw) return null;
  return TYPE_ALIASES[String(raw).toLowerCase().trim()] || null;
}

export async function resolveContent(
  contentId: string,
  hintedType?: string | null
): Promise<ResolvedContent | null> {
  if (!mongoose.Types.ObjectId.isValid(contentId)) return null;

  const hinted = normalizeContentModelType(hintedType);
  const lookups: Array<{ type: ContentModelType; model: ResolvedContent['model'] }> = [
    { type: 'Movie', model: MovieModel },
    { type: 'TVShow', model: TVShowModel },
    { type: 'Episode', model: EpisodeModel },
  ];

  const ordered = hinted
    ? [...lookups.filter((l) => l.type === hinted), ...lookups.filter((l) => l.type !== hinted)]
    : lookups;

  for (const lookup of ordered) {
    const doc = await (lookup.model as any).findById(contentId).lean();
    if (doc) {
      return { type: lookup.type, model: lookup.model, doc };
    }
  }

  return null;
}

export function isRawLocalVideo(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('blob:')) return false;
  if (trimmed.includes('.m3u8')) return false;
  const isHttp = trimmed.startsWith('http://') || trimmed.startsWith('https://');
  return !isHttp;
}
