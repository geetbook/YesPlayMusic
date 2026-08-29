// 解灰 API：从第三方音源获取可播放的音频链接
// 用于网易云音乐中因版权下架无法播放的歌曲
// 性能优化（v2）：6 平台 + 多关键词 + Invidious 5 mirrors 全部并行，
// 每次请求强 2.5s 死线，命中第一个非空 URL 立即 res.json 返回，
// 把原最坏情况 6 平台×8 关键词串行≈4–8s 压到 ≈1.5–2.5s。
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { id, name, artist } = req.query;
  if (!name) {
    return res.status(400).json({ code: 400, msg: '缺少歌曲名 name 参数' });
  }

  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // =================================================================
  // Keyword variants — most platforms are *very* sensitive to the exact
  // search string.  Keep up to 8 realistic combinations, most likely first.
  // =================================================================
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/\([^)]*(?:Live|现场|版|伴奏|Remix|Acoustic|Demo|Instrument)[^)]*\)/gi, ' ')
      .replace(/【[^】]*】/g, ' ')
      .replace(/（[^）]*）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const cName = clean(name);
  const cArtist = clean(artist);
  const variants = [];
  if (cArtist) {
    variants.push(`${cArtist} ${cName}`);
    variants.push(`${cArtist}-${cName}`);
    variants.push(`${cArtist} - ${cName}`);
    variants.push(`${cName} ${cArtist}`);
    variants.push(`${cArtist}《${cName}》`);
  }
  variants.push(cName);
  if (cName !== name) variants.push(String(name).trim());

  const seen = new Set();
  const keywords = [];
  for (const v of variants) {
    const t = v.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      keywords.push(t);
      if (keywords.length >= 8) break;
    }
  }

  // =================================================================
  // Shared helpers — timeout + quick HTTP
  // =================================================================
  const REQUEST_DEADLINE_MS = 2500; // 单个第三方请求最长 2.5s
  const TOTAL_DEADLINE_MS = 4000;   // 整次解灰最长 4s（兜底保护）

  function withTimeout(promise, ms, label = 'req') {
    let timer;
    const tp = new Promise((_, rj) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timeout ${ms}`);
        err.name = 'TimeoutError';
        rj(err);
      }, ms);
    });
    return Promise.race([promise, tp]).finally(() => clearTimeout(timer));
  }

  async function qfetch(url, opts = {}) {
    let controller = null;
    let timer = null;
    const hasAbort = typeof AbortController !== 'undefined';
    if (hasAbort) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    }
    try {
      const resp = await fetch(url, {
        ...opts,
        signal: controller ? controller.signal : opts.signal,
      });
      return resp;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // =================================================================
  // Platforms — each takes (keyword, ua, cName, cArtist, timeoutMs)
  // and returns {url, source, songName, singerName} or null on miss/err.
  // =================================================================

  async function tryKugou(keyword) {
    try {
      const searchUrl = `https://mobiles.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(
        keyword
      )}&pagesize=8&page=1`;
      const searchResp = await qfetch(searchUrl, { headers: { 'User-Agent': ua } });
      if (!searchResp.ok) return null;
      const searchData = await searchResp.json();
      const list = searchData?.data?.info;
      if (!Array.isArray(list) || list.length === 0) return null;

      for (const song of list.slice(0, 4)) {
        const hash = song.hash;
        const albumAudioId = song.album_audio_id;
        if (!hash) continue;
        // 两个酷狗接口并行，先回且有 URL 的就拿
        try {
          const pA = (async () => {
            try {
              const u = `https://www.kugou.com/yy/index.php?r=play/getdata&hash=${encodeURIComponent(
                hash
              )}&album_audio_id=${encodeURIComponent(albumAudioId || '')}`;
              const r = await qfetch(u, {
                headers: {
                  'User-Agent': ua,
                  Referer: `https://www.kugou.com/song/hash/${encodeURIComponent(hash)}`,
                },
              });
              if (!r.ok) return null;
              const d = await r.json();
              return d?.data?.play_url || null;
            } catch (_) { return null; }
          })();
          const pB = (async () => {
            try {
              const u = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(
                hash
              )}`;
              const r = await qfetch(u, { headers: { 'User-Agent': ua } });
              if (!r.ok) return null;
              const d = await r.json();
              return d?.url || null;
            } catch (_) { return null; }
          })();
          const [urlA, urlB] = await Promise.all([pA, pB]);
          const url = urlA || urlB;
          if (url) {
            return {
              url: String(url).replace(/^http:/, 'https:'),
              source: 'kugou',
              songName: song.songname || cName,
              singerName: song.singername || cArtist,
            };
          }
        } catch (_) { /* next song */ }
      }
    } catch (_) { /* swallow */ }
    return null;
  }

  async function tryQQ(keyword) {
    try {
      const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${encodeURIComponent(
        keyword
      )}&format=json`;
      const searchResp = await qfetch(searchUrl, {
        headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' },
      });
      if (!searchResp.ok) return null;
      const searchData = await searchResp.json();
      const list = searchData?.data?.song?.list;
      if (!Array.isArray(list) || list.length === 0) return null;

      const guid = String(Math.floor(Math.random() * 1e10));
      for (const song of list.slice(0, 4)) {
        const songmid = song.songmid;
        if (!songmid) continue;
        try {
          const dataObj = JSON.stringify({
            req_0: {
              module: 'vkey.GetVkeyServer',
              method: 'CgiGetVkey',
              param: {
                guid,
                songmid: [songmid],
                songtype: [0],
                uin: '0',
                loginflag: 1,
                platform: '20',
              },
            },
          });
          const vkeyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(dataObj)}`;
          const vkeyResp = await qfetch(vkeyUrl, {
            headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' },
          });
          if (!vkeyResp.ok) continue;
          const vkeyData = await vkeyResp.json();
          const purl = vkeyData?.req_0?.data?.midurlinfo?.[0]?.purl;
          if (purl) {
            const sip = (vkeyData?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/').replace(
              /^http:/,
              'https:'
            );
            return {
              url: `${sip}${purl}`,
              source: 'qq',
              songName: song.songname || cName,
              singerName: song.singer?.[0]?.name || cArtist,
            };
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  async function tryKuwo(keyword) {
    try {
      const homeResp = await qfetch('https://www.kuwo.cn/', {
        headers: { 'User-Agent': ua },
        redirect: 'follow',
      });
      let token = '';
      const cookies =
        (homeResp.headers && homeResp.headers.get && homeResp.headers.get('set-cookie')) || '';
      const m = cookies.match(/kw_token=([^;]+)/);
      if (m) token = m[1];
      if (!token) {
        token = 'KW_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      }
      const baseHeaders = {
        'User-Agent': ua,
        Referer: 'https://www.kuwo.cn/',
        csrf: token,
        Cookie: `kw_token=${token}`,
      };
      const searchUrl = `https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=${encodeURIComponent(
        keyword
      )}&pn=1&rn=8&httpsStatus=1`;
      const searchResp = await qfetch(searchUrl, {
        headers: {
          ...baseHeaders,
          Referer: `https://www.kuwo.cn/search/list?key=${encodeURIComponent(keyword)}`,
        },
      });
      if (!searchResp.ok) return null;
      const searchData = await searchResp.json();
      const list = searchData?.data?.list;
      if (!Array.isArray(list) || list.length === 0) return null;

      for (const song of list.slice(0, 4)) {
        const rid = song.rid;
        if (!rid) continue;
        try {
          // 320k 与 128k 并行取第一个非空
          const urls = ['320kmp3', '128kmp3'].map((br) =>
            (async () => {
              try {
                const u = `https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${encodeURIComponent(
                  rid
                )}&type=convert_url3&br=${br}&httpsStatus=1`;
                const r = await qfetch(u, {
                  headers: {
                    ...baseHeaders,
                    Referer: `https://www.kuwo.cn/play_detail/${encodeURIComponent(rid)}`,
                  },
                });
                if (!r.ok) return null;
                const d = await r.json();
                return d?.data?.url || null;
              } catch (_) { return null; }
            })()
          );
          const settled = await Promise.all(urls);
          const url = settled.find((u) => u && /^https?:\/\//i.test(u));
          if (url) {
            return {
              url: String(url).replace(/^http:/, 'https:'),
              source: 'kuwo',
              songName: song.name || cName,
              singerName: song.artist || cArtist,
            };
          }
        } catch (_) {}
      }
    } catch (_) { return null; }
    return null;
  }

  async function tryMigu(keyword) {
    try {
      const searchUrl = `https://music.migu.cn/v3/api/music/audioPlayer/getSongs?pageNum=1&pageSize=8&searchKey=${encodeURIComponent(
        keyword
      )}`;
      const pV4 = (async () => {
        try {
          const r = await qfetch(searchUrl, {
            headers: {
              'User-Agent': ua,
              Referer: 'https://music.migu.cn/v3/search',
              channel: '0146951',
              origin: 'https://music.migu.cn',
            },
          });
          if (!r.ok) return [];
          const d = await r.json();
          return d?.songs || d?.data?.items || d?.data?.songs || [];
        } catch (_) { return []; }
      })();
      const pH5 = (async () => {
        try {
          const u = `https://m.music.migu.cn/music-info/v1/search?keyword=${encodeURIComponent(
            keyword
          )}&pageNo=1&pageSize=8&searchType=SONG`;
          const r = await qfetch(u, {
            headers: { 'User-Agent': ua, Referer: 'https://m.music.migu.cn/' },
          });
          if (!r.ok) return [];
          const d = await r.json();
          for (const k of ['songs', 'data.items', 'data.songs', 'data.data.items']) {
            const parts = k.split('.');
            let cur = d;
            for (const p of parts) { cur = cur?.[p]; if (!cur) break; }
            if (Array.isArray(cur) && cur.length) return cur.slice(0, 8);
          }
          return [];
        } catch (_) { return []; }
      })();
      const [v4, h5] = await Promise.all([pV4, pH5]);
      const merged = [];
      const ids = new Set();
      for (const arr of [v4, h5]) {
        for (const s of (arr || [])) {
          const key =
            s.copyrightId || s.cid || s.id || s.songId || s.songName || s.name || null;
          if (key && !ids.has(key)) {
            ids.add(key);
            merged.push(s);
          }
        }
      }
      if (merged.length === 0) return null;

      for (const song of merged.slice(0, 5)) {
        const direct = song.listenUrl || song.mp3 || song.url || song.hqUrl || song.lqUrl || song.audioUrl;
        if (direct && /^https?:\/\//i.test(direct)) {
          return {
            url: String(direct).replace(/^http:/, 'https:'),
            source: 'migu',
            songName: song.songName || song.name || cName,
            singerName: song.singer || song.artistName || cArtist,
          };
        }
        const copyrightId = song.copyrightId || song.cid || song.id || song.songId;
        if (!copyrightId) continue;
        try {
          // 三种音质并行
          const perms = ['HQ', 'PQ', 'Standard'].map((flag) =>
            (async () => {
              try {
                const u = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?toneFlag=${flag}&formatType=mp3&channel=0&from=3&netType=01&loginFlag=0&contentId=${encodeURIComponent(
                  copyrightId
                )}`;
                const r = await qfetch(u, {
                  headers: { 'User-Agent': ua, Referer: 'https://music.migu.cn/' },
                });
                if (!r.ok) return null;
                const d = await r.json();
                return d?.data?.listenUrl || d?.url || d?.data?.url || null;
              } catch (_) { return null; }
            })()
          );
          const results = await Promise.all(perms);
          const url = results.find((u) => u && /^https?:\/\//i.test(u));
          if (url) {
            return {
              url: String(url).replace(/^http:/, 'https:'),
              source: 'migu',
              songName: song.songName || song.name || cName,
              singerName: song.singer || song.artistName || cArtist,
            };
          }
        } catch (_) {}
      }
    } catch (_) { return null; }
    return null;
  }

  async function tryBilibiliAudio(keyword) {
    try {
      let buvid = '';
      try {
        const home = await qfetch('https://www.bilibili.com/audio/home', {
          headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9' },
          redirect: 'follow',
        });
        const sc =
          (home.headers && home.headers.get && home.headers.get('set-cookie')) || '';
        const mm = sc.match(/buvid3=([^;]+)/);
        if (mm) buvid = mm[1];
      } catch (_) {}
      const jar = buvid ? `buvid3=${buvid};` : '';
      const hdrs = {
        'User-Agent': ua,
        Referer: 'https://www.bilibili.com/audio/home',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };
      if (jar) hdrs.Cookie = jar;

      // 两个搜索端并行
      const p1 = (async () => {
        try {
          const u = `https://api.bilibili.com/audio/music-service-c/s?search_type=music&keyword=${encodeURIComponent(
            keyword
          )}&page=1&pagesize=8`;
          const r = await qfetch(u, { headers: hdrs });
          if (!r.ok) return [];
          const d = await r.json();
          return d?.data?.result?.song?.list?.slice(0, 8) || [];
        } catch (_) { return []; }
      })();
      const p2 = (async () => {
        try {
          const u = `https://api.bilibili.com/x/web-interface/search/type?search_type=music&keyword=${encodeURIComponent(
            keyword
          )}&page=1&pagesize=8`;
          const r = await qfetch(u, {
            headers: { ...hdrs, Referer: 'https://search.bilibili.com/' },
          });
          if (!r.ok) return [];
          const d = await r.json();
          const arr = [];
          for (const x of d?.data?.result || []) {
            if (x.sid || x.id) {
              arr.push({ id: x.sid || x.id, title: x.title, uname: x.author });
            }
          }
          return arr;
        } catch (_) { return []; }
      })();
      const [list1, list2] = await Promise.all([p1, p2]);
      const candidates = [...list1, ...list2].slice(0, 8);
      if (candidates.length === 0) return null;

      for (const s of candidates) {
        const sid = s.sid || s.song_id || s.id;
        if (!sid) continue;
        try {
          const u = `https://api.bilibili.com/audio/music-service-c/songs/playing?song_id=${encodeURIComponent(
            sid
          )}&part=1`;
          const r = await qfetch(u, {
            headers: {
              ...hdrs,
              Referer: `https://www.bilibili.com/audio/song${sid}`,
            },
          });
          if (!r.ok) continue;
          const d = await r.json();
          const dl =
            d?.data?.cdns?.[0] ||
            d?.data?.new_cdns?.[0] ||
            d?.data?.newCdnList?.[0] ||
            d?.data?.playUrl ||
            d?.data?.url;
          if (dl) {
            return {
              url: String(dl).replace(/^http:/, 'https:'),
              source: 'bilibili',
              songName: s.title || s.name || s.song_name || cName,
              singerName: s.uname || s.artist || s.author || s.upName || cArtist,
            };
          }
        } catch (_) {}
      }
    } catch (_) { return null; }
    return null;
  }

  // Invidious: 5 mirrors Promise.race + 每镜像搜索→拉详情 4s 死线
  const INVIDIOUS_MIRRORS = [
    'https://inv.zzls.xyz',
    'https://inv.tux.pizza',
    'https://invidious.jing.rocks',
    'https://yt.artemislena.eu',
    'https://invidious.perennialte.ch',
  ];
  async function tryInvidious(keyword) {
    const q = encodeURIComponent(keyword + ' audio');
    // 并行 5 mirrors × (搜索→取详情)
    const races = INVIDIOUS_MIRRORS.map((base) =>
      (async () => {
        try {
          const search = `${base}/api/v1/search?q=${q}&type=video`;
          const sr = await qfetch(search, {
            headers: { 'User-Agent': ua, Accept: 'application/json' },
          });
          if (!sr.ok) return null;
          const list = await sr.json();
          if (!Array.isArray(list) || list.length === 0) return null;
          // 4 分钟左右优先
          let top = null;
          const scored = list
            .filter((v) => typeof v.lengthSeconds === 'number')
            .sort(
              (a, b) => Math.abs(a.lengthSeconds - 240) - Math.abs(b.lengthSeconds - 240)
            );
          top = scored.length ? scored[0] : list[0];
          const videoId = top.videoId;
          if (!videoId) return null;
          const metaUrl = `${base}/api/v1/videos/${encodeURIComponent(videoId)}`;
          const mr = await qfetch(metaUrl, {
            headers: { 'User-Agent': ua, Accept: 'application/json' },
          });
          if (!mr.ok) return null;
          const md = await mr.json();
          const formats = md.adaptiveFormats || [];
          let best = null;
          for (const f of formats) {
            if (String(f.type || f.container || '').startsWith('audio')) {
              if (!best || Number(f.bitrate || 0) > Number(best.bitrate || 0)) best = f;
            }
          }
          if (!best) return null;
          const url = best.url || best.streamingData;
          if (url && /^https?:\/\//i.test(url)) {
            return {
              url,
              source: 'invidious',
              songName: md.title || top.title || cName,
              singerName: md.author || top.author || cArtist,
            };
          }
          return null;
        } catch (_) { return null; }
      })()
    );
    // 返回第一个非 null 的结果
    return new Promise((resolve) => {
      let done = false;
      let remaining = races.length;
      races.forEach((p) => {
        p.then((r) => {
          if (done) return;
          if (r && r.url) {
            done = true;
            resolve(r);
            return;
          }
          remaining -= 1;
          if (remaining === 0 && !done) resolve(null);
        }).catch(() => {
          remaining -= 1;
          if (remaining === 0 && !done) resolve(null);
        });
      });
      // 4s 内没任何 mirror 回就整体放弃
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, REQUEST_DEADLINE_MS + 1500);
    });
  }

  // =================================================================
  // Dispatcher — all platforms × their keywords → Promise.all,
  // return first non-empty URL.
  // =================================================================
  const platformFns = [
    { name: 'kugou',    fn: tryKugou,     kws: keywords.slice(0, 4) }, // 4 keyword 变体
    { name: 'qq',       fn: tryQQ,        kws: keywords.slice(0, 4) },
    { name: 'kuwo',     fn: tryKuwo,      kws: keywords.slice(0, 4) },
    { name: 'migu',     fn: tryMigu,      kws: keywords.slice(0, 4) },
    { name: 'bilibili', fn: tryBilibiliAudio, kws: keywords.slice(0, 4) },
    { name: 'invidious',fn: tryInvidious, kws: keywords.slice(0, 3) }, // YouTube 通常不用那么多 kw
  ];

  // 对每个平台：用 Promise.any 语义（关键词里第一个有结果的就回）
  function runPlatform({ name, fn, kws }) {
    return new Promise((resolve) => {
      let finished = 0;
      let settled = 0;
      const jobs = kws.map((kw) =>
        withTimeout(fn(kw), REQUEST_DEADLINE_MS, `${name}:${kw}`)
          .then((r) => {
            settled++;
            if (r && r.url && !finished) {
              finished = 1;
              resolve(r);
            } else if (settled === kws.length && !finished) {
              resolve(null);
            }
          })
          .catch(() => {
            settled++;
            if (settled === kws.length && !finished) resolve(null);
          })
      );
      // 平台级死线：3.5s（包含多关键词）
      setTimeout(() => { if (!finished) { finished = 1; resolve(null); } }, REQUEST_DEADLINE_MS + 1000);
    });
  }

  // 全部平台并行，只要其中一个返回 {url} 就立即写响应
  const finalResult = await withTimeout(
    new Promise((resolve) => {
      let done = false;
      let remaining = platformFns.length;
      for (const p of platformFns) {
        runPlatform(p)
          .then((r) => {
            if (done) return;
            if (r && r.url) {
              done = true;
              resolve(r);
              return;
            }
            remaining -= 1;
            if (remaining === 0 && !done) resolve(null);
          })
          .catch(() => {
            remaining -= 1;
            if (remaining === 0 && !done) resolve(null);
          });
      }
    }),
    TOTAL_DEADLINE_MS,
    'unblock-total'
  ).catch(() => null);

  if (finalResult && finalResult.url) {
    const url = String(finalResult.url).replace(/^http:/, 'https:');
    return res.json({
      code: 200,
      url,
      source: finalResult.source || 'unknown',
      songName: finalResult.songName || cName,
      singerName: finalResult.singerName || cArtist,
    });
  }

  return res.json({
    code: 200,
    url: null,
    source: null,
    msg: '所有音源均无法获取播放链接',
  });
};
