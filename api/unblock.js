// 解灰 API：从第三方音源获取可播放的音频链接
// 用于网易云音乐中因版权下架无法播放的歌曲
// 音源顺序：酷狗 -> QQ音乐 -> 酷我 -> 咪咕 -> B站音频 -> (fallback: 更多关键词变体重试)
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
  // Keyword variants — substantially raises hit rate on 3rd-party APIs.
  // Original search API only queries one combination ("artist title").
  // Chinese music search endpoints are *very* sensitive to ordering,
  // separators, and presence of bracketed qualifiers (live/version/acoustic).
  // =================================================================
  const clean = (s) => String(s || '')
    .replace(/\s+/g, ' ')
    // remove (live) / (Live版) / 伴奏 / 电影《xxx》插曲 / DJ版
    .replace(/\([^)]*(?:Live|现场|版|伴奏|Remix|Acoustic|Demo|Instrument)[^)]*\)/gi, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cName = clean(name);
  const cArtist = clean(artist);
  const variants = [];
  // Order matters — most natural first.
  if (cArtist) {
    variants.push(`${cArtist} ${cName}`);               // 陈奕迅 十年
    variants.push(`${cArtist}-${cName}`);               // 陈奕迅-十年
    variants.push(`${cArtist} - ${cName}`);             // 陈奕迅 - 十年
    variants.push(`${cName} ${cArtist}`);               // 十年 陈奕迅 (酷狗/酷我另一个常中)
    variants.push(`${cArtist}《${cName}》`);             // 陈奕迅《十年》
    variants.push(`${cArtist} -  ${cName}`.replace(/  +/, ' '));
  }
  variants.push(cName);                                 // 十年
  if (cName !== name) variants.push(String(name).trim()); // include raw original in case strip stripped too much

  // Deduplicate while preserving order, limit to 8 realistic variants max
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

  const sources = [
    { name: 'kugou',  fn: tryKugou },
    { name: 'qq',     fn: tryQQ },
    { name: 'kuwo',   fn: tryKuwo },
    { name: 'migu',   fn: tryMigu },
    { name: 'bilibili', fn: tryBilibiliAudio },
    { name: 'youtube (invidious)', fn: tryInvidious },
  ];

  for (const src of sources) {
    for (const kw of keywords) {
      try {
        const result = await src.fn(kw, ua, cName, cArtist);
        if (result && result.url) {
          const url = String(result.url).replace(/^http:/, 'https:');
          return res.json({
            code: 200,
            url,
            source: result.source || src.name,
            songName: result.songName || cName,
            singerName: result.singerName || cArtist,
          });
        }
      } catch (err) {
        // swallow per-(source, keyword) error and move on.
        // Function-level catch keeps the loop live.
      }
    }
  }

  return res.json({
    code: 200,
    url: null,
    source: null,
    msg: '所有音源均无法获取播放链接',
  });
};

// ============ 酷狗音乐 ============
async function tryKugou(keyword, ua) {
  const searchUrl = `https://mobiles.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(
    keyword
  )}&pagesize=8&page=1`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': ua } });
  const searchData = await searchResp.json();

  if (!searchData || !searchData.data || !searchData.data.info || searchData.data.info.length === 0) {
    return null;
  }

  for (const song of searchData.data.info) {
    const hash = song.hash;
    const albumAudioId = song.album_audio_id;
    try {
      const playUrlA = `https://www.kugou.com/yy/index.php?r=play/getdata&hash=${encodeURIComponent(hash)}&album_audio_id=${encodeURIComponent(albumAudioId)}`;
      const playRespA = await fetch(playUrlA, {
        headers: { 'User-Agent': ua, Referer: `https://www.kugou.com/song/hash/${encodeURIComponent(hash)}` },
      });
      const playDataA = await playRespA.json();
      if (playDataA?.data?.play_url) {
        return { url: playDataA.data.play_url, source: 'kugou', songName: song.songname, singerName: song.singername };
      }
    } catch (e) {}
    try {
      const playUrlB = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
      const playRespB = await fetch(playUrlB, { headers: { 'User-Agent': ua } });
      const playDataB = await playRespB.json();
      if (playDataB?.url) {
        return { url: playDataB.url, source: 'kugou', songName: song.songname, singerName: song.singername };
      }
    } catch (e) {}
  }
  return null;
}

