const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// Simpan file preview sementara
const previews = {};

function convertAudio(inputPath, outputPath, speed = 0.43) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`atempo=${speed}`)
      .toFormat('ogg')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

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

// Route: preview MP3
app.post('/preview-mp3', upload.single('file'), async (req, res) => {
  try {
    const speed = req.body.speed || 0.43;
    const inputPath = req.file.path;
    const previewId = 'prev_' + Date.now();
    const outputPath = `uploads/${previewId}.ogg`;

    await convertAudio(inputPath, outputPath, speed);
    fs.unlinkSync(inputPath);

    previews[previewId] = outputPath;
    setTimeout(() => {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      delete previews[previewId];
    }, 10 * 60 * 1000); // hapus setelah 10 menit

    res.json({ success: true, previewId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route: preview URL
app.post('/preview-url', async (req, res) => {
  try {
    const { url, speed = 0.43 } = req.body;
    const previewId = 'prev_' + Date.now();
    const tmpInput = `uploads/yt_${Date.now()}.mp3`;
    const outputPath = `uploads/${previewId}.ogg`;

    await new Promise((resolve, reject) => {
  const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
  stream.pipe(fs.createWriteStream(tmpInput));
  stream.on('end', resolve);
  stream.on('error', reject);
});
    await convertAudio(tmpInput, outputPath, speed);
    fs.unlinkSync(tmpInput);

    previews[previewId] = outputPath;
    setTimeout(() => {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      delete previews[previewId];
    }, 10 * 60 * 1000);

    res.json({ success: true, previewId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route: serve preview file
app.get('/preview/:id', (req, res) => {
  const filePath = previews[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  res.setHeader('Content-Type', 'audio/ogg');
  fs.createReadStream(filePath).pipe(res);
});

// Route: upload MP3
app.post('/upload-mp3', upload.single('file'), async (req, res) => {
  try {
    const { apiKey, userId, speed = 0.43 } = req.body;
    const inputPath = req.file.path;
    const outputPath = inputPath + '.ogg';

    await convertAudio(inputPath, outputPath, speed);
    const result = await uploadToRoblox(outputPath, apiKey, userId);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route: upload URL
app.post('/upload-url', async (req, res) => {
  try {
    const { url, apiKey, userId, speed = 0.43 } = req.body;
    const tmpInput = `uploads/yt_${Date.now()}.mp3`;
    const tmpOutput = tmpInput + '.ogg';

    await new Promise((resolve, reject) => {
  const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
  stream.pipe(fs.createWriteStream(tmpInput));
  stream.on('end', resolve);
  stream.on('error', reject);
});
    await convertAudio(tmpInput, tmpOutput, speed);
    const result = await uploadToRoblox(tmpOutput, apiKey, userId);

    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpOutput);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));