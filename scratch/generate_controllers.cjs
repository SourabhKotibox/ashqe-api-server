const fs = require('fs');

const movieCtrlPath = '/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/controllers/movieController.ts';
let movieCtrl = fs.readFileSync(movieCtrlPath, 'utf8');
movieCtrl = movieCtrl.replace(/MovieModel/g, 'TVShowModel');
movieCtrl = movieCtrl.replace(/Movie/g, 'TVShow');
movieCtrl = movieCtrl.replace(/movie/g, 'tvShow');
movieCtrl = movieCtrl.replace(/movies/g, 'tvShows');
movieCtrl = movieCtrl.replace(/Movies/g, 'TVShows');
// Add EpisodeModel import
movieCtrl = movieCtrl.replace("import { TVShowModel } from '../models/TVShow';", "import { TVShowModel } from '../models/TVShow';\nimport { EpisodeModel } from '../models/Episode';");

// Inside deleteTVShow add EpisodeModel.deleteMany({ tvShowId: id })
movieCtrl = movieCtrl.replace(
  "const tvShow = await TVShowModel.findByIdAndDelete(id);",
  "const tvShow = await TVShowModel.findByIdAndDelete(id);\n    if (tvShow) await EpisodeModel.deleteMany({ tvShowId: id });"
);

// Inside getTVShowById add episodeCount
movieCtrl = movieCtrl.replace(
  "const tvShow = await TVShowModel.findById(id)",
  "const episodeCount = await EpisodeModel.countDocuments({ tvShowId: id });\n    const tvShow = await TVShowModel.findById(id)"
);
movieCtrl = movieCtrl.replace(
  "...tvShow,",
  "...tvShow,\n        episodeCount,"
);
fs.writeFileSync('/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/controllers/tvShowController.ts', movieCtrl);


const epCtrlPath = '/Users/sourabhjhajharia/Desktop/Triple mindes/api-server/src/controllers/episodeController.ts';
let epCtrl = fs.readFileSync(epCtrlPath, 'utf8');
epCtrl = epCtrl.replace(/ContentModel/g, 'TVShowModel');
epCtrl = epCtrl.replace(/Content/g, 'TVShow');
epCtrl = epCtrl.replace(/contentId/g, 'tvShowId');
epCtrl = epCtrl.replace(/contentType/g, 'TVShowType');
fs.writeFileSync('/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/controllers/episodeController.ts', epCtrl);


const appSeriesCtrlPath = '/Users/sourabhjhajharia/Desktop/Triple mindes/api-server/src/controllers/appSeriesController.ts';
let appSeriesCtrl = fs.readFileSync(appSeriesCtrlPath, 'utf8');
appSeriesCtrl = appSeriesCtrl.replace(/ContentModel/g, 'TVShowModel');
appSeriesCtrl = appSeriesCtrl.replace(/Content/g, 'TVShow');
appSeriesCtrl = appSeriesCtrl.replace(/contentId/g, 'tvShowId');
appSeriesCtrl = appSeriesCtrl.replace(/type: 'series'/g, '/* type check removed */');
appSeriesCtrl = appSeriesCtrl.replace(/series\.type !== 'series'/g, 'false'); // Just remove type check
fs.writeFileSync('/Users/sourabhjhajharia/Desktop/ashqe/ashqe-api-server/src/controllers/appSeriesController.ts', appSeriesCtrl);

console.log('Controllers generated');
