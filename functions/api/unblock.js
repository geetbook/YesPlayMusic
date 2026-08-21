// Cloudflare Pages Function: /api/unblock — 解灰 API
// Path: /api/unblock
// 音源顺序：酷狗 -> QQ音乐 -> 酷我 -> 咪咕
// 与 api/unblock.js（Vercel）逻辑一致，但使用 Fetch API（Cloudflare Workers 标准）

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-NCM-Cookie',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const name = url.searchParams.get('name');
  const artist = url.searchParams.get('artist') || '';
  if (!name) {
    return json({ code: 400, msg: '缺少歌曲名 name 参数' }, 400);
  }
  const keyword = artist ? `${artist} ${name}` : name;

  const sources = [tryKugou, tryQQ, tryKuwo, tryMigu];
  for (const source of sources) {
    try {
      const r = await source(keyword);
      if (r && r.url) {
        return json({
          code: 200,
          url: r.url,
          source: r.source,
          songName: r.songName,
          singerName: r.singerName,
        });
      }
    } catch (e) {
      // 继续下一个音源
    }
  }

  return json({
    code: 200,
    url: null,
    source: null,
    msg: '所有音源均无法获取播放链接',
  });
}

// ============ 酷狗音乐 ============
async function tryKugou(keyword) {
  const searchUrl = `https://mobiles.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(
    keyword
  )}&pagesize=5&page=1`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
  const searchData = await searchResp.json();
  if (
    !searchData ||
    !searchData.data ||
    !searchData.data.info ||
    !searchData.data.info.length
  ) {
    return null;
  }
  for (const song of searchData.data.info) {
    const hash = song.hash;
    const albumAudioId = song.album_audio_id || '';
    try {
      const playRespA = await fetch(
        `https://www.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&album_audio_id=${albumAudioId}`,
        {
          headers: {
            'User-Agent': UA,
            Referer: `https://www.kugou.com/song/hash/${hash}`,
          },
        }
      );
      const playDataA = await playRespA.json();
      if (playDataA && playDataA.data && playDataA.data.play_url) {
        return {
          url: playDataA.data.play_url.replace(/^http:/, 'https:'),
          source: 'kugou',
          songName: song.songname,
          singerName: song.singername,
        };
      }
    } catch (e) {}
    try {
      const playRespB = await fetch(
        `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`,
        { headers: { 'User-Agent': UA } }
      );
      const playDataB = await playRespB.json();
      if (playDataB && playDataB.url) {
        return {
          url: playDataB.url.replace(/^http:/, 'https:'),
          source: 'kugou',
          songName: song.songname,
          singerName: song.singername,
        };
      }
    } catch (e) {}
  }
  return null;
}

// ============ QQ 音乐 ============
async function tryQQ(keyword) {
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=${encodeURIComponent(
    keyword
  )}&format=json`;
  const searchResp = await fetch(searchUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
  });
  const searchData = await searchResp.json();
  if (
    !searchData ||
    !searchData.data ||
    !searchData.data.song ||
    !searchData.data.song.list ||
    !searchData.data.song.list.length
  ) {
    return null;
  }
  const guid = '10000';
  for (const song of searchData.data.song.list) {
    const songmid = song.songmid;
    try {
      const vkeyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(
        JSON.stringify({
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
        })
      )}`;
      const vkeyResp = await fetch(vkeyUrl, {
        headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
      });
      const vkeyData = await vkeyResp.json();
      if (
        vkeyData &&
        vkeyData.req_0 &&
        vkeyData.req_0.data &&
        vkeyData.req_0.data.midurlinfo &&
        vkeyData.req_0.data.midurlinfo[0] &&
        vkeyData.req_0.data.midurlinfo[0].purl
      ) {
        const purl = vkeyData.req_0.data.midurlinfo[0].purl;
        const sip =
          (vkeyData.req_0.data.sip &&
            vkeyData.req_0.data.sip[0] &&
            vkeyData.req_0.data.sip[0].replace(/^http:/, 'https:')) ||
          'https://dl.stream.qqmusic.qq.com/';
        return {
          url: `${sip}${purl}`,
          source: 'qq',
          songName: song.songname,
          singerName: song.singer ? song.singer[0].name : '',
        };
      }
    } catch (e) {}
  }
  return null;
}

// ============ 酷我音乐 ============
async function tryKuwo(keyword) {
  const searchUrl = `https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=${encodeURIComponent(
    keyword
  )}&pn=1&rn=5&httpsStatus=1`;
  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.kuwo.cn/search/list?key=' + encodeURIComponent(keyword),
      csrf: 'abcdefgh',
      Cookie: 'kw_token=abcdefgh',
    },
  });
  const searchData = await searchResp.json();
  if (
    !searchData ||
    !searchData.data ||
    !searchData.data.list ||
    !searchData.data.list.length
  ) {
    return null;
  }
  for (const song of searchData.data.list) {
    const rid = song.rid;
    try {
      const playResp = await fetch(
        `https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${rid}&type=music&br=320kflac&httpsStatus=1`,
        {
          headers: {
            'User-Agent': UA,
            Referer: 'https://www.kuwo.cn/play_detail/' + rid,
            csrf: 'abcdefgh',
            Cookie: 'kw_token=abcdefgh',
          },
        }
      );
      const playData = await playResp.json();
      if (playData && playData.data && playData.data.url) {
        return {
          url: playData.data.url.replace(/^http:/, 'https:'),
          source: 'kuwo',
          songName: song.name,
          singerName: song.artist,
        };
      }
    } catch (e) {}
  }
  return null;
}

// ============ 咪咕音乐 ============
async function tryMigu(keyword) {
  const searchUrl = `https://m.music.migu.cn/migu/remoting/scr_search_tag?keyword=${encodeURIComponent(
    keyword
  )}&type=2&rows=5&pgc=1`;
  const searchResp = await fetch(searchUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://m.music.migu.cn/' },
  });
  const searchData = await searchResp.json();
  if (!searchData || !searchData.musics || !searchData.musics.length) {
    return null;
  }
  for (const song of searchData.musics) {
    const contentId = song.copyrightId || song.id;
    try {
      const playResp = await fetch(
        `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?toneFlag=Standard&formatType=mp3&channel=0&from=3&netType=01&loginFlag=0&contentId=${contentId}`,
        { headers: { 'User-Agent': UA, Referer: 'https://m.music.migu.cn/' } }
      );
      const playData = await playResp.json();
      if (playData && playData.data && playData.data.listenUrl) {
        return {
          url: playData.data.listenUrl.replace(/^http:/, 'https:'),
          source: 'migu',
          songName: song.songName,
          singerName: song.singer,
        };
      }
    } catch (e) {}
  }
  return null;
}
