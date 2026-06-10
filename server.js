const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
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

console.log('Audio engine: atempo (optimized)');

function buildAudioFilters(speedMultiplier, amplifyDb) {
  const filters = [];
  filters.push(`asetrate=44100*${speedMultiplier.toFixed(4)}`);
  filters.push('aresample=44100');
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

    if (!asIs) cmd.audioFilters(buildAudioFilters(speedMultiplier, parseFloat(amplify)));

    cmd.toFormat('ogg')
      .audioCodec('libvorbis')
      .audioBitrate('192k')
      .on('start', c => console.log('FFmpeg:', c))
      .on('end', resolve)
      .on('error', err => { console.error('FFmpeg error:', err.message); reject(err); })
      .save(outputPath);
  });
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  if (!match) throw new Error('URL YouTube tidak valid');
  return match[1];
}

async function getYoutubeTitle(url) {
  try {
    const videoId = extractVideoId(url);
    const res = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 10000 });
    return res.data?.title || '';
  } catch (_) { return ''; }
}

async function downloadYoutube(url, outputPath) {
  const { spawn } = require('child_process');

  // Tulis cookies ke file temp kalau ada di env
  let cookiesFile = null;
  if (process.env.YOUTUBE_COOKIES) {
    cookiesFile = path.join(TMP, 'yt_cookies.txt');
    fs.writeFileSync(cookiesFile, process.env.YOUTUBE_COOKIES);
    console.log('yt-dlp: using cookies from env');
  }

  console.log('yt-dlp: downloading', url);

  const baseArgs = [
    '-x',
    '--no-playlist',
    '--no-warnings',
    '-o', outputPath,
  ];

  if (cookiesFile) baseArgs.push('--cookies', cookiesFile);

  // Coba player clients secara berurutan
  const playerClients = ['tv', 'web_creator', 'mweb', 'android'];

  for (const client of playerClients) {
    console.log(`yt-dlp: trying player_client=${client}`);
    const success = await new Promise((resolve) => {
      const args = [...baseArgs, '--extractor-args', `youtube:player_client=${client}`, url];
      const proc = spawn('yt-dlp', args);

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.stdout.on('data', d => { console.log('yt-dlp:', d.toString().trim()); });
      proc.on('close', code => {
        if (code === 0) {
          // yt-dlp bisa nambahin ekstensi otomatis, cari file yang ada
          const possibleExts = ['', '.m4a', '.webm', '.opus', '.mp3', '.ogg'];
          let foundPath = null;
          for (const ext of possibleExts) {
            const p = outputPath + ext;
            if (fs.existsSync(p) && fs.statSync(p).size > 0) {
              foundPath = p;
              break;
            }
          }
          if (foundPath) {
            // Rename ke outputPath yang diharapkan
            if (foundPath !== outputPath) fs.renameSync(foundPath, outputPath);
            console.log(`yt-dlp: success with client=${client}, size=${fs.statSync(outputPath).size}`);
            resolve(true);
          } else {
            console.log(`yt-dlp: file not found after download, client=${client}`);
            resolve(false);
          }
        } else {
          console.log(`yt-dlp: failed with client=${client}, code=${code}`);
          if (stderr) console.log('yt-dlp stderr:', stderr.slice(-200));
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          resolve(false);
        }
      });
      proc.on('error', (err) => {
        console.log('yt-dlp spawn error:', err.message);
        resolve(false);
      });
    });

    if (success) return;
  }

  throw new Error('yt-dlp gagal dengan semua player clients');
}

async function uploadToRoblox(filePath, apiKey, userId, displayName) {
  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: displayName || ('Audio ' + Date.now()),
    description: '',
    assetType: 'Audio',
    creationContext: { creator: { userId: parseInt(userId) } }
  }));
  form.append('fileContent', fs.createReadStream(filePath), { filename: 'audio.ogg', contentType: 'audio/ogg' });
  const res = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { ...form.getHeaders(), 'x-api-key': apiKey }
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

// ── Routes ────────────────────────────────────────────────────────────

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
    const tmpInput = path.join(TMP, `yt_${Date.now()}.tmp`);
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
    const tmpInput = path.join(TMP, `yt_${Date.now()}.tmp`);
    const tmpOutput = path.join(TMP, `out_${Date.now()}.ogg`);
    await downloadYoutube(url, tmpInput);
    await convertAudio(tmpInput, tmpOutput, options);
    const result = await uploadToRoblox(tmpOutput, apiKey, userId, displayName);
    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpOutput);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Poll operation status
app.get('/status/:operationId', async (req, res) => {
  try {
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const result = await axios.get(
      `https://apis.roblox.com/assets/v1/operations/${req.params.operationId}`,
      { headers: { 'x-api-key': apiKey } }
    );
    res.json({ success: true, data: result.data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Poll moderation status
app.get('/moderation/:assetId', async (req, res) => {
  try {
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const result = await axios.get(
      `https://apis.roblox.com/assets/v1/assets/${req.params.assetId}`,
      { headers: { 'x-api-key': apiKey } }
    );
    console.log('Moderation response:', JSON.stringify(result.data));
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.log('Moderation error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Set asset permissions
app.post('/permissions/:assetId', async (req, res) => {
  try {
    const { apiKey, subjectType, subjectId, action } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

    const payload = {
      requests: [
        {
          subjectType: subjectType || 'User', // User atau Group
          subjectId: String(subjectId),
          action: action || 'Use',
          assetId: String(req.params.assetId),
        }
      ]
    };

    console.log('Permission payload:', JSON.stringify(payload));

    const result = await axios.post(
      'https://apis.roblox.com/asset-permissions/v1/assets/permissions',
      payload,
      { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } }
    );
    console.log('Permission result:', JSON.stringify(result.data));
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.log('Permission error full:', JSON.stringify(err.response?.data));
    console.log('Permission status:', err.response?.status);
    res.status(500).json({ success: false, error: err.response?.data?.message || JSON.stringify(err.response?.data) || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
