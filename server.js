const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ytdl = require('@distube/ytdl-core');
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

function convertAudio(inputPath, outputPath, robloxPlayback, asIs = false) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath).toFormat('ogg');
    if (!asIs) {
      const speedFactor = 1 / parseFloat(robloxPlayback);
      const filters = buildAtempoFilters(speedFactor);
      cmd.audioFilters(filters);
    }
    cmd.on('end', resolve).on('error', reject).save(outputPath);
  });
}

async function downloadYoutube(url, outputPath) {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
    stream.pipe(fs.createWriteStream(outputPath));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

async function uploadToRoblox(filePath, apiKey, userId, displayName) {
  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: displayName || ('Audio ' + Date.now()),
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

// Preview MP3
app.post('/preview-mp3', upload.single('file'), async (req, res) => {
  try {
    const { robloxPlayback = 0.43, asIs = 'false' } = req.body;
    const inputPath = req.file.path;
    const previewId = 'prev_' + Date.now();
    const outputPath = path.join(TMP, `${previewId}.ogg`);

    await convertAudio(inputPath, outputPath, robloxPlayback, asIs === 'true');
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

// Preview URL
app.post('/preview-url', async (req, res) => {
  try {
    const { url, robloxPlayback = 0.43, asIs = false } = req.body;
    const previewId = 'prev_' + Date.now();
    const tmpInput = path.join(TMP, `yt_${Date.now()}.mp3`);
    const outputPath = path.join(TMP, `${previewId}.ogg`);

    await downloadYoutube(url, tmpInput);
    await convertAudio(tmpInput, outputPath, robloxPlayback, asIs);
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

// Serve preview
app.get('/preview/:id', (req, res) => {
  const filePath = previews[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  res.setHeader('Content-Type', 'audio/ogg');
  fs.createReadStream(filePath).pipe(res);
});

// Upload MP3
app.post('/upload-mp3', upload.single('file'), async (req, res) => {
  try {
    const { apiKey, userId, robloxPlayback = 0.43, asIs = 'false', displayName } = req.body;
    const inputPath = req.file.path;
    const outputPath = path.join(TMP, `out_${Date.now()}.ogg`);

    await convertAudio(inputPath, outputPath, robloxPlayback, asIs === 'true');
    const result = await uploadToRoblox(outputPath, apiKey, userId, displayName);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload URL
app.post('/upload-url', async (req, res) => {
  try {
    const { url, apiKey, userId, robloxPlayback = 0.43, asIs = false, displayName } = req.body;
    const tmpInput = path.join(TMP, `yt_${Date.now()}.mp3`);
    const tmpOutput = path.join(TMP, `out_${Date.now()}.ogg`);

    await downloadYoutube(url, tmpInput);
    await convertAudio(tmpInput, tmpOutput, robloxPlayback, asIs);
    const result = await uploadToRoblox(tmpOutput, apiKey, userId, displayName);

    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpOutput);

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
