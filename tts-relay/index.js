/**
 * 免费 TTS 中继（Edge 高品质语音 + 词级时间戳）
 * ------------------------------------------------
 * 用途：GitHub Pages 是纯静态托管，浏览器无法直接连接微软 Edge 语音服务（被 403），
 * 本中继在服务端完成连接，把音频 + 逐词时间戳返回给网页，全程免费。
 *
 * 三种运行方式（任选其一）：
 *  1) 本地/自建服务器：node index.js   （默认端口 8899，可设 PORT 环境变量）
 *  2) Netlify Functions：把本目录部署为 Netlify Function（拖拽目录或 CLI）
 *  3) Vercel Serverless：把本文件作为 /api/tts 的默认导出
 *
 * 调用：GET /tts?text=Hello&voice=en-US-JennyNeural&rate=-8%
 * 返回：{ "audio": "<mp3 base64>", "words": [{"word","start","dur"}], "duration": 秒 }
 *
 * 依赖：仅 ws 包（npm install ws）
 */
'use strict';
const crypto = require('crypto');
let WebSocket;
try { WebSocket = require('ws'); } catch (e) { /* 某些平台内置 */ }

const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VER = '1-143.0.3650.75';
const WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

function generateToken() {
  let t = Date.now() / 1000 + 11644473600; // 转 Windows 文件时间纪元
  t -= t % 300; // 向下取整到 5 分钟
  t *= 1e7;     // 100ns 刻度
  return crypto.createHash('sha256').update(t.toFixed(0) + EDGE_TOKEN, 'ascii').digest('hex').toUpperCase();
}
function dateStr() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function buildSSML(text, voice, rate, pitch, volume) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    "<voice name='" + voice + "'><prosody pitch='" + pitch + "' rate='" + rate + "' volume='" + volume + "'>" +
    escapeXml(text) + '</prosody></voice></speak>';
}

async function synth(text, voice, rate) {
  if (!WebSocket) throw new Error('缺少 ws 依赖，请先 npm install ws');
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID().replace(/-/g, '');
    const url = WSS + '?TrustedClientToken=' + EDGE_TOKEN + '&ConnectionId=' + id +
      '&Sec-MS-GEC=' + generateToken() + '&Sec-MS-GEC-Version=' + EDGE_VER;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache', 'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: 'muid=' + crypto.randomBytes(16).toString('hex').toUpperCase() + ';',
        },
      });
    } catch (e) { return reject(e); }
    const chunks = [], words = [];
    let settled = false;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} }, 45000);
    const finish = (err, res) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(res);
    };
    ws.on('open', () => {
      const cfg = 'X-Timestamp:' + dateStr() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-96kbitrate-mono-mp3"}}}}\r\n';
      ws.send(cfg);
      ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + dateStr() + 'Z\r\nPath:ssml\r\n\r\n' +
        buildSSML(text, voice, rate, '+0Hz', '+0%'));
    });
    ws.on('message', (d, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
        if (buf.length < 2) return;
        const hl = (buf[0] << 8) | buf[1];
        if (2 + hl > buf.length) return;
        const p = buf.subarray(2 + hl);
        if (p.length) chunks.push(p);
      } else {
        const s = d.toString();
        const i = s.indexOf('\r\n\r\n');
        if (i >= 0 && s.slice(0, i).includes('Path:audio.metadata')) {
          try {
            const j = JSON.parse(s.slice(i + 4));
            (j.Metadata || []).forEach((m) => {
              if (m.Type === 'WordBoundary' && m.Data) {
                words.push({
                  word: String((m.Data.text && m.Data.text.Text !== undefined) ? m.Data.text.Text : (m.Data.Text || '')),
                  start: (m.Data.Offset || 0) / 1e7,
                  dur: (m.Data.Duration || 0) / 1e7,
                });
              }
            });
          } catch (e) {}
        }
        if (s.includes('Path:turn.end')) { setTimeout(() => { try { ws.close(); } catch (e) {} }, 300); }
      }
    });
    ws.on('error', (e) => finish(e));
    ws.on('close', () => {
      if (!chunks.length) return finish(new Error('no audio received'));
      const audio = Buffer.concat(chunks);
      const duration = words.length ? Math.max.apply(null, words.map((w) => w.start + w.dur)) : 0;
      finish(null, { audio, words, duration: Math.max(duration, 0.1) });
    });
  });
}

