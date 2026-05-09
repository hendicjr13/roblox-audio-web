const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ytdl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// Convert audio
function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters('atempo=0.43')
      .toFormat('ogg')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// Upload ke Roblox
async function uploadToRoblox(filePath, apiKey, userId) {
  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: 'Audio ' + Date.now(),
    description: '',
    assetType: 'Audio',
    creationContext: { creator: { userId: parseInt(userId) } }
  }));
  form.append('fileContent', fs.createReadStream(filePath), {
    filename: 'audio.ogg',
    contentType: 'audio/ogg'
  });

  const res = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { ...form.getHeaders(), 'x-api-key': apiKey }
  });
  return res.data;
}

// Route: upload MP3
app.post('/convert-mp3', upload.single('file'), async (req, res) => {
  try {
    const { apiKey, userId } = req.body;
    const inputPath = req.file.path;
    const outputPath = inputPath + '.ogg';

    await convertAudio(inputPath, outputPath);
    const result = await uploadToRoblox(outputPath, apiKey, userId);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route: YouTube/SoundCloud
app.post('/convert-url', async (req, res) => {
  try {
    const { url, apiKey, userId } = req.body;
    const tmpInput = `uploads/yt_${Date.now()}.mp3`;
    const tmpOutput = tmpInput + '.ogg';

    await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: tmpInput });
    await convertAudio(tmpInput, tmpOutput);
    const result = await uploadToRoblox(tmpOutput, apiKey, userId);

    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpOutput);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));