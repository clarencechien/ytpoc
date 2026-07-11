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
      if (p === "/admin/models" && req.method === "GET") {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}&pageSize=50`);
        const d = await r.json();
        return j({ current: env.GEMINI_MODEL,
                   available: (d.models || []).map(x => x.name.replace("models/", "")) });
      }
      if (p === "/admin/videos" && req.method === "POST") return await createVideo(req, env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/status$/)) && req.method === "GET")
        return await getStatus(m[1], env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/translate$/)) && req.method === "POST")
        return await translateNextBatch(m[1], env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/finalize$/)) && req.method === "POST")
        return await finalize(m[1], env);
      if ((m = p.match(/^\/admin\/videos\/([\w-]{11})\/gemini$/)) && req.method === "POST")
        return await geminiNextSegment(m[1], env);
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

  // 斷點續跑:影片已建立且沒重新提供原料 → 跳過抓軌,直接回狀態接著跑
  const existing = await getJSON(env, `videos/${id}/status.json`);
  if (existing && !body.ko_json3 && !body.en_vtt) {
    // 補 meta:標題還是裸 id 就補抓(oEmbed),同步修 index
    const meta = await getJSON(env, `videos/${id}/meta.json`);
    if (meta && (!meta.title || meta.title === id)) {
      const t = body.title || await fetchTitle(id);
      if (t) {
        meta.title = t;
        await putJSON(env, `videos/${id}/meta.json`, meta);
        const index = (await getJSON(env, "index.json")) || [];
        const e2 = index.find(v => v.id === id);
        if (e2) { e2.title = t; e2.url = meta.url; await putJSON(env, "index.json", index); }
      }
    }
    // Gemini 任務 + 使用者補了片長 → 延長掃描(修 countTokens 低估造成的字幕截斷)
    const isGemini = existing.seg_s || (meta && meta.source === "gemini-video");
    if (+body.duration_min > 0 && isGemini) {
      const duration_s = Math.round(+body.duration_min * 60);
      if (duration_s > (existing.duration_s || 0)) {
        existing.duration_s = duration_s;
        existing.open = false;
        existing.segments = Math.ceil(duration_s / (existing.seg_s || 360));
        if (existing.done_segments < existing.segments) existing.stage = "gemini";
        await putJSON(env, `videos/${id}/status.json`, existing);
        return j({ id, mode: "gemini", segments: existing.segments, resumed: true, extended: true });
      }
    }
    if (existing.stage === "gemini")
      return j({ id, mode: "gemini", segments: existing.segments, resumed: true });
    return j({ id, cues: existing.cues, resumed: true });
  }

  // 沒手貼原料:先試抓字幕軌;YouTube 擋 IP 就退 Gemini 看片(路線B,需片長)
  let source = "manual";
  if (!body.ko_json3 && !body.en_vtt) {
    let got = null;
    try { got = await fetchCaptions(id); } catch (e) { got = { err: String(e.message || e) }; }
    if (got && (got.ko_json3 || got.en_vtt)) {
      body.ko_json3 = got.ko_json3 || undefined;
      body.en_vtt = got.en_vtt || undefined;
      body.title = body.title || got.title;
      source = `auto(${got.tracks.join(",")})`;
    } else {
      // 路線B:Gemini 直接看片。片長:使用者填的優先,否則用 countTokens 自動探測
      let duration_s = +body.duration_min > 0 ? Math.round(+body.duration_min * 60) : 0;
      if (!duration_s) {
        try { duration_s = await geminiProbeDuration(id, env); }
        catch (e) {
          return j({ error: `抓不到字幕軌(${got.err || "無可用軌"}),片長自動探測也失敗(${e.message})。請填「片長(分鐘)」或手動貼上 json3/vtt。` }, 422);
        }
      }
      const segments = Math.ceil(duration_s / GEMINI_SEG_S);
      await putJSON(env, `videos/${id}/meta.json`, {
        id, url: `https://www.youtube.com/watch?v=${id}`,
        title: body.title || (await fetchTitle(id)) || id,
        created: new Date().toISOString(), source: "gemini-video",
      });
      await putJSON(env, `videos/${id}/status.json`, {
        stage: "gemini", duration_s, segments, done_segments: 0, cues: 0, seg_s: GEMINI_SEG_S,
        open: !(+body.duration_min > 0), // 片長是估的 → 開放式掃描,掃到影片結尾為止
      });
      return j({ id, mode: "gemini", segments });
    }
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

async function loadGlossary(env) {
  try {
    const r = await env.ASSETS.fetch("http://assets/glossary.json");
    if (r.ok) return await r.text();
  } catch (e) {}
  return "[]";
}

