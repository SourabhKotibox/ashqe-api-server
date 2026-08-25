const fs = require('fs');

// 1. index.ts
let idxPath = '/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/routes/index.ts';
let idx = fs.readFileSync(idxPath, 'utf8');

if (!idx.includes('import tvShowRoutes')) {
  idx = idx.replace("import movieRoutes from './movie';", "import movieRoutes from './movie';\nimport tvShowRoutes from './tvShows';\nimport episodeRoutes from './episodes';");
}
if (!idx.includes('import { getSeriesDetail }')) {
  idx = idx.replace("import { getMovieDetail } from '../controllers/appMovieController';", "import { getMovieDetail } from '../controllers/appMovieController';\nimport { getSeriesDetail } from '../controllers/appSeriesController';");
}
if (!idx.includes("fastify.register(tvShowRoutes")) {
  idx = idx.replace("fastify.register(movieRoutes, { prefix: '/movies' });", "fastify.register(movieRoutes, { prefix: '/movies' });\n  fastify.register(tvShowRoutes, { prefix: '/tv-shows' });\n  fastify.register(episodeRoutes, { prefix: '/episodes' });");
}
if (!idx.includes("fastify.get('/app/series/:id'")) {
  idx = idx.replace("fastify.get('/app/movies/:id', getMovieDetail);", "fastify.get('/app/movies/:id', getMovieDetail);\n  fastify.get('/app/series/:id', getSeriesDetail);");
}
fs.writeFileSync(idxPath, idx);

// 2. AdminUser.ts
let adminPath = '/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/models/AdminUser.ts';
let admin = fs.readFileSync(adminPath, 'utf8');

if (!admin.includes('tvShows: { canView')) {
  admin = admin.replace("movies: { canView: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean };", "movies: { canView: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean };\n  tvShows: { canView: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean };");
  admin = admin.replace("movies: { canView: true, canCreate: false, canEdit: false, canDelete: false },", "movies: { canView: true, canCreate: false, canEdit: false, canDelete: false },\n  tvShows: { canView: true, canCreate: false, canEdit: false, canDelete: false },");
  admin = admin.replace("movies: { canView: Boolean, canCreate: Boolean, canEdit: Boolean, canDelete: Boolean },", "movies: { canView: Boolean, canCreate: Boolean, canEdit: Boolean, canDelete: Boolean },\n        tvShows: { canView: Boolean, canCreate: Boolean, canEdit: Boolean, canDelete: Boolean },");
}
fs.writeFileSync(adminPath, admin);

// 3. Section.ts
let sectionPath = '/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/models/Section.ts';
let section = fs.readFileSync(sectionPath, 'utf8');

if (!section.includes("'tvshow'")) {
  section = section.replace("contentType: 'movie' | 'mixed' | 'web';", "contentType: 'movie' | 'mixed' | 'web' | 'tvshow';");
  section = section.replace("enum: ['movie', 'mixed', 'web'],", "enum: ['movie', 'mixed', 'web', 'tvshow'],");
  section = section.replace("itemType?: 'card' | 'poster' | 'thumbnail' | 'landscape' | 'portrait' | 'drama' | 'home-banner' | 'google-adsense';", "itemType?: 'card' | 'poster' | 'thumbnail' | 'landscape' | 'portrait' | 'drama' | 'tvshow' | 'home-banner' | 'google-adsense';");
  section = section.replace("enum: ['card', 'poster', 'thumbnail', 'landscape', 'portrait', 'drama', 'home-banner', 'google-adsense'],", "enum: ['card', 'poster', 'thumbnail', 'landscape', 'portrait', 'drama', 'tvshow', 'home-banner', 'google-adsense'],");
}
fs.writeFileSync(sectionPath, section);

console.log('Files updated');
