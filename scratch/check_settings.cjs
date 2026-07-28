const mongoose = require('mongoose');

async function checkSettings() {
  await mongoose.connect('mongodb://localhost:27017/triple-mindes');
  
  const AppSetting = mongoose.model('AppSetting', new mongoose.Schema({}, { strict: false }));
  const settings = await AppSetting.find({}).lean();
  console.log(JSON.stringify(settings, null, 2));

  await mongoose.disconnect();
}

checkSettings();