async function geminiTranslate(env, cues, context) {
  const glossary = await loadGlossary(env);
  const prompt = `你是韓國綜藝字幕譯者。把每個 cue 翻成台灣正體中文。
譯名表(強制鎖定,出現就必須用表內譯名):${glossary}
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
  const index = ((await getJSON(env, "index.json")) || []).filter(v => v.id !== id);
  index.push({ id, title: meta.title, url: meta.url, cues: cues.length, created: meta.created });
  await putJSON(env, "index.json", index);
  status.stage = "done";
  await putJSON(env, `videos/${id}/status.json`, status);
  return j({ id, stage: "done", cues: cues.length });
}

async function getStatus(id, env) {
  const s = await getJSON(env, `videos/${id}/status.json`);
  return s ? j(s) : j({ error: "unknown video" }, 404);
}

// ---------- 路線B:Gemini 直接看片(轉錄+字卡+翻譯,按段) ----------
const GEMINI_SEG_S = 180; // 3 分鐘一段:6 分鐘會讓單次呼叫超時(524)

// 用 countTokens 免費探測片長:影片 token 率約 300/秒(預設解析度)
async function geminiProbeDuration(id, env) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:countTokens?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contents: [{ parts: [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } }] }],
      }),
    });
  if (!r.ok) throw new Error(`countTokens ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const total = (await r.json()).totalTokens;
  if (!total || total < 300) throw new Error(`totalTokens=${total} 異常`);
  return Math.ceil(total / 300);
}

async function geminiNextSegment(id, env) {
  const status = await getJSON(env, `videos/${id}/status.json`);
  if (!status) return j({ error: "unknown video" }, 404);
  if (status.stage === "done") return j({ ...status, note: "already done" });
  if (status.stage !== "gemini") return j({ error: `stage=${status.stage},非 Gemini 路線` }, 400);

  const n = status.done_segments;
  const SEG = GEMINI_SEG_S; // 一律 3 分鐘;舊任務從 covered_s 接續,不受舊段距影響
  const startS = status.covered_s ?? n * (status.seg_s || 360);
  const endS = status.open ? startS + SEG : Math.min(startS + SEG, status.duration_s);
  const glossary = await loadGlossary(env);
  const prompt = `你是韓國綜藝字幕譯者兼轉錄員,處理影片 ${startS} 秒到 ${endS} 秒這一段。
譯名表(強制鎖定):${glossary}
任務:
1. 聽出所有韓語對話,依語意斷句成 cue(kind="speech",ko=韓文原文)。
2. 讀出畫面上出現的韓綜字卡/效果字(kind="card",ko=畫面原文;背景雜訊文字不要)。
3. 每個 cue 給台灣正體中文翻譯 zh:綜藝口語、台灣用詞(禁止:視頻/質量/網絡/信息/軟件/屏幕),每行不超過 20 個全形字,過長在語意邊界用\n斷行(最多兩行),沒把握的句尾加⚠。
輸出 JSON 陣列(只輸出 JSON):
[{"start":絕對秒數,"end":絕對秒數,"kind":"speech","ko":"...","zh":"..."}]
start/end 必須是整部影片的絕對時間(此段從 ${startS} 秒開始),數字,單調遞增。
若此時間段已超出影片實際結尾(影片比預估短),只輸出空陣列 []。`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` },
              videoMetadata: { startOffset: `${startS}s`, endOffset: `${endS}s` },
            },
            { text: prompt },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 32768 },
      }),
    });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const raw = (await r.json()).candidates[0].content.parts[0].text;
  let cues;
  try { cues = JSON.parse(raw); }
  catch (e) {
    // 輸出被截斷:砍到最後一個完整物件自救
    const cut = raw.lastIndexOf("}");
    if (cut < 0) throw new Error("Gemini 回傳非 JSON: " + raw.slice(0, 120));
    cues = JSON.parse(raw.slice(0, cut + 1) + "]");
  }
  if (!Array.isArray(cues)) throw new Error("Gemini 回傳非陣列");
  cues = cues
    .filter(c => c && c.zh && isFinite(+c.start) && isFinite(+c.end))
    .map(c => ({
      start: Math.max(startS, +(+c.start).toFixed(2)),
      end: Math.min(endS + 2, +(+c.end).toFixed(2)),
      kind: c.kind === "card" ? "card" : "speech",
      ko: c.ko || "", zh: String(c.zh).trim(),
    }));
  await putJSON(env, `videos/${id}/gemini/seg_${String(n).padStart(2, "0")}.json`, cues);

  status.done_segments = n + 1;
  // 進度以秒計:輸出被截斷時從最後一句結尾接續,不漏內容
  status.covered_s = cues.length ? Math.min(endS, Math.max(startS + 10, +cues[cues.length - 1].end)) : endS;

  const CAP = 60; // open 模式上限(3 小時),防失控
  const ended = status.open
    ? (cues.length === 0 || status.done_segments >= CAP)
    : status.covered_s >= status.duration_s;
  if (!ended) {
    status.segments = status.open
      ? status.done_segments + 1
      : status.done_segments + Math.ceil((status.duration_s - status.covered_s) / SEG);
  }

  if (ended) {
    status.segments = status.done_segments;
    const all = [];
    for (let i = 0; i < status.segments; i++) {
      const seg = await getJSON(env, `videos/${id}/gemini/seg_${String(i).padStart(2, "0")}.json`);
      if (seg) all.push(...seg);
    }
    all.sort((a, b) => a.start - b.start);
    const out = all.map((c, i) => ({ id: i, en: "", ...c }));
    await putJSON(env, `videos/${id}/cues.json`, out);
    const meta = await getJSON(env, `videos/${id}/meta.json`);
    const index = ((await getJSON(env, "index.json")) || []).filter(v => v.id !== id);
    index.push({ id, title: meta.title, url: meta.url, cues: out.length, created: meta.created });
    await putJSON(env, "index.json", index);
    status.stage = "done";
    status.cues = out.length;
  }
  await putJSON(env, `videos/${id}/status.json`, status);
  return j(status);
}

// ---------- 自動抓 YouTube 字幕軌(innertube player API) ----------
async function fetchTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`);
    if (r.ok) return (await r.json()).title || null;
  } catch (e) {}
  return null;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 依序嘗試多個 innertube client:datacenter IP 常被 WEB client 丟