// ============ QQ 音乐 ============
async function tryQQ(keyword, ua) {
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${encodeURIComponent(keyword)}&format=json`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' } });
  const searchData = await searchResp.json();

  if (!searchData?.data?.song?.list?.length) return null;

  const guid = String(Math.floor(Math.random() * 1e10));
  for (const song of searchData.data.song.list) {
    const songmid = song.songmid;
    if (!songmid) continue;
    try {
      const dataObj = JSON.stringify({
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: { guid, songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
        },
      });
      const vkeyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(dataObj)}`;
      const vkeyResp = await fetch(vkeyUrl, { headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' } });
      const vkeyData = await vkeyResp.json();
      const purl = vkeyData?.req_0?.data?.midurlinfo?.[0]?.purl;
      if (purl) {
        const sip = (vkeyData?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/').replace(/^http:/, 'https:');
        return {
          url: `${sip}${purl}`,
          source: 'qq',
          songName: song.songname,
          singerName: song.singer?.[0]?.name || '',
        };
      }
    } catch (e) {}
  }
  return null;
}

// ============ 酷我音乐 ============
async function tryKuwo(keyword, ua) {
  // 酷我 API 反爬虫：必须先访问首页拿合法 kw_token/csrf 对，
  // 并在 cookie+header 一起带。之前的静态 'kw'+random token 在 Vercel 海外节点直接
  // 403。这里先 GET 首页拿 set-cookie 里的真实 kw_token 再用。
  try {
    const homeResp = await fetch('https://www.kuwo.cn/', {
      headers: { 'User-Agent': ua },
      redirect: 'follow',
    });
    let token = '';
    const cookies = (homeResp.headers && homeResp.headers.get && homeResp.headers.get('set-cookie')) || '';
    const m = cookies.match(/kw_token=([^;]+)/);
    if (m) token = m[1];
    if (!token) {
      // fallback: use the returned Response cookie jar value; otherwise generate.
      token = 'KW_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    const baseHeaders = {
      'User-Agent': ua,
      Referer: 'https://www.kuwo.cn/',
      csrf: token,
      Cookie: `kw_token=${token}`,
    };
    const searchUrl = `https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=${encodeURIComponent(keyword)}&pn=1&rn=8&httpsStatus=1`;
    const searchResp = await fetch(searchUrl, { headers: { ...baseHeaders, Referer: `https://www.kuwo.cn/search/list?key=${encodeURIComponent(keyword)}` } });
    const searchData = await searchResp.json();

    if (!searchData?.data?.list?.length) return null;

    for (const song of searchData.data.list) {
      const rid = song.rid;
      if (!rid) continue;
      try {
        // Prefer 320k mp3 first, fallback to 128k.  The FLAC endpoint is
        // VIP-locked on Kuwo.
        for (const br of ['320kmp3', '128kmp3']) {
          const playUrl = `https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${encodeURIComponent(rid)}&type=convert_url3&br=${br}&httpsStatus=1`;
          const playResp = await fetch(playUrl, { headers: { ...baseHeaders, Referer: `https://www.kuwo.cn/play_detail/${encodeURIComponent(rid)}` } });
          const playData = await playResp.json();
          if (playData?.data?.url) {
            return { url: playData.data.url, source: 'kuwo', songName: song.name, singerName: song.artist };
          }
        }
      } catch (e) {}
    }
  } catch (_) { return null; }
  return null;
}

// ============ 咪咕音乐 ============
async function tryMigu(keyword, ua) {
  // 新咪咕 endpoint 2024+：旧 scr_search_tag 302 到首页。改用
  // music.migu.cn/v4 的搜索 JSON endpoint。
  try {
    const searchUrl = `https://music.migu.cn/v3/api/music/audioPlayer/getSongs?pageNum=1&pageSize=8&searchKey=${encodeURIComponent(keyword)}`;
    const searchResp = await fetch(searchUrl, {
      headers: {
        'User-Agent': ua,
        Referer: 'https://music.migu.cn/v3/search',
        channel: '0146951',
        origin: 'https://music.migu.cn',
      },
    });
    const searchData = await searchResp.json();
    const list = searchData?.songs || searchData?.data?.items || searchData?.data?.songs || [];
    if (!list.length) {
      // Fallback to H5 search endpoint
      const h5 = `https://m.music.migu.cn/music-info/v1/search?keyword=${encodeURIComponent(keyword)}&pageNo=1&pageSize=8&searchType=SONG`;
      const hr = await fetch(h5, { headers: { 'User-Agent': ua, Referer: 'https://m.music.migu.cn/' } });
      const hd = await hr.json();
      for (const k of ['songs', 'data.items', 'data.songs', 'data.data.items']) {
        const parts = k.split('.');
        let cur = hd;
        for (const p of parts) { cur = cur?.[p]; if (!cur) break; }
        if (Array.isArray(cur) && cur.length) { list.push(...cur.slice(0, 8)); break; }
      }
    }
    if (!list.length) return null;

    for (const song of list.slice(0, 5)) {
      const direct = song.listenUrl || song.mp3 || song.url || song.hqUrl || song.lqUrl || song.audioUrl;
      if (direct && /^https?:\/\//i.test(direct)) {
        return { url: direct, source: 'migu', songName: song.songName || song.name, singerName: song.singer || song.artistName };
      }
      const copyrightId = song.copyrightId || song.cid || song.id || song.songId;
      if (!copyrightId) continue;
      try {
        const toneFlags = ['HQ', 'PQ', 'Standard'];
        for (const toneFlag of toneFlags) {
          const playUrl = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?toneFlag=${toneFlag}&formatType=mp3&channel=0&from=3&netType=01&loginFlag=0&contentId=${encodeURIComponent(copyrightId)}`;
          const playResp = await fetch(playUrl, { headers: { 'User-Agent': ua, Referer: 'https://music.migu.cn/' } });
          const playData = await playResp.json();
          const u = playData?.data?.listenUrl || playData?.url || playData?.data?.url;
          if (u) return { url: u, source: 'migu', songName: song.songName || song.name, singerName: song.singer || song.artistName };
        }
      } catch (e) {}
    }
  } catch (_) { return null; }
  return null;
}

// ============ B 站音频 (Bilibili Audio / geci 音乐) ============
// Bilibili's audio search is *extremely* tolerant of Chinese variants,
// and uploaded audio files of HK/TW pop classics (陈奕迅/周杰伦/孙燕姿)
// are almost always user-uploaded on Bilibili audio community.
async function tryBilibiliAudio(keyword, ua) {
  // B站从2025年起对无登录会话境外IP做412风控。为了提升成功率，
  // 1) 先 GET 一下 audio 首页拿到 buvid3 cookie
  // 2) 带 buvid3 去搜索 & 拉流。
  try {
    let buvid = '';
    try {
      const home = await fetch('https://www.bilibili.com/audio/home', {
        headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        redirect: 'follow',
      });
      const sc = (home.headers && home.headers.get && home.headers.get('set-cookie')) || '';
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

    const searchUrl = `https://api.bilibili.com/audio/music-service-c/s?search_type=music&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=8`;
    const searchResp = await fetch(searchUrl, { headers: hdrs });
    const searchData = await searchResp.json();
    const candidates = [];
    if (searchData?.data?.result?.song?.list?.length) {
      candidates.push(...searchData.data.result.song.list.slice(0, 8));
    }
    // Fallback: bili main search for type=audio
    if (candidates.length === 0) {
      try {
        const altUrl = `https://api.bilibili.com/x/web-interface/search/type?search_type=music&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=8`;
        const altResp = await fetch(altUrl, { headers: { ...hdrs, Referer: 'https://search.bilibili.com/' } });
        const altData = await altResp.json();
        if (altData?.data?.result?.length) {
          for (const x of altData.data.result.slice(0, 8)) {
            if (x.sid || x.id) candidates.push({ id: x.sid || x.id, title: x.title, uname: x.author });
          }
        }
      } catch (_) {}
    }

    for (const s of candidates) {
      const sid = s.sid || s.song_id || s.id;
      if (!sid) continue;
      try {
        const playUrl = `https://api.bilibili.com/audio/music-service-c/songs/playing?song_id=${encodeURIComponent(sid)}&part=1`;
        const playResp = await fetch(playUrl, { headers: { ...hdrs, Referer: `https://www.bilibili.com/audio/song${sid}` } });
        const playData = await playResp.json();
        const dl =
          playData?.data?.cdns?.[0] ||
          playData?.data?.new_cdns?.[0] ||
          playData?.data?.newCdnList?.[0] ||
          playData?.data?.playUrl ||
          playData?.data?.url;
        if (dl) {
          const title = s.title || s.name || s.song_name;
          const singer = s.uname || s.artist || s.author || s.upName;
          return { url: dl, source: 'bilibili', songName: title, singerName: singer };
        }
      } catch (e) {}
    }
  } catch (e) { return null; }
  return null;
}

// ============ YouTube / Invidious 兜底 ==================================
// Invidious is a community-run FOSS YouTube frontend mirror network.
// Audio-only DASH URLs extracted from Invidious `/api/v1/videos/:id` are
// real, globally-reachable Google video/audio CDN URLs, which makes this
// the final safety net for any song search for which every Chinese music
// platform above is paywall'd.
const INVIDIOUS_MIRRORS = [
  'https://inv.zzls.xyz',
  'https://inv.tux.pizza',
  'https://invidious.jing.rocks',
  'https://yt.artemislena.eu',
  'https://invidious.perennialte.ch',
];
async function tryInvidious(keyword, ua) {
  const q = encodeURIComponent(keyword + ' audio');
  for (const base of INVIDIOUS_MIRRORS) {
    try {
      const search = `${base}/api/v1/search?q=${q}&type=video`;
      const sr = await fetch(search, {
        headers: { 'User-Agent': ua, Accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      });
      if (!sr.ok) continue;
      const list = await sr.json();
      if (!Array.isArray(list) || list.length === 0) continue;
      // Prefer ~3-6 min videos (typical full songs).
      const scored = list
        .filter(v => typeof v.lengthSeconds === 'number')
        .sort((a, b) => {
          const scoreA = Math.abs(a.lengthSeconds - 240); // 4 min is ideal
          const scoreB = Math.abs(b.lengthSeconds - 240);
          return scoreA - scoreB;
        });
      const top = scored.length ? scored[0] : list[0];
      const id = top.videoId;
      if (!id) continue;
      const meta = `${base}/api/v1/videos/${encodeURIComponent(id)}`;
      const mr = await fetch(meta, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
      if (!mr.ok) continue;
      const md = await mr.json();
      const formats = md.adaptiveFormats || [];
      // Pick highest-bitrate audio-only m4a.
      let best = null;
      for (const f of formats) {
        if (String(f.type || f.container || '').startsWith('audio')) {
          if (!best || Number(f.bitrate || 0) > Number(best.bitrate || 0)) best = f;
        }
      }
      if (!best) continue;
      const url = best.url || best.streamingData;
      if (url && /^https?:\/\//i.test(url)) {
        return { url, source: 'invidious', songName: md.title || top.title, singerName: md.author || top.author };
      }
    } catch (_) {
      // try next mirror
    }
  }
  return null;
}

