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

// Force atempo — rubberband artifact di ratio tinggi
console.log('Audio engine: atempo (optimized)');

function buildAudioFilters(speedMultiplier, amplifyDb) {
  const filters = [];

  // asetrate: naikin speed + pitch sekaligus (kayak Change Speed di Audacity)
  // suara jadi beda dari ori → efektif bypass copyright fingerprint
  filters.push(`asetrate=44100*${speedMultiplier.toFixed(4)}`);

  // Resample balik ke 44100 setelah rate diubah
  filters.push('aresample=44100');

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

// Cobalt API — open source YouTube downloader, maintain bypass sendiri
function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  if (!match) throw new Error('URL YouTube tidak valid');
  return match[1];
}

async function getYoutubeTitle(url) {
  try {
    // Ambil title dari YouTube oEmbed — simple, ga butuh auth
    const videoId = extractVideoId(url);
    const res = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      timeout: 10000
    });
    return res.data?.title || '';
  } catch (_) { return ''; }
}

async function downloadYoutube(url, outputPath) {
  console.log('Cobalt: requesting download URL...');

  // Pake https module langsung buat handle redirect + stream properly
  const https = require('https');
  const http = require('http');

  const cobaltRes = await axios.post(
    'https://cobalt-production-571e.up.railway.app/',
    {
      url,
      downloadMode: 'audio',
      audioFormat: 'best',
      filenameStyle: 'basic',
      alwaysProxy: true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 30000,
    }
  );

  const cobaltData = cobaltRes.data;
  console.log('Cobalt status:', cobaltData?.status);
  console.log('Cobalt url:', cobaltData?.url?.substring(0, 80));

  if (!cobaltData.url) {
    throw new Error('Cobalt error: ' + (cobaltData.error?.code || JSON.stringify(cobaltData)));
  }

  // Download pake native https/http biar handle redirect & stream dengan bener
  return new Promise((resolve, reject) => {
    const downloadUrl = cobaltData.url;
    const writer = fs.createWriteStream(outputPath);

    const makeRequest = (reqUrl) => {
      const lib = reqUrl.startsWith('https') ? https : http;
      lib.get(reqUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*',
        }
      }, (res) => {
        console.log('Download status:', res.statusCode, 'content-type:', res.headers['content-type']);

        // Follow redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log('Following redirect to:', res.headers.location.substring(0, 80));
          makeRequest(res.headers.location);
          return;
        }

        res.pipe(writer);
        writer.on('finish', () => {
          const size = fs.statSync(outputPath).size;
          console.log('Downloaded file size:', size, 'bytes');
          if (size === 0) reject(new Error('Downloaded file kosong'));
          else resolve();
        });
        writer.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };

    makeRequest(downloadUrl);
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
