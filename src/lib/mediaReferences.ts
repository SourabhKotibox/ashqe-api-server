import { Types, type Model } from 'mongoose';
import { ActorModel } from '../models/Actor';
import { AdModel } from '../models/Ad';
import { AdminUserModel } from '../models/AdminUser';
import { BannerModel } from '../models/Banner';
import { CategoryModel } from '../models/Category';
import { CrewModel } from '../models/Crew';
import { DirectorModel } from '../models/Director';
import { EpisodeModel } from '../models/Episode';
import { GenreModel } from '../models/Genre';
import { LanguageModel } from '../models/Language';
import { LiveChannelModel } from '../models/LiveChannel';
import { MediaFileModel } from '../models/MediaFile';
import { MovieModel } from '../models/Movie';
import { NotificationModel } from '../models/Notification';
import { PageModel } from '../models/Page';
import { PromotionModel } from '../models/Promotion';
import { SettingsModel } from '../models/Settings';
import { TVShowModel } from '../models/TVShow';
import { UserModel } from '../models/User';

const GENERIC = new Set([
  '',
  '/',
  'uploads',
  '/uploads',
  'uploads/',
  'media',
  'logo.png',
  'favicon.png',
  '/logo.png',
  '/favicon.png',
]);

type RefModel = {
  model: Model<any>;
  fields: string[];
  /** Long-form text that may embed an upload URL. Matched only by the unique file token. */
  textFields?: string[];
};

const CONTENT_MODELS: RefModel[] = [
  {
    model: MovieModel,
    fields: [
      'thumbnail', 'bannerImage', 'posterImage', 'trailerUrl', 'sourceVideoUrl',
      'hlsUrl', 'videoUrl', 'seoImage', 'videoQualities.url', 'subtitles.filePath',
    ],
  },
  {
    model: TVShowModel,
    fields: [
      'thumbnail', 'bannerImage', 'posterImage', 'trailerUrl', 'sourceVideoUrl',
      'hlsUrl', 'videoUrl', 'seoImage', 'videoQualities.url', 'subtitles.filePath',
    ],
  },
  {
    model: EpisodeModel,
    fields: [
      'thumbnail', 'sourceVideoUrl', 'hlsUrl', 'trailerUrl',
      'videoQualities.url', 'subtitles.filePath',
    ],
  },
  { model: ActorModel, fields: ['image'] },
  { model: DirectorModel, fields: ['image'] },
  { model: CrewModel, fields: ['image'] },
  { model: GenreModel, fields: ['image'] },
  { model: LanguageModel, fields: ['image'] },
  { model: CategoryModel, fields: ['thumbnail', 'bannerImage', 'icon'] },
  { model: BannerModel, fields: ['imageUrl', 'mobileImageUrl'] },
  { model: PromotionModel, fields: ['videoUrl', 'thumbnailUrl'] },
  { model: AdModel, fields: ['mediaUrl'] },
  {
    model: LiveChannelModel,
    fields: ['logo', 'bannerImage', 'currentProgram.thumbnail', 'nextProgram.thumbnail'],
  },
  { model: NotificationModel, fields: ['imageUrl'] },
  { model: SettingsModel, fields: ['logoUrl', 'darkLogoUrl', 'lightLogoUrl', 'faviconUrl', 'seoImage'] },
  { model: UserModel, fields: ['avatar', 'profiles.avatar'] },
  { model: AdminUserModel, fields: ['avatar'] },
  { model: PageModel, fields: [], textFields: ['content'] },
];

const MEDIA_FIELDS = [
  'url', 'filePath', 's3Key', 'hlsMasterPlaylistUrl', 'hlsMasterPlaylistPath',
  'posterFrameUrl', 'hlsQualities.url', 'hlsQualities.filePath',
];

