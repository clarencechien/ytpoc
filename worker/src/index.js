/**
 * ytpoc-admin Worker — v2-personal 寫入面(整站唯一有寫入權的元件)
 *
 * 部署前提:整個 Worker 網域放在 Cloudflare Access 後面(Google SSO),
 * 未登入的請求根本到不了這裡;到了這裡再比對 ALLOWED_EMAIL 當第二道鎖。
 * 公開播放頁不經過本 Worker——直接從 R2 公開網域讀 cues.json。
 *
 * R2 佈局:
 *   index.json                     全站影片清單
 *   videos/<id>/meta.json          標題等 metadata
 *   videos/<id>/status.json        pipeline 狀態(admin 頁輪詢)
 *   videos/<id>/aligned.json       對齊後待翻 cues
 *   videos/<id>/zh/batch_NN.json   翻譯批次
 *   videos/<id>/cues.json          成品(播放頁讀這個)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const j = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      let m;
      // ---- 公開唯讀(播放頁用,不需登入)----
      if (p === "/list" && req.method === "GET")
        return j((await getJSON(env, "index.json")) || []);
      if ((m = p.match(/^\/cues\/([\w-]{11})$/)) && req.method === "GET") {
        const cues = await getJSON(env, `videos/${m[1]}/cues.json`);
        return cues ? j(cues) : j({ error: "not found" }, 404);
      }

      // ---- 以下全部要過 Access(Google SSO)+ email allowlist ----
      const email = req.headers.get("Cf-Access-Authenticated-User-Email");
      if (!email || email !== env.ALLOWED_EMAIL)
        return j({ error: "forbidden: Access login required" }, 403);

      if (p === "/admin" && req.method === "GET") return adminPage();
      if (p === "/admin/videos" && req.method === "POST") return await createVideo(req, env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/status$/)) && req.method === "GET")
        return await getStatus(m[1], env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/translate$/)) && req.method === "POST")
        return await translateNextBatch(m[1], env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/finalize$/)) && req.method === "POST")
        return await finalize(m[1], env);
      return j({ error: "not found" }, 404);
    } catch (e) {
      return j({ error: String(e && e.stack || e) }, 500);
    }
  },
};

// ---------- R2 helpers ----------
const getJSON = async (env, key) => {
  const o = await env.STORE.get(key);
  return o ? JSON.parse(await o.text()) : null;
};
const putJSON = (env, key, data) =>
  env.STORE.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });

// ---------- 建立影片:收 link + 字幕原料(路線A 手動上傳版) ----------
// body: { url, ko_json3?, en_vtt? }  原料先由 admin 頁貼上;自動抓軌之後再加
async function createVideo(req, env) {
  const body = await req.json();
  const id = (body.url || "").match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
  if (!id) return j({ error: "無法從 URL 解析 video id" }, 400);

  // 沒手貼原料就自動抓字幕軌;抓不到(無字幕/YouTube 擋 IP)回明確錯誤指引手貼
  let source = "manual";
  if (!body.ko_json3 && !body.en_vtt) {
    const got = await fetchCaptions(id);
    if (!got.ko_json3 && !got.en_vtt)
      return j({ error: `自動抓不到可用字幕軌(tracks: ${got.tracks.join(", ") || "無"})。請手動貼上 json3/vtt。`, tracks: got.tracks }, 422);
    body.ko_json3 = got.ko_json3 || undefined;
    body.en_vtt = got.en_vtt || undefined;
    body.title = body.title || got.title;
    source = `auto(${got.tracks.join(",")})`;
  }

  const words = body.ko_json3 ? parseJson3(body.ko_json3) : [];
  const enCues = body.en_vtt ? parseVtt(body.en_vtt) : [];
  const aligned = enCues.length ? attachKo(enCues, words) : resegment(words);
  if (!aligned.length) return j({ error: "解析後 0 cues,原料格式不對?" }, 400);

  await putJSON(env, `videos/${id}/meta.json`, {
    id, url: `https://www.youtube.com/watch?v=${id}`,
    title: body.title || id, created: new Date().toISOString(), source,
  });
  await putJSON(env, `videos/${id}/aligned.json`, aligned);
  await putJSON(env, `videos/${id}/status.json`, {
    stage: "aligned", cues: aligned.length,
    batches: Math.ceil(aligned.length / +env.BATCH_SIZE), done_batches: 0,
  });
  return j({ id, cues: aligned.length });
}

// ---------- 翻譯:每呼叫一次做一批(admin 頁輪詢驅動,免 Queues) ----------
async function translateNextBatch(id, env) {
  const status = await getJSON(env, `videos/${id}/status.json`);
  if (!status) return j({ error: "unknown video" }, 404);
  if (status.done_batches >= status.batches) return j({ ...status, note: "all batches done" });

  const aligned = await getJSON(env, `videos/${id}/aligned.json`);
  const size = +env.BATCH_SIZE;
  const n = status.done_batches;
  const slice = aligned.slice(n * size, (n + 1) * size);
  const context = aligned.slice(Math.max(0, n * size - 3), n * size);

  const zh = await geminiTranslate(env, slice, context);
  await putJSON(env, `videos/${id}/zh/batch_${String(n).padStart(2, "0")}.json`, zh);
  status.done_batches = n + 1;
  status.stage = status.done_batches >= status.batches ? "translated" : "translating";
  await putJSON(env, `videos/${id}/status.json`, status);
  return j(status);
}

async function geminiTranslate(env, cues, context) {
  const prompt = `你是韓國綜藝字幕譯者。把每個 cue 翻成台灣正體中文。
規則:speech 以韓文 ko 為語意主源(en 為人工英譯參考,韓英矛盾信韓文);card 是畫面字卡,由 en 翻譯,用韓綜字卡語感(短、有哏)。
台灣用詞(禁:視頻/質量/網絡/信息/軟件/屏幕/立馬);綜藝口語;每行≤20全形字,超過在語意邊界用\\n斷行(最多兩行);ko 中的 >> 是說話者標記不要翻;沒把握的句尾加⚠。
前文語境(僅參考,不要輸出):${JSON.stringify(context.map(c => c.zh || c.en))}
輸出 JSON 陣列,每個元素 {"id":<原id>,"zh":"譯文"},id 必須與輸入一一對應、一個不漏。
輸入 cues:${JSON.stringify(cues.map(({ id, kind, ko, en }) => ({ id, kind, ko, en })))}`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
  const byId = new Map(out.map(o => [o.id, o.zh]));
  const missing = cues.filter(c => !byId.get(c.id));
  if (missing.length) throw new Error(`Gemini 漏翻 ${missing.length} 句: ${missing.map(c => c.id).slice(0, 5)}`);
  return out;
}

// ---------- 成品:合併批次 → cues.json + index.json ----------
async function finalize(id, env) {
  const status = await getJSON(env, `videos/${id}/status.json`);
  if (!status || status.done_batches < status.batches)
    return j({ error: "尚有批次未翻完", status }, 400);

  const aligned = await getJSON(env, `videos/${id}/aligned.json`);
  const zh = new Map();
  for (let n = 0; n < status.batches; n++) {
    const b = await getJSON(env, `videos/${id}/zh/batch_${String(n).padStart(2, "0")}.json`);
    for (const row of b) zh.set(row.id, row.zh);
  }
  const banned = ["视", "質量", "網絡", "軟件", "屏幕", "立馬"];
  const problems = [];
  const cues = aligned.map(c => {
    const z = (zh.get(c.id) || "").trim();
    if (!z) problems.push(`empty ${c.id}`);
    for (const b of banned) if (z.includes(b)) problems.push(`banned ${b} @${c.id}`);
    return { ...c, zh: z };
  });
  if (problems.length) return j({ error: "品質檢查未過", problems: problems.slice(0, 20) }, 400);

  await putJSON(env, `videos/${id}/cues.json`, cues);
  const meta = await getJSON(env, `videos/${id}/meta.json`);
  const index = (await getJSON(env, "index.json")) || [];
  if (!index.find(v => v.id === id))
    index.push({ id, title: meta.title, cues: cues.length, created: meta.created });
  await putJSON(env, "index.json", index);
  status.stage = "done";
  await putJSON(env, `videos/${id}/status.json`, status);
  return j({ id, stage: "done", cues: cues.length });
}

async function getStatus(id, env) {
  const s = await getJSON(env, `videos/${id}/status.json`);
  return s ? j(s) : j({ error: "unknown video" }, 404);
}

// ---------- 自動抓 YouTube 字幕軌(innertube player API) ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchCaptions(id) {
  const r = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, "origin": "https://www.youtube.com" },
      body: JSON.stringify({
        videoId: id,
        context: { client: { clientName: "WEB", clientVersion: "2.20260701.00.00", hl: "en" } },
      }),
    });
  if (!r.ok) throw new Error(`YouTube innertube ${r.status}(可能擋了 Cloudflare IP)——請手動貼上字幕原料`);
  const d = await r.json();
  const ps = d.playabilityStatus?.status;
  if (ps && ps !== "OK")
    throw new Error(`影片不可用:${ps} ${d.playabilityStatus?.reason || ""}`);
  const tracks = d.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const names = tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`);
  // ko:人工優先、退 ASR;en:僅取人工(ASR 英譯無字卡慣例、參考價值低)
  const ko = tracks.find(t => t.languageCode?.startsWith("ko") && t.kind !== "asr")
          || tracks.find(t => t.languageCode?.startsWith("ko"));
  const en = tracks.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr");
  const grab = async (t, fmt) => {
    if (!t) return null;
    const u = t.baseUrl + (t.baseUrl.includes("?") ? "&" : "?") + "fmt=" + fmt;
    const rr = await fetch(u, { headers: { "user-agent": UA } });
    if (!rr.ok) return null;
    const txt = await rr.text();
    return txt.length > 50 ? txt : null;
  };
  return {
    ko_json3: await grab(ko, "json3"),
    en_vtt: await grab(en, "vtt"),
    title: d.videoDetails?.title,
    tracks: names,
  };
}

// ---------- 解析/對齊(v1 python pipeline 的 JS 移植) ----------
function parseJson3(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const words = [];
  for (const ev of data.events || []) {
    if (ev.tStartMs == null) continue;
    for (const seg of ev.segs || []) {
      const w = (seg.utf8 || "").trim();
      if (!w || w === "\n" || /^\[.+\]$/.test(w)) continue;
      words.push([(ev.tStartMs + (seg.tOffsetMs || 0)) / 1000, w]);
    }
  }
  return words.sort((a, b) => a[0] - b[0]);
}

function parseVtt(raw) {
  const cues = [];
  const re = /(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)[^\n]*\n([\s\S]*?)(?=\n\n|$)/g;
  const ts = (m, i) => +m[i] * 3600 + +m[i + 1] * 60 + +m[i + 2] + +m[i + 3] / 1000;
  let m;
  while ((m = re.exec(raw))) {
    let text = m[9].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
    if (!text) continue;
    const start = +ts(m, 1).toFixed(3), end = +ts(m, 5).toFixed(3);
    let rest = text.replace(/\s*\n\s*/g, " ").trim();
    const add = (kind, en) => cues.push({ id: cues.length, start, end, kind, en });
    let m2;
    while ((m2 = rest.match(/^\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*/))) {
      add("card", m2[1].trim());
      rest = rest.slice(m2[0].length);
    }
    if (rest) add("speech", rest);
  }
  return cues;
}

