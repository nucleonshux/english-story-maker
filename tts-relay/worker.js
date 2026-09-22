/**
 * 免费中继 · Cloudflare Workers 版（推荐部署方式，粘贴即用，无需服务器、无费用）
 * -----------------------------------------------------------------------------
 * 部署：https://workers.cloudflare.com → 新建 Worker → 粘贴本文件全部代码 → 保存并部署。
 * 免费计划每天 10 万次请求，个人使用绰绰有余；部署后把 `https://xxx.workers.dev` 填进
 * 应用「设置 → 配音 TTS 中继地址」即可，故事模型选「豆包」也走同一个地址。
 *
 * 接口：
 *   GET  /tts?text=Hello&voice=en-US-JennyNeural&rate=-8%
 *         → { audio: "<mp3 base64>", words: [{word,start,dur}], duration: 秒 }
 *   POST /llm  请求体 { url, apiKey, model, messages, maxTokens }
 *         → 原样转发 OpenAI 兼容接口（用于豆包等被浏览器 CORS 拦截的模型）
 */
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VER = '1-143.0.3650.75';
const WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(cors, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function generateToken() {
  let t = Date.now() / 1000 + 11644473600; // 转 Windows 文件时间纪元
  t -= t % 300; // 向下取整到 5 分钟
  t *= 1e7;     // 100ns 刻度
  return (await sha256Hex(t.toFixed(0) + EDGE_TOKEN)).toUpperCase();
}
function dateStr() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ---------- Edge TTS（Workers 用 fetch + Upgrade 携带完整握手头） ---------- */
async function edgeSynth(text, voice, rate) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const token = await generateToken();
  const url = WSS + '?TrustedClientToken=' + EDGE_TOKEN + '&ConnectionId=' + id +
    '&Sec-MS-GEC=' + token + '&Sec-MS-GEC-Version=' + EDGE_VER;
  const muid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'muid=' + muid + ';',
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error('Edge 握手失败 HTTP ' + resp.status);
  ws.accept();
  return new Promise((resolve, reject) => {
    let total = 0, buf = new Uint8Array(0), settled = false;
    const words = [];
    const finish = (err, res) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(res); };
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} finish(new Error('合成超时')); }, 45000);
    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        const i = data.indexOf('\r\n\r\n');
        if (i >= 0 && data.slice(0, i).includes('Path:audio.metadata')) {
          try {
            const j = JSON.parse(data.slice(i + 4));
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
        if (data.includes('Path:turn.end')) { try { ws.close(); } catch (e) {} }
      } else {
        const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
        if (arr.length < 2) return;
        const hl = (arr[0] << 8) | arr[1];
        if (2 + hl > arr.length) return;
        const p = arr.subarray(2 + hl);
        if (p.length) {
          const n = new Uint8Array(total + p.length);
          n.set(buf, 0); n.set(p, total);
          buf = n; total += p.length;
        }
      }
    });
    ws.addEventListener('close', () => {
      if (!total) return finish(new Error('未收到音频'));
      const duration = words.length ? Math.max(...words.map((w) => w.start + w.dur)) : 0;
      finish(null, { audio: bytesToB64(buf), words, duration: Math.max(duration, 0.1) });
    });
    ws.addEventListener('error', () => finish(new Error('WebSocket 错误')));
    const cfg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
    ws.send('X-Timestamp:' + dateStr() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + cfg + '\r\n');
    const rid = crypto.randomUUID().replace(/-/g, '');
    ws.send('X-RequestId:' + rid + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + dateStr() + 'Z\r\nPath:ssml\r\n\r\n' +
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='" + voice +
      "'><prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>" + escapeXml(text) + '</prosody></voice></speak>');
  });
}

/* ---------- /llm：转发 OpenAI 兼容接口（豆包等，服务端无 CORS 限制） ---------- */
async function handleLlm(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  let j;
  try { j = await request.json(); } catch (e) { return json(CORS, 400, { error: 'bad json' }); }
  const { url, apiKey, model, messages, maxTokens } = j || {};
  if (!url || !apiKey || !model || !Array.isArray(messages)) return json(CORS, 400, { error: 'missing url/apiKey/model/messages' });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 900, temperature: 0.8 }),
  });
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}

/* ---------- /tts ---------- */
async function handleTts(u) {
  const text = u.searchParams.get('text') || '';
  const voice = u.searchParams.get('voice') || 'en-US-JennyNeural';
  const rate = u.searchParams.get('rate') || '-8%';
  if (!text) return json(CORS, 400, { error: 'missing text' });
  const r = await edgeSynth(text, voice, rate);
  return json(CORS, 200, { audio: r.audio, words: r.words, duration: r.duration });
}

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (u.pathname === '/tts' && request.method === 'GET') return await handleTts(u);
      if (u.pathname === '/llm' && request.method === 'POST') return await handleLlm(request);
      return new Response('not found', { status: 404, headers: CORS });
    } catch (e) {
      return json(CORS, 502, { error: String((e && e.message) || e) });
    }
  },
};
