import mongoose from 'mongoose';
import { TVShowModel } from './src/models/TVShow';
import { connectDB } from './src/lib/db';

async function run() {
  await connectDB('mongodb://localhost:27017/ashqe'); // assuming local db
  
  await TVShowModel.deleteMany({});
  
  const show = await TVShowModel.create({
    title: 'Test Web Series',
    status: 'published',
  });
  
  console.log("Created:", show._id);

  const query = { page: 1, limit: 100 };
  const filter: any = {};
  
  const tvShows = await TVShowModel.find(filter)
        .populate('genres', 'name image')
        .populate('categories', 'name thumbnail')
        .populate('languages', 'name')
        .populate('subtitleLanguages', 'name')
        .populate('audioLanguages', 'name')
        .populate('cast.actor', 'name image')
        .populate('crew.director', 'name')
        .populate('subtitles.language', 'name code')
        .sort({ createdAt: -1 })
        .skip(0)
        .limit(100)
        .lean();
        
  console.log("Found:", tvShows.length);
  process.exit(0);
}

run();
