import { Types } from 'mongoose';
import { AdminUserModel } from '../models/AdminUser';
import { CreatorRevenueDailyModel } from '../models/CreatorRevenueDaily';
import { CreatorWatchCreditModel } from '../models/CreatorWatchCredit';
import { EpisodeModel } from '../models/Episode';
import { MovieModel } from '../models/Movie';
import { TVShowModel } from '../models/TVShow';
import { RevenueValidationError, resolveCurrentRates } from './creatorRevenueLedger';
import {
  REVENUE_CURRENCY,
  REVENUE_TIMEZONE,
  RevenuePeriod,
  presentMoney,
} from './creatorRevenue';

export const CONTENT_ANALYTICS_REVENUE_NOTE =
  'Revenue is the sum of earning units credited at the creator rate in effect when the watch time was recorded, the same units behind creator revenue summary. With no type or status filter, totals.amountPaise matches that summary for the same period. It is not recomputed from the current hourly rate. views is the lifetime catalog counter (series views already include episode views) and does not follow the date range. uniqueViewers counts distinct app users with credited watch time in the selected period. Episode watch time is rolled into the series row.';

const CONTENT_STATUSES = new Set(['published', 'draft', 'processing', 'moderation', 'rejected', 'removed']);
const CONTENT_TYPES = new Set(['movie', 'series']);

const dayMatch = (period: RevenuePeriod) => {
  if (!period.from || !period.to) return {};
  return { day: { $gte: period.from, $lte: period.to } };
};

const asId = (value: unknown): Types.ObjectId | null => {
  if (!value || !Types.ObjectId.isValid(String(value))) return null;
  return new Types.ObjectId(String(value));
};

const textOrNull = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

const posterOf = (doc: { posterImage?: string | null; thumbnail?: string | null }) =>
  textOrNull(doc.posterImage) || textOrNull(doc.thumbnail);

const thumbnailOf = (doc: { posterImage?: string | null; thumbnail?: string | null }) =>
  textOrNull(doc.thumbnail) || textOrNull(doc.posterImage);

type EpisodeBucket = {
  episodeId: string;
  season: number | null;
  episode: number | null;
  title: string;
  watchSeconds: number;
  earningUnits: number;
  views: number;
  viewers: Set<string>;
};

type ContentBucket = {
  contentId: string;
  creatorId: string;
  type: 'movie' | 'series';
  title: string;
  status: string;
  poster: string | null;
  thumbnail: string | null;
  views: number;
  inCatalog: boolean;
  watchSeconds: number;
  earningUnits: number;
  viewers: Set<string>;
  episodes: Map<string, EpisodeBucket>;
};

type RevenueRow = {
  _id: {
    creatorId: Types.ObjectId;
    titleId: Types.ObjectId;
    titleType: 'movie' | 'series';
    episodeKey: string;
  };
  watchSeconds: number;
  earningUnits: number;
  title?: string;
  episodeTitle?: string;
  season?: number | null;
  episodeNumber?: number | null;
  episodeId?: Types.ObjectId | null;
};

const emptyBucket = (input: {
  contentId: string;
  creatorId: string;
  type: 'movie' | 'series';
  title: string;
  status: string;
  poster: string | null;
  thumbnail: string | null;
  views: number;
  inCatalog: boolean;
}): ContentBucket => ({
  ...input,
  watchSeconds: 0,
  earningUnits: 0,
  viewers: new Set<string>(),
  episodes: new Map(),
});

const ensureEpisode = (item: ContentBucket, episodeId: string, seed?: Partial<EpisodeBucket>) => {
  let episode = item.episodes.get(episodeId);
  if (!episode) {
    episode = {
      episodeId,
      season: seed?.season ?? null,
      episode: seed?.episode ?? null,
      title: seed?.title || 'Episode',
      watchSeconds: 0,
      earningUnits: 0,
      views: seed?.views || 0,
      viewers: new Set<string>(),
    };
    item.episodes.set(episodeId, episode);
  } else if (seed) {
    if (seed.title && episode.title === 'Episode') episode.title = seed.title;
    if (seed.season != null) episode.season = seed.season;
    if (seed.episode != null) episode.episode = seed.episode;
    if (seed.views) episode.views = seed.views;
  }
  return episode;
};