export type MediaUseOptions = {
  /** Content documents that are dropping this file in the same operation. */
  ignoreIds?: Array<unknown>;
  /** MediaFile rows being removed with the object. They are not "other" references. */
  ignoreMediaFileIds?: Array<unknown>;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const asId = (value: unknown): Types.ObjectId | null => {
  const id = String((value as { _id?: unknown })?._id || value || '').trim();
  if (!Types.ObjectId.isValid(id)) return null;
  return new Types.ObjectId(id);
};

const idList = (values: Array<unknown> | undefined) =>
  (values || []).map(asId).filter((id): id is Types.ObjectId => !!id);

const distinctiveToken = (value: string): string | null => {
  const base = value.split('?')[0].split('#')[0].split('/').pop() || '';
  if (/^\d{10,}-[a-z0-9]{4,}/i.test(base) && base.length >= 16) return base;
  return null;
};

const addPathVariants = (exact: Set<string>, value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return;
  exact.add(trimmed);
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname;
      if (pathname.length > 1) {
        exact.add(pathname);
        exact.add(pathname.replace(/^\/+/, ''));
      }
    } catch {
      /* ignore malformed URLs */
    }
  }
  const noLead = trimmed.replace(/^\/+/, '');
  if (noLead) {
    exact.add(noLead);
    exact.add(`/${noLead}`);
  }
  if (noLead.startsWith('uploads/')) {
    const rest = noLead.slice('uploads/'.length);
    if (rest) {
      exact.add(rest);
      exact.add(`/uploads/${rest}`);
      exact.add(`uploads/${rest}`);
    }
  } else if (!/^https?:\/\//i.test(trimmed) && noLead) {
    exact.add(`/uploads/${noLead}`);
    exact.add(`uploads/${noLead}`);
  }
};

const collectRaw = (source: string | Record<string, any>): string[] => {
  if (typeof source === 'string') return [source];
  const raw: string[] = [];
  for (const key of ['url', 'filePath', 's3Key', 'hlsMasterPlaylistUrl', 'hlsMasterPlaylistPath', 'posterFrameUrl', 'name']) {
    if (typeof source[key] === 'string') raw.push(source[key]);
  }
  const qualities = Array.isArray(source.hlsQualities) ? source.hlsQualities : [];
  for (const quality of qualities) {
    if (typeof quality?.url === 'string') raw.push(quality.url);
    if (typeof quality?.filePath === 'string') raw.push(quality.filePath);
  }
  return raw;
};

export const mediaIdentity = (source: string | Record<string, any>) => {
  const exact = new Set<string>();
  let token: string | null = null;
  for (const value of collectRaw(source)) {
    addPathVariants(exact, value);
    token = token || distinctiveToken(value);
  }
  return {
    exact: [...exact].filter((value) => value.length >= 8 && !GENERIC.has(value)),
    token,
  };
};

const fieldClauses = (fields: string[], exact: string[], token: string | null) => {
  const clauses: Record<string, unknown>[] = [];
  const rx = token ? new RegExp(escapeRegex(token)) : null;
  for (const field of fields) {
    if (exact.length) clauses.push({ [field]: { $in: exact } });
    if (rx) clauses.push({ [field]: rx });
  }
  return clauses;
};

const countModel = async (
  model: Model<any>,
  clauses: Record<string, unknown>[],
  ignore: Types.ObjectId[]
) => {
  if (clauses.length === 0) return 0;
  const filter: Record<string, unknown> = { $or: clauses };
  if (ignore.length) filter._id = { $nin: ignore };
  return model.countDocuments(filter);
};

/**
 * How many other records still point at this storage object.
 * Counts movies, series, episodes (seasons live on episodes), people, banners,
 * settings, and any other MediaFile that shares the object. The file being
 * deleted is excluded via ignoreMediaFileIds.
 */
export const countMediaUses = async (
  source: string | Record<string, any>,
  options: MediaUseOptions = {}
): Promise<number> => {
  const { exact, token } = mediaIdentity(source);
  if (exact.length === 0 && !token) return 0;
  const ignoreContent = idList(options.ignoreIds);
  const ignoreMedia = idList(options.ignoreMediaFileIds);

  const counts = await Promise.all([
    ...CONTENT_MODELS.map((entry) => countModel(
      entry.model,
      [
        ...fieldClauses(entry.fields, exact, token),
        ...fieldClauses(entry.textFields || [], [], token),
      ],
      ignoreContent
    )),
    countModel(MediaFileModel, fieldClauses(MEDIA_FIELDS, exact, token), ignoreMedia),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
};

export const inUseMessage = (count: number, noun = 'file') => {
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;
  if (noun === 'folder') return `This folder is in use by ${items}`;
  return `This file is in use by ${items}`;
};