function attachKo(enCues, words) {
  let wi = 0;
  for (const cue of enCues) {
    if (cue.kind !== "speech") { cue.ko = ""; continue; }
    const lo = cue.start - 0.3, hi = cue.end + 0.3;
    while (wi < words.length && words[wi][0] < lo) wi++;
    let jdx = wi;
    const picked = [];
    while (jdx < words.length && words[jdx][0] <= hi) picked.push(words[jdx++][1]);
    cue.ko = picked.join(" ");
    wi = jdx;
  }
  return enCues;
}

// 只有 ASR 時的備援斷句(v1 A0 參數)
function resegment(words) {
  const GAP = 0.8, MAX = 42, PAD = 0.6;
  const groups = [];
  let cur = [], len = 0;
  for (const [t, w] of words) {
    if (cur.length && (t - cur[cur.length - 1][0] > GAP || len + w.length + 1 > MAX)) {
      groups.push(cur); cur = []; len = 0;
    }
    cur.push([t, w]); len += w.length + 1;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({
    id: i, kind: "speech", ko: g.map(x => x[1]).join(" "), en: "",
    start: +g[0][0].toFixed(3),
    end: +Math.min(g[g.length - 1][0] + PAD, groups[i + 1]?.[0][0] ?? Infinity).toFixed(3),
  }));
}