export async function creatorContentAnalytics(input: {
  creatorId?: string | null;
  period: RevenuePeriod;
  page: number;
  limit: number;
  sort?: string | null;
  order?: string | null;
  type?: string | null;
  status?: string | null;
}) {
  const sort = String(input.sort || 'watchHours');
  const order = String(input.order || 'desc');
  if (sort !== 'watchHours' && sort !== 'revenue') {
    throw new RevenueValidationError('sort must be watchHours or revenue');
  }
  if (order !== 'asc' && order !== 'desc') {
    throw new RevenueValidationError('order must be asc or desc');
  }
  const type = String(input.type || '').trim();
  const status = String(input.status || '').trim();
  if (type && !CONTENT_TYPES.has(type)) throw new RevenueValidationError('type must be movie or series');
  if (status && !CONTENT_STATUSES.has(status)) {
    throw new RevenueValidationError('status must be published, draft, processing, moderation, rejected, or removed');
  }

  let creatorIds: Types.ObjectId[];
  if (input.creatorId) {
    const creatorId = asId(input.creatorId);
    if (!creatorId) throw new RevenueValidationError('Invalid creatorId');
    const creator = await AdminUserModel.findById(creatorId).select('role').lean();
    if (!creator || creator.role !== 'influencer') {
      throw new RevenueValidationError('Creator not found', 404);
    }
    creatorIds = [creatorId];
  } else {
    const creators = await AdminUserModel.find({ role: 'influencer' }).select('_id').lean();
    creatorIds = creators.map((creator) => creator._id as Types.ObjectId);
  }

  const items = new Map<string, ContentBucket>();
  const ownerFilter = { createdBy: { $in: creatorIds } };
  const [movies, shows, revenueRows, creators] = await Promise.all([
    creatorIds.length
      ? MovieModel.find(ownerFilter).select('title status thumbnail posterImage views createdBy').lean()
      : Promise.resolve([]),
    creatorIds.length
      ? TVShowModel.find(ownerFilter).select('title status thumbnail posterImage views createdBy').lean()
      : Promise.resolve([]),
    creatorIds.length
      ? CreatorRevenueDailyModel.aggregate<RevenueRow>([
        { $match: { creatorId: { $in: creatorIds }, ...dayMatch(input.period) } },
        {
          $group: {
            _id: {
              creatorId: '$creatorId',
              titleId: '$titleId',
              titleType: '$titleType',
              episodeKey: '$episodeKey',
            },
            watchSeconds: { $sum: '$watchSeconds' },
            earningUnits: { $sum: '$earningUnits' },
            title: { $last: '$title' },
            episodeTitle: { $last: '$episodeTitle' },
            season: { $last: '$season' },
            episodeNumber: { $last: '$episodeNumber' },
            episodeId: { $last: '$episodeId' },
          },
        },
      ])
      : Promise.resolve([]),
    creatorIds.length
      ? AdminUserModel.find({ _id: { $in: creatorIds } }).select('name email').lean()
      : Promise.resolve([]),
  ]);

  for (const movie of movies) {
    const contentId = String(movie._id);
    items.set(contentId, emptyBucket({
      contentId,
      creatorId: String(movie.createdBy || ''),
      type: 'movie',
      title: movie.title || 'Untitled',
      status: movie.status || 'draft',
      poster: posterOf(movie),
      thumbnail: thumbnailOf(movie),
      views: Number(movie.views) || 0,
      inCatalog: true,
    }));
  }
  for (const show of shows) {
    const contentId = String(show._id);
    items.set(contentId, emptyBucket({
      contentId,
      creatorId: String(show.createdBy || ''),
      type: 'series',
      title: show.title || 'Untitled',
      status: show.status || 'draft',
      poster: posterOf(show),
      thumbnail: thumbnailOf(show),
      views: Number(show.views) || 0,
      inCatalog: true,
    }));
  }

  const showIds = shows.map((show) => show._id);
  const episodes = showIds.length
    ? await EpisodeModel.find({ tvShowId: { $in: showIds } })
      .select('title season episode views tvShowId')
      .lean()
    : [];
  for (const episode of episodes) {
    const item = items.get(String(episode.tvShowId));
    if (!item || item.type !== 'series') continue;
    ensureEpisode(item, String(episode._id), {
      title: episode.title,
      season: episode.season ?? null,
      episode: episode.episode ?? null,
      views: Number(episode.views) || 0,
    });
  }

  for (const row of revenueRows) {
    const contentId = String(row._id.titleId);
    let item = items.get(contentId);
    if (!item) {
      item = emptyBucket({
        contentId,
        creatorId: String(row._id.creatorId),
        type: row._id.titleType === 'series' ? 'series' : 'movie',
        title: row.title || 'Removed title',
        status: 'removed',
        poster: null,
        thumbnail: null,
        views: 0,
        inCatalog: false,
      });
      items.set(contentId, item);
    }
    item.watchSeconds += row.watchSeconds || 0;
    item.earningUnits += row.earningUnits || 0;
    if (item.type === 'series' && row._id.episodeKey) {
      const episodeId = row.episodeId ? String(row.episodeId) : row._id.episodeKey;
      const episode = ensureEpisode(item, episodeId, {
        title: row.episodeTitle || undefined,
        season: row.season ?? null,
        episode: row.episodeNumber ?? null,
      });
      episode.watchSeconds += row.watchSeconds || 0;
      episode.earningUnits += row.earningUnits || 0;
    }
  }

  const viewerRows = creatorIds.length
    ? await CreatorWatchCreditModel.aggregate<{
      _id: { titleId: Types.ObjectId; episodeId: Types.ObjectId | null; viewer: Types.ObjectId };
    }>([
      {
        $match: {
          creatorId: { $in: creatorIds },
          applied: true,
          creditedSeconds: { $gt: 0 },
          titleId: { $ne: null },
          ...dayMatch(input.period),
        },
      },
      {
        $group: {
          _id: {
            titleId: '$titleId',
            episodeId: '$episodeId',
            viewer: '$viewerUserId',
          },
        },
      },
    ])
    : [];
  for (const row of viewerRows) {
    const item = items.get(String(row._id.titleId));
    if (!item) continue;
    const viewer = String(row._id.viewer);
    item.viewers.add(viewer);
    if (item.type === 'series' && row._id.episodeId) {
      const episode = item.episodes.get(String(row._id.episodeId));
      if (episode) episode.viewers.add(viewer);
    }
  }

  let rows = [...items.values()];
  if (type) rows = rows.filter((row) => row.type === type);
  if (status) rows = rows.filter((row) => row.status === status);

  const metric = (row: ContentBucket) => (sort === 'revenue' ? row.earningUnits : row.watchSeconds);
  rows.sort((a, b) => {
    const diff = metric(a) - metric(b);
    const signed = order === 'asc' ? diff : -diff;
    if (signed !== 0) return signed;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.contentId.localeCompare(b.contentId);
  });

  const totals = rows.reduce(
    (sum, row) => {
      sum.watchSeconds += row.watchSeconds;
      sum.earningUnits += row.earningUnits;
      sum.views += row.views;
      if (row.type === 'movie') sum.movieCount += 1;
      else sum.seriesCount += 1;
      for (const viewer of row.viewers) sum.viewers.add(viewer);
      return sum;
    },
    {
      watchSeconds: 0,
      earningUnits: 0,
      views: 0,
      movieCount: 0,
      seriesCount: 0,
      viewers: new Set<string>(),
    }
  );

  const rateFor = await resolveCurrentRates(creatorIds);
  const creatorsById = new Map(creators.map((creator) => [String(creator._id), creator]));
  const presentEpisode = (episode: EpisodeBucket) => ({
    episodeId: episode.episodeId,
    season: episode.season,
    episode: episode.episode,
    title: episode.title,
    ...presentMoney(episode.watchSeconds, episode.earningUnits),
    earningUnits: episode.earningUnits,
    views: episode.views,
    uniqueViewers: episode.viewers.size,
  });
  const presentItem = (row: ContentBucket) => {
    const creator = creatorsById.get(row.creatorId);
    const rate = rateFor(row.creatorId);
    const episodes = [...row.episodes.values()]
      .sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0) || a.title.localeCompare(b.title))
      .map(presentEpisode);
    return {
      contentId: row.contentId,
      title: row.title,
      type: row.type,
      poster: row.poster,
      thumbnail: row.thumbnail,
      status: row.status,
      creatorId: row.creatorId,
      creatorName: creator?.name || 'Unknown',
      creatorEmail: creator?.email || '',
      ...presentMoney(row.watchSeconds, row.earningUnits),
      earningUnits: row.earningUnits,
      views: row.views,
      uniqueViewers: row.viewers.size,
      inCatalog: row.inCatalog,
      rateInrPerHour: rate.rateInrPerHour,
      rateSource: rate.rateSource,
      ...(row.type === 'series' ? { episodeCount: episodes.length, episodes } : {}),
    };
  };

  const skip = (input.page - 1) * input.limit;
  const pageRows = rows.slice(skip, skip + input.limit);
  const scopedCreatorId = input.creatorId ? String(creatorIds[0]) : null;
  const scopedRate = scopedCreatorId ? rateFor(scopedCreatorId) : null;

  return {
    currency: REVENUE_CURRENCY,
    timezone: REVENUE_TIMEZONE,
    period: input.period,
    sort,
    order,
    viewsScope: 'lifetime' as const,
    uniqueViewersScope: 'period' as const,
    revenueNote: CONTENT_ANALYTICS_REVENUE_NOTE,
    ...(scopedCreatorId ? { creatorId: scopedCreatorId, rate: scopedRate } : {}),
    totals: {
      contentCount: rows.length,
      movieCount: totals.movieCount,
      seriesCount: totals.seriesCount,
      ...presentMoney(totals.watchSeconds, totals.earningUnits),
      earningUnits: totals.earningUnits,
      views: totals.views,
      uniqueViewers: totals.viewers.size,
    },
    items: pageRows.map(presentItem),
    pagination: {
      total: rows.length,
      page: input.page,
      limit: input.limit,
      pages: Math.ceil(rows.length / input.limit) || 0,
    },
  };
}
