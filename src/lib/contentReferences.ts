import { ActorModel } from '../models/Actor';
import { CountryModel } from '../models/Country';
import { CrewModel } from '../models/Crew';
import { DirectorModel } from '../models/Director';
import { GenreModel } from '../models/Genre';
import { LanguageModel } from '../models/Language';

const HEX_ID = /^[a-fA-F0-9]{24}$/;
const MAX_REFS = 50;

type IdModel = {
  find: (filter: Record<string, unknown>) => { select: (fields: string) => { lean: () => Promise<Array<{ _id: unknown }>> } };
};

type PersonEntry = { id: string; role: string; character: string };

const idString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const record = value as { _id?: unknown; id?: unknown };
    return String(record._id || record.id || '').trim();
  }
  return '';
};

const readPeople = (
  value: unknown,
  label: string,
  idKeys: string[]
): { error: string } | { entries: PersonEntry[] } => {
  if (!Array.isArray(value)) return { error: `${label} must be an array` };
  if (value.length > MAX_REFS) return { error: `Too many ${label} entries` };
  const entries: PersonEntry[] = [];
  for (const item of value) {
    let id = '';
    let role = '';
    let character = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      role = record.role != null ? String(record.role) : '';
      character = record.character != null ? String(record.character) : '';
      for (const key of idKeys) {
        const raw = record[key];
        if (raw == null || raw === '') continue;
        id = typeof raw === 'string' ? raw.trim() : idString(raw);
        if (id) break;
      }
    }
    if (!HEX_ID.test(id)) return { error: `Invalid ${label} id` };
    entries.push({ id, role, character });
  }
  return { entries };
};

const missingId = async (model: IdModel, ids: string[], label: string): Promise<string | null> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  if (unique.some((id) => !HEX_ID.test(id))) return `Invalid ${label} id`;
  const found = await model.find({ _id: { $in: unique } }).select('_id').lean();
  if (found.length === unique.length) return null;
  const have = new Set(found.map((row) => String(row._id)));
  const missing = unique.find((id) => !have.has(id));
  return `${label} not found: ${missing}`;
};

/**
 * Validate movie / series references and normalize them onto the stored fields.
 * Unknown ids are rejected. A plain country name is left as display text.
 * `directors` is merged into `crew` (director ids). `crewPeople` is stored as `crewMembers`.
 * Returns an error string, or null when the body is ready to save.
 */
export const normalizeContentReferences = async (
  body: Record<string, any> | null | undefined
): Promise<string | null> => {
  if (!body || typeof body !== 'object') return null;

  const assignIds = async (field: string, label: string, model: IdModel) => {
    if (body[field] == null) return null;
    const parsed = readPeople(body[field], label, ['_id', 'id']);
    if ('error' in parsed) return parsed.error;
    const missing = await missingId(model, parsed.entries.map((entry) => entry.id), label);
    if (missing) return missing;
    body[field] = parsed.entries.map((entry) => entry.id);
    return null;
  };

  const genreError = await assignIds('genres', 'Genre', GenreModel);
  if (genreError) return genreError;
  for (const field of ['languages', 'subtitleLanguages', 'audioLanguages'] as const) {
    const languageError = await assignIds(field, 'Language', LanguageModel);
    if (languageError) return languageError;
  }

  if (body.directors != null) {
    const parsed = readPeople(body.directors, 'director', ['director', '_id', 'id']);
    if ('error' in parsed) return parsed.error;
    const extra = parsed.entries.map((entry) => ({
      director: entry.id,
      role: entry.role || 'Director',
    }));
    body.crew = [...(Array.isArray(body.crew) ? body.crew : []), ...extra];
    delete body.directors;
  }

  if (body.crew != null) {
    const parsed = readPeople(body.crew, 'director', ['director', '_id', 'id']);
    if ('error' in parsed) return parsed.error;
    const missing = await missingId(DirectorModel, parsed.entries.map((entry) => entry.id), 'Director');
    if (missing) return missing;
    const seen = new Set<string>();
    body.crew = [];
    for (const entry of parsed.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      body.crew.push({ director: entry.id, role: entry.role || 'Director' });
    }
  }

  if (body.cast != null) {
    const parsed = readPeople(body.cast, 'actor', ['actor', '_id', 'id']);
    if ('error' in parsed) return parsed.error;
    const missing = await missingId(ActorModel, parsed.entries.map((entry) => entry.id), 'Actor');
    if (missing) return missing;
    body.cast = parsed.entries.map((entry) => ({
      actor: entry.id,
      character: entry.character,
      role: entry.role,
    }));
  }

  if (body.crewMembers == null && body.crewPeople != null) body.crewMembers = body.crewPeople;
  delete body.crewPeople;
  if (body.crewMembers != null) {
    const parsed = readPeople(body.crewMembers, 'crew member', ['crew', 'person', '_id', 'id']);
    if ('error' in parsed) return parsed.error;
    const missing = await missingId(CrewModel, parsed.entries.map((entry) => entry.id), 'Crew member');
    if (missing) return missing;
    body.crewMembers = parsed.entries.map((entry) => ({
      crew: entry.id,
      role: entry.role,
    }));
  }

  if (Array.isArray(body.subtitles)) {
    if (body.subtitles.length > MAX_REFS) return 'Too many subtitle entries';
    const ids: string[] = [];
    for (const item of body.subtitles) {
      const id = idString(item?.language ?? item?.languageId);
      if (!HEX_ID.test(id)) return 'Invalid subtitle language id';
      ids.push(id);
      if (item && typeof item === 'object') item.language = id;
    }
    const missing = await missingId(LanguageModel, ids, 'Language');
    if (missing) return missing;
  } else if (body.subtitles != null) {
    return 'subtitles must be an array';
  }

  const explicitCountryId = body.countryId != null && body.countryId !== '' ? idString(body.countryId) : '';
  const countryText = typeof body.country === 'string' ? body.country.trim() : '';
  if (body.countryId != null && body.countryId !== '' && !HEX_ID.test(explicitCountryId)) {
    return 'Invalid country id';
  }
  const countryToken = explicitCountryId || (HEX_ID.test(countryText) ? countryText : '');
  if (countryToken) {
    const country = await CountryModel.findById(countryToken).select('_id name').lean();
    if (!country) return `Country not found: ${countryToken}`;
    body.countryId = country._id;
    body.country = country.name;
  }

  return null;
};
