const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('Using system ffmpeg');
} catch (_) {
  const ffmpegStatic = require('ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegStatic);
  console.log('Using ffmpeg-static fallback');
}

const TMP = os.tmpdir();
const app = express();
const upload = multer({ dest: TMP });

app.use(express.json());
app.use(express.static('public'));

const previews = {};

// Force atempo — rubberband artifact di ratio tinggi
console.log('Audio engine: atempo (optimized)');

function buildAudioFilters(speedMultiplier, amplifyDb) {
  const filters = [];

  // Resample ke 44100 sebelum processing
  filters.push('aresample=async=1:min_hard_comp=0.100000:first_pts=0');

  // Atempo chain — max 2.0 per node
  let remaining = speedMultiplier;
  const atempoChain = [];
  while (remaining > 2.0) {
    atempoChain.push('atempo=2.0');
    remaining /= 2.0;
  }
  if (remaining > 1.0001) atempoChain.push(`atempo=${remaining.toFixed(6)}`);
  filters.push(...atempoChain);

  // Amplify
  if (amplifyDb !== 0) filters.push(`volume=${amplifyDb}dB`);

  return filters;
}

function convertAudio(inputPath, outputPath, options = {}) {
  const { robloxPlayback = 0.43, asIs = false, amplify = -4, maxDuration = 400 } = options;
  const speedMultiplier = Math.round((1 / parseFloat(robloxPlayback)) * 100) / 100;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath)
      .setDuration(maxDuration)
      .audioFrequency(44100)
      .audioChannels(2);

    if (!asIs) {
      cmd.audioFilters(buildAudioFilters(speedMultiplier, parseFloat(amplify)));
    }

    cmd
      .toFormat('ogg')
      .audioCodec('libvorbis')
      .audioBitrate('192k')
      .on('start', c => console.log('FFmpeg:', c))
      .on('end', resolve)
      .on('error', err => { console.error('FFmpeg error:', err.message); reject(err); })
      .save(outputPath);
  });
}

async function getYoutubeTitle(url) {
  try {
    const info = await ytdl.getBasicInfo(url);
    return info.videoDetails.title || '';
  } catch (_) { return ''; }
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

async function pollOperationStatus(operationId, apiKey) {
  const res = await axios.get(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
    headers: { 'x-api-key': apiKey }
  });
  return res.data;
}

function parseOptions(body) {
  return {
    robloxPlayback: parseFloat(body.robloxPlayback) || 0.43,
    asIs: body.asIs === 'true' || body.asIs === true,
    amplify: parseFloat(body.amplify ?? -4),
    maxDuration: parseInt(body.maxDuration) || 400,
  };
}

function scheduleCleanup(filePath, previewId) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (previewId) delete previews[previewId];
  }, 10 * 60 * 1000);
}

app.get('/info', (req, res) => res.json({ engine: 'atempo-optimized' }));

app.post('/get-title', async (req, res) => {
  try {
    const title = await getYoutubeTitle(req.body.url);
    res.json({ success: true, title });
  } catch (_) { res.json({ success: false, title: '' }); }
});

app.post('/preview-mp3', upload.single('file'), async (req, res) => {
  try {
    const options = parseOptions(req.body);
    const inputPath = req.file.path;
    const previewId = 'prev_' + Date.now();
    const outputPath = path.join(TMP, `${previewId}.ogg`);
    await convertAudio(inputPath, outputPath, options);
    fs.unlinkSync(inputPath);
    previews[previewId] = outputPath;
    scheduleCleanup(outputPath, previewId);
    res.json({ success: true, previewId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/preview-url', async (req, res) => {
  try {
    const options = parseOptions(req.body);
    const { url } = req.body;
    const previewId = 'prev_' + Date.now();
    const tmpInput = path.join(TMP, `yt_${Date.now()}.mp3`);
    const outputPath = path.join(TMP, `${previewId}.ogg`);
    await downloadYoutube(url, tmpInput);
    await convertAudio(tmpInput, outputPath, options);
    fs.unlinkSync(tmpInput);
    previews[previewId] = outputPath;
    scheduleCleanup(outputPath, previewId);
    res.json({ success: true, previewId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/preview/:id', (req, res) => {
  const filePath = previews[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Preview not found' });
  res.setHeader('Content-Type', 'audio/ogg');
  fs.createReadStream(filePath).pipe(res);
});

app.post('/upload-mp3', upload.single('file'), async (req, res) => {
  try {
    const options = parseOptions(req.body);
    const { apiKey, userId, displayName } = req.body;
    const inputPath = req.file.path;
    const outputPath = path.join(TMP, `out_${Date.now()}.ogg`);
    await convertAudio(inputPath, outputPath, options);
    const result = await uploadToRoblox(outputPath, apiKey, userId, displayName);
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/upload-url', async (req, res) => {
  try {
    const options = parseOptions(req.body);
    const { url, apiKey, userId, displayName } = req.body;
    const tmpInput = path.join(TMP, `yt_${Date.now()}.mp3`);
    const tmpOutput = path.join(TMP, `out_${Date.now()}.ogg`);
    await downloadYoutube(url, tmpInput);
    await convertAudio(tmpInput, tmpOutput, options);
    const result = await uploadToRoblox(tmpOutput, apiKey, userId, displayName);
    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpOutput);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/status/:operationId', async (req, res) => {
  try {
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const data = await pollOperationStatus(req.params.operationId, apiKey);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