// LOGIN_REQUIRED bot check,但 TV 內嵌/行動 client 的檢查寬鬆許多。
const YT_CLIENTS = [
  {
    label: "tv_embedded",
    ua: UA,
    body: {
      context: {
        client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en" },
        thirdParty: { embedUrl: "https://www.youtube.com/" },
      },
    },
  },
  {
    label: "android",
    ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
    body: {
      context: {
        client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 34, hl: "en" },
      },
    },
  },
  {
    label: "ios",
    ua: "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_0 like Mac OS X)",
    body: {
      context: {
        client: { clientName: "IOS", clientVersion: "19.09.3", deviceModel: "iPhone14,3", hl: "en" },
      },
    },
  },
  {
    label: "web",
    ua: UA,
    body: { context: { client: { clientName: "WEB", clientVersion: "2.20260701.00.00", hl: "en" } } },
  },
];

async function fetchCaptions(id) {
  const attempts = [];
  let d = null;
  for (const c of YT_CLIENTS) {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": c.ua, "origin": "https://www.youtube.com" },
      body: JSON.stringify({ videoId: id, ...c.body }),
    });
    if (!r.ok) { attempts.push(`${c.label}:http${r.status}`); continue; }
    const res = await r.json();
    const ps = res.playabilityStatus?.status;
    const hasTracks = res.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length;
    if (hasTracks) { d = res; attempts.push(`${c.label}:OK`); break; }
    attempts.push(`${c.label}:${ps || "no-captions"}`);
  }
  if (!d)
    throw new Error(`各 client 都抓不到字幕軌(${attempts.join(", ")})——YouTube 擋了 Cloudflare IP 或影片無字幕,請手動貼上 json3/vtt`);
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ytpoc admin</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2a3040;--fg:#e8eaf0;--dim:#8b93a5;--acc:#ffd54a;--ok:#7ec97e;--err:#ff7a7a}
  *{box-sizing:border-box}
  body{font-family:"Noto Sans TC",sans-serif;max-width:720px;margin:2em auto;background:var(--bg);color:var(--fg);padding:0 16px}
  h2{margin:0 0 4px}.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
  input,textarea{width:100%;margin:.3em 0;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:.6em .8em;font-size:14px}
  textarea{font-family:monospace;font-size:12px}
  button{cursor:pointer;background:var(--acc);color:#1a1a1a;border:0;border-radius:8px;padding:.6em 1.6em;font-size:14px;font-weight:700;margin-top:.4em}
  button:disabled{opacity:.45;cursor:wait}
  #status{display:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:14px 0}
  #stageLine{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px}
  #stageLine b{color:var(--acc)}
  .bar{height:8px;background:#0a0c10;border-radius:4px;overflow:hidden}
  #fill{height:100%;width:0%;background:var(--acc);transition:width .5s}
  #log{margin-top:14px;font-size:13px;line-height:1.7}
  #log div{border-left:3px solid var(--line);padding:2px 10px;margin:3px 0}
  #log .ok{border-color:var(--ok)} #log .err{border-color:var(--err);color:var(--err);white-space:pre-wrap}
  #log .t{color:var(--dim);font-size:11px;margin-right:8px}
  a{color:var(--acc)}
</style>
<h2>ytpoc 個人版 admin</h2>
<div class="sub">貼 YouTube 連結 → 自動抓字幕軌;被擋就填片長走 Gemini 看片;再不行手貼原料。已存在的影片會自動續跑。</div>
<input id="url" placeholder="YouTube 連結(必填)">
<input id="title" placeholder="標題(選填)">
<input id="dur" placeholder="片長(分鐘)——抓軌失敗走 Gemini 看片時必填">
<textarea id="json3" rows="2" placeholder="(選填)ko json3——留空自動抓"></textarea>
<textarea id="vtt" rows="2" placeholder="(選填)en vtt——留空自動抓;有人工英文字幕品質最佳"></textarea>
<button id="btn" onclick="run()">▶ 建立 / 續跑</button>
<div id="status">
  <div id="stageLine"><span>影片 <b id="svid">-</b></span><span id="sstage">-</span><span id="sprog">-</span></div>
  <div class="bar"><div id="fill"></div></div>
</div>
<div id="log"></div>
<script>
const $ = id => document.getElementById(id);
function log(m, cls){
  const d = document.createElement('div'); if (cls) d.className = cls;
  d.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>';
  d.append(m); $('log').prepend(d);
}
async function api(path, opts){
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({error:'HTTP ' + r.status}));
  if (!r.ok) throw new Error(d.error || JSON.stringify(d));
  return d;
}
let pollTimer = null;
function renderStatus(id, s){
  $('status').style.display = 'block';
  $('svid').textContent = id;
  $('sstage').textContent = {aligned:'已對齊,待翻譯', translating:'翻譯中', translated:'翻譯完,待合併', gemini:'Gemini 看片中', done:'✅ 完成'}[s.stage] || s.stage;
  const total = s.segments || s.batches || 1;
  const done = s.stage === 'done' ? total : (s.done_segments ?? s.done_batches ?? 0);
  $('sprog').textContent = done + '/' + total;
  $('fill').style.width = Math.round(100 * done / total) + '%';
}
function startPoll(id){
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const s = await api('/admin/videos/' + id + '/status');
      renderStatus(id, s);
      if (s.stage === 'done') stopPoll();
    } catch (e) {}
  }, 2500);
}
function stopPoll(){ if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function run(){
  const btn = $('btn'); btn.disabled = true; btn.textContent = '⏳ 執行中…';
  log('送出任務…');
  try {
    const body = { url: $('url').value, title: $('title').value, duration_min: $('dur').value || undefined,
      ko_json3: $('json3').value || undefined, en_vtt: $('vtt').value || undefined };
    const v = await api('/admin/videos', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    log('✅ 已受理:' + v.id + (v.resumed ? '(續跑既有進度)' : v.mode === 'gemini' ? '(Gemini 看片,' + v.segments + ' 段)' : '(' + v.cues + ' cues)'), 'ok');
    startPoll(v.id);
    let s = await api('/admin/videos/' + v.id + '/status');
    renderStatus(v.id, s);
    async function step(path){
      for (let i = 0; i < 3; i++) {
        try { return await api(path, {method:'POST'}); }
        catch (e) { if (i === 2) throw e; log('⚠ ' + e.message.slice(0, 80) + ' → 自動重試 ' + (i+1) + '/2'); }
      }
    }
    if (v.mode === 'gemini' || s.stage === 'gemini') {
      while (s.stage !== 'done') { s = await step('/admin/videos/' + v.id + '/gemini'); renderStatus(v.id, s); }
    } else if (s.stage !== 'done') {
      while (s.done_batches < s.batches) { s = await step('/admin/videos/' + v.id + '/translate'); renderStatus(v.id, s); }
      s = await api('/admin/videos/' + v.id + '/finalize', {method:'POST'});
      renderStatus(v.id, s);
    }
    stopPoll();
    const a = document.createElement('a'); a.href = '/?v=' + v.id; a.target = '_blank'; a.textContent = '/?v=' + v.id;
    const wrap = document.createElement('span'); wrap.append('🎉 完成,開啟播放頁:', a);
    log(wrap, 'ok');
  } catch (e) {
    log('❌ ' + e.message + '(可直接再按一次續跑)', 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ 建立 / 續跑';
  }
}
</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