/* ---------- 三种入口 ---------- */
function handleHttp(req, res) {
  const ts = new Date().toISOString();
  console.log('[' + ts + '] ' + req.method + ' ' + req.url + ' UA=' + (req.headers['user-agent'] || '').slice(0, 60));
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/llm' && req.method === 'POST') return handleLlm(req, res, cors);
  if (u.pathname === '/health') { res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const text = u.searchParams.get('text') || '';
  const voice = u.searchParams.get('voice') || 'en-US-JennyNeural';
  const rate = u.searchParams.get('rate') || '-8%';
  if (u.pathname !== '/tts') { res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
  if (!text) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing text' })); }
  synth(text, voice, rate)
    .then((r) => {
      const body = JSON.stringify({ audio: r.audio.toString('base64'), words: r.words, duration: r.duration });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
    })
    .catch((e) => { res.writeHead(502, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
}

/* /llm：转发 OpenAI 兼容接口（豆包等被浏览器 CORS 拦截的模型） */
function handleLlm(req, res, cors) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let j;
    try { j = JSON.parse(body); } catch (e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad json' })); }
    const { url, apiKey, model, messages, maxTokens } = j || {};
    if (!url || !apiKey || !model || !Array.isArray(messages)) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing url/apiKey/model/messages' })); }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens || 900, temperature: 0.8 }),
      });
      const text = await r.text();
      res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  });
  req.on('error', () => { try { res.writeHead(500, cors); res.end(); } catch (e) {} });
}

/* Netlify Functions */
exports.handler = async (event) => {
  const path = (event.path || '');
  const corsH = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (path.endsWith('/llm') && event.httpMethod === 'POST') {
    let j; try { j = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: corsH, body: JSON.stringify({ error: 'bad json' }) }; }
    const { url, apiKey, model, messages, maxTokens } = j || {};
    if (!url || !apiKey || !model || !Array.isArray(messages)) return { statusCode: 400, headers: corsH, body: JSON.stringify({ error: 'missing url/apiKey/model/messages' }) };
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify({ model, messages, max_tokens: maxTokens || 900, temperature: 0.8 }) });
      const text = await r.text();
      return { statusCode: r.status, headers: corsH, body: text };
    } catch (e) { return { statusCode: 502, headers: corsH, body: JSON.stringify({ error: String(e && e.message || e) }) }; }
  }
  const text = (event.queryStringParameters && event.queryStringParameters.text) || '';
  const voice = (event.queryStringParameters && event.queryStringParameters.voice) || 'en-US-JennyNeural';
  const rate = (event.queryStringParameters && event.queryStringParameters.rate) || '-8%';
  if (!text) return { statusCode: 400, headers: corsH, body: JSON.stringify({ error: 'missing text' }) };
  try {
    const r = await synth(text, voice, rate);
    return { statusCode: 200, headers: corsH, body: JSON.stringify({ audio: r.audio.toString('base64'), words: r.words, duration: r.duration }) };
  } catch (e) {
    return { statusCode: 502, headers: corsH, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
/* Vercel Serverless */
exports.default = async function (req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
  if (req.method === 'OPTIONS') return res.status(204).set(cors).end();
  const p = (req.url || '').split('?')[0];
  if (p.endsWith('/llm') && req.method === 'POST') {
    const j = req.body || {};
    const { url, apiKey, model, messages, maxTokens } = j;
    if (!url || !apiKey || !model || !Array.isArray(messages)) return res.status(400).set(cors).json({ error: 'missing url/apiKey/model/messages' });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify({ model, messages, max_tokens: maxTokens || 900, temperature: 0.8 }) });
      const text = await r.text();
      res.status(r.status).set(cors).send(text);
    } catch (e) { res.status(502).set(cors).json({ error: String(e && e.message || e) }); }
    return;
  }
  const text = (req.query && req.query.text) || '';
  const voice = (req.query && req.query.voice) || 'en-US-JennyNeural';
  const rate = (req.query && req.query.rate) || '-8%';
  if (!text) return res.status(400).set(cors).json({ error: 'missing text' });
  try {
    const r = await synth(text, voice, rate);
    res.set(cors).json({ audio: r.audio.toString('base64'), words: r.words, duration: r.duration });
  } catch (e) {
    res.status(502).set(cors).json({ error: String(e && e.message || e) });
  }
};

/* 本地直接运行 */
if (require.main === module) {
  const port = process.env.PORT || 8899;
  require('http').createServer(handleHttp).listen(port, () => {
    console.log('TTS relay listening on http://localhost:' + port + '/tts');
  });
}
