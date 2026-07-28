import type { FastifyReply, FastifyRequest } from 'fastify';
import { MovieModel } from '../models/Movie';
import { logger } from '../lib/logger';

export const getWebDetail = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { contentId } = request.params as { contentId: string };

    const item: any = await MovieModel.findById(contentId)
      .populate('genres', 'name')
      .populate('languages', 'name')
      .populate('subtitleLanguages', 'name code')
      .populate('subtitles.language', 'name code')
      .populate('cast.actor', 'name image designation')
      .populate('crew.director', 'name image designation')
      .lean();

    if (!item) {
      return reply.status(404).send({ success: false, message: 'Content not found' });
    }

    // Format duration
    const hours = item.duration ? Math.floor(item.duration / 3600) : 0;
    const minutes = item.duration ? Math.floor((item.duration % 3600) / 60) : 0;
    const durationFormatted = item.duration
      ? hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
      : null;

    const genreNames = (item.genres || []).map((g: any) => g?.name || g);
    const languageNames = (item.languages || []).map((l: any) => l?.name || l);

    // Video settings — never use blob: browser preview URLs
    const hlsUrl =
      [item.hlsUrl, item.videoUrl, item.sourceVideoUrl].find(
        (u: any) => typeof u === 'string' && u.trim() && !u.startsWith('blob:')
      ) || '';
    const qualities: any[] = item.videoQualities || [];
    const videoSettings = hlsUrl
      ? [
          { key: 'auto', label: 'Auto', description: 'Adjusts quality automatically', url: hlsUrl },
          ...qualities.map((q: any) => {
            const sizeMB = q.size ? `${Math.round(q.size / (1024 * 1024))} MB` : null;
            const qKey = String(q.quality || '');
            const label =
              qKey === '4k' || qKey === '2160p' ? '4K' :
              qKey === '1440p' ? '1440p' :
              qKey.replace(/p$/i, 'p');
            return {
              key: qKey,
              label,
              description: sizeMB
                ? `${label} · ~${sizeMB}`
                : (q.resolution ? `${label} · ${q.resolution}` : `${label} quality`),
              url: q.url,
            };
          })
        ]
      : null;

    const playbackSpeeds = [
      { value: 0.75, label: '0.75x' },
      { value: 1.0, label: 'Normal' },
      { value: 1.25, label: '1.25x' },
      { value: 1.5, label: '1.5x' },
      { value: 1.75, label: '1.75x' },
      { value: 2.0, label: '2.0x' }
    ];

    const cast = (item.cast || []).map((c: any) => ({
      id: c.actor?._id?.toString() || null,
      name: c.actor?.name || 'Unknown',
      image: c.actor?.image || c.actor?.avatar || null,
      designation: c.actor?.designation || null,
      role: c.role || 'Actor',
      character: c.character || null,
    }));

    const crew = (item.crew || []).map((c: any) => ({
      id: c.director?._id?.toString() || null,
      name: c.director?.name || 'Unknown',
      image: c.director?.image || null,
      designation: c.director?.designation || null,
      role: c.role || 'Director',
    }));

    // Map the basic content item
    const mappedItem = {
      id: item._id.toString(),
      title: item.title,
      originalTitle: item.originalTitle || null,
      poster: item.posterImage || item.thumbnail || '',
      backdrop: item.bannerImage || item.thumbnail || '',
      type: 'movie',
      contentType: 'movie',
      playerType: 'standard',
      year: item.year?.toString() || new Date(item.createdAt).getFullYear().toString(),
      duration: durationFormatted || 'N/A',
      durationFormatted,
      imdbRating: item.imdbRating?.toString() || (item.rating || '8.0'),
      ageRating: item.ageRating
        ? (String(item.ageRating).includes('+') || String(item.ageRating).toUpperCase().includes('U')
            ? String(item.ageRating)
            : `${item.ageRating}+`)
        : '18+',
      description: item.description || item.shortDescription || '',
      shortDescription: item.shortDescription || null,
      language: languageNames.length > 0 ? languageNames.join(', ') : 'EN',
      languages: languageNames,
      genres: genreNames,
      genresText: genreNames.join(' & '),
      trailerUrl: item.trailerUrl && !String(item.trailerUrl).startsWith('blob:') ? item.trailerUrl : null,
      videoUrl: hlsUrl || null,
      hlsUrl: hlsUrl || null,
      sourceVideoUrl:
        item.sourceVideoUrl && !String(item.sourceVideoUrl).startsWith('blob:')
          ? item.sourceVideoUrl
          : null,
      videoSettings,
      playbackSpeeds,
      subtitles: (item.subtitles || [])
        .filter((s: any) => s?.filePath)
        .map((s: any) => ({
          language: s.language?.name || s.language?.code || 'Unknown',
          code: s.language?.code || 'und',
          filePath: s.filePath,
          url: s.filePath,
        })),
      cast,
      directors: crew.filter((c: any) => c.role === 'Director').map((c: any) => c.name),
      crew,
      country: item.country || null,
      studio: item.studio || null,
      producer: item.producer || null,
      tags: item.tags || [],
      isLocked: item.planRequired !== 'free',
      planRequired: item.planRequired || 'free',
      downloadAllowed: item.downloadAllowed !== false,
      episodeMeta: `HD • ${genreNames.join(', ')} • ${durationFormatted || 'N/A'}`,
      isExclusive: item.isExclusive || false,
      featured: item.featured || false,
      trending: item.trending || false,
      releaseDate: item.releaseDate || null,
    };

    // Fetch related content (same primary genre)
    let related: any[] = [];
    if (item.genres && item.genres.length > 0) {
      const primaryGenreId = item.genres[0]._id;
      const relatedRaw = await MovieModel.find({ genres: primaryGenreId, _id: { $ne: item._id }, status: 'published' })
        .sort({ views: -1 })
        .limit(5)
        .select('title thumbnail posterImage bannerImage year rating ageRating duration imdbRating isNewContent featured trending views createdAt')
        .lean();

      related = relatedRaw.map((r: any) => {
        const h = r.duration ? Math.floor(r.duration / 3600) : 0;
        const m = r.duration ? Math.floor((r.duration % 3600) / 60) : 0;
        const dur = r.duration ? (h > 0 ? `${h}h ${m}m` : `${m}m`) : null;
        return {
          id: r._id.toString(),
          title: r.title,
          poster: r.posterImage || r.thumbnail || '',
          backdrop: r.bannerImage || r.posterImage || r.thumbnail || '',
          type: 'movie',
          year: r.year?.toString() || new Date(r.createdAt).getFullYear().toString(),
          duration: dur || 'N/A',
          imdbRating: r.imdbRating?.toString() || (r.rating || '8.0'),
          ageRating: r.ageRating ? `${r.ageRating}+` : '18+',
        };
      });
    }

    return reply.send({
      success: true,
      data: {
        ...mappedItem,
        episodes: [],
        related,
      },
    });

  } catch (error: any) {
    logger.error({ error }, 'Error fetching web detail API data');
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
