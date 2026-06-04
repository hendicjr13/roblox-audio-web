const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const TMP = os.tmpdir();
const app = express();
const upload = multer({ dest: TMP });

app.use(express.json());
app.use(express.static('public'));

const previews = {};

// Hitung speed up factor dari playback speed Roblox
function calcSpeedFactor(robloxPlayback) {
  return 1 / parseFloat(robloxPlayback);
}

// FFmpeg atempo max 2.0 per filter, jadi kalau > 2.0 harus chain
function buildAtempoFilters(speedFactor) {
  const filters = [];
  let remaining = speedFactor;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

function convertAudio(inputPath, outputPath, robloxPlayback) {
  const speedFactor = calcSpeedFactor(robloxPlayback);
  const filters = buildAtempoFilters(speedFactor);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filters)
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
    const robloxPlayback = req.body.robloxPlayback || 0.43;
    const inputPath = req.file.path;
    const previewId = 'prev_' + Date.now();
    const outputPath = path.join(TMP, `${previewId}.ogg`);

    await convertAudio(inputPath, outputPath, robloxPlayback);
    fs.unlinkSync(inputPath);

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
    const { apiKey, userId, robloxPlayback = 0.43 } = req.body;
    const inputPath = req.file.path;
    const outputPath = path.join(TMP, `out_${Date.now()}.ogg`);

    await convertAudio(inputPath, outputPath, robloxPlayback);
    const result = await uploadToRoblox(outputPath, apiKey, userId);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