// ---------- 內建 admin 頁 ----------
function adminPage() {
  return new Response(`<!DOCTYPE html><html lang="zh-Hant-TW"><meta charset="utf-8">
<title>ytpoc admin</title>
<style>body{font-family:sans-serif;max-width:760px;margin:2em auto;background:#0f1115;color:#e8eaf0}
input,textarea,button{width:100%;margin:.3em 0;background:#171a21;color:#e8eaf0;border:1px solid #333;border-radius:6px;padding:.5em}
button{cursor:pointer;width:auto;padding:.5em 1.4em}#log{white-space:pre-wrap;font-size:13px;color:#9c6}</style>
<h2>ytpoc 個人版 admin</h2>
<input id="url" placeholder="YouTube 連結">
<input id="title" placeholder="標題(選填)">
<textarea id="json3" rows="3" placeholder="(選填)ko json3 內容——留空會自動抓字幕軌"></textarea>
<textarea id="vtt" rows="3" placeholder="(選填)en vtt 內容——留空會自動抓;有人工英文字幕品質最佳"></textarea>
<button onclick="run()">建立並全自動翻譯</button>
<div id="log"></div>
<script>
const log = m => document.getElementById('log').textContent += m + '\\n';
async function api(path, opts){ const r = await fetch(path, opts); const d = await r.json();
  if(!r.ok) throw new Error(JSON.stringify(d)); return d; }
async function run(){
  try{
    const body = { url: url.value, title: title.value,
      ko_json3: json3.value || undefined, en_vtt: vtt.value || undefined };
    const v = await api('/admin/videos', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    log('建立 ' + v.id + ',' + v.cues + ' cues');
    let s;
    do { s = await api('/admin/videos/' + v.id + '/translate', {method:'POST'});
         log('批次 ' + s.done_batches + '/' + s.batches); } while(s.done_batches < s.batches);
    const f = await api('/admin/videos/' + v.id + '/finalize', {method:'POST'});
    log('完成:' + JSON.stringify(f));
  }catch(e){ log('錯誤:' + e.message); }
}
</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
