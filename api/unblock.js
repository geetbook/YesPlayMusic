// 解灰 API：从第三方音源获取可播放的音频链接
// 用于网易云音乐中因版权下架无法播放的歌曲
// 音源顺序：酷狗 -> QQ音乐 -> 酷我 -> 咪咕
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

  const keyword = artist ? `${artist} ${name}` : name;
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // 依次尝试各个音源，返回第一个成功的结果
  const sources = [tryKugou, tryQQ, tryKuwo, tryMigu];
  for (const source of sources) {
    try {
      const result = await source(keyword, ua, name, artist);
      if (result && result.url) {
        return res.json({
          code: 200,
          url: result.url,
          source: result.source,
          songName: result.songName,
          singerName: result.singerName,
        });
      }
    } catch (err) {
      console.error(`[unblock][${source.name}] failed:`, err.message);
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
  // 1. 搜索歌曲（取多个结果逐一尝试，付费歌曲会跳过）
  const searchUrl = `https://mobiles.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(
    keyword
  )}&pagesize=5&page=1`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': ua } });
  const searchData = await searchResp.json();

  if (
    !searchData ||
    !searchData.data ||
    !searchData.data.info ||
    searchData.data.info.length === 0
  ) {
    return null;
  }

  // 2. 遍历搜索结果，尝试获取可播放链接
  for (const song of searchData.data.info) {
    const hash = song.hash;
    const albumAudioId = song.album_audio_id;

    // 接口 A: www.kugou.com play/getdata
    try {
      const playUrlA = `https://www.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&album_audio_id=${albumAudioId}`;
      const playRespA = await fetch(playUrlA, {
        headers: {
          'User-Agent': ua,
          Referer: `https://www.kugou.com/song/hash/${hash}`,
        },
      });
      const playDataA = await playRespA.json();
      if (playDataA && playDataA.data && playDataA.data.play_url) {
        return {
          url: playDataA.data.play_url.replace(/^http:/, 'https:'),
          source: 'kugou',
          songName: song.songname,
          singerName: song.singername,
        };
      }
    } catch (e) {
      // 忽略单条错误，继续尝试下一个
    }

    // 接口 B: m.kugou.com playInfo
    try {
      const playUrlB = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
      const playRespB = await fetch(playUrlB, {
        headers: { 'User-Agent': ua },
      });
      const playDataB = await playRespB.json();
      if (playDataB && playDataB.url) {
        return {
          url: playDataB.url.replace(/^http:/, 'https:'),
          source: 'kugou',
          songName: song.songname,
          singerName: song.singername,
        };
      }
    } catch (e) {
      // 忽略单条错误，继续尝试下一个
    }
  }

  return null;
}

// ============ QQ 音乐 ============
async function tryQQ(keyword, ua, songName, artist) {
  // 1. 搜索歌曲（取多个结果逐一尝试，付费歌曲 purl 为空会跳过）
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=${encodeURIComponent(
    keyword
  )}&format=json`;
  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': ua,
      Referer: 'https://y.qq.com/',
    },
  });
  const searchData = await searchResp.json();

  if (
    !searchData ||
    !searchData.data ||
    !searchData.data.song ||
    !searchData.data.song.list ||
    searchData.data.song.list.length === 0
  ) {
    return null;
  }

  const guid = '10000';

  // 2. 遍历搜索结果，尝试获取可播放链接
  for (const song of searchData.data.song.list) {
    const songmid = song.songmid;
    try {
      // 获取播放链接 vkey
      const vkeyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=%7B%22req_0%22%3A%7B%22module%22%3A%22vkey.GetVkeyServer%22%2C%22method%22%3A%22CgiGetVkey%22%2C%22param%22%3A%7B%22guid%22%3A%22${guid}%22%2C%22songmid%22%3A%5B%22${songmid}%22%5D%2C%22songtype%22%3A%5B0%5D%2C%22uin%22%3A%220%22%2C%22loginflag%22%3A1%2C%22platform%22%3A%2220%22%7D%7D%7D`;
      const vkeyResp = await fetch(vkeyUrl, {
        headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' },
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
    } catch (e) {
      // 忽略单条错误，继续尝试下一个
    }
  }

  return null;
}

// ============ 酷我音乐 ============
async function tryKuwo(keyword, ua) {
  // 1. 搜索歌曲（取多个结果逐一尝试）
  const searchUrl = `https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=${encodeURIComponent(
    keyword
  )}&pn=1&rn=5&httpsStatus=1`;
  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': ua,
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
    searchData.data.list.length === 0
  ) {
    return null;
  }

  // 2. 遍历搜索结果，尝试获取可播放链接
  for (const song of searchData.data.list) {
    const rid = song.rid;
    try {
      const playUrl = `https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${rid}&type=music&br=320kflac&httpsStatus=1`;
      const playResp = await fetch(playUrl, {
        headers: {
          'User-Agent': ua,
          Referer: 'https://www.kuwo.cn/play_detail/' + rid,
          csrf: 'abcdefgh',
          Cookie: 'kw_token=abcdefgh',
        },
      });
      const playData = await playResp.json();

      if (playData && playData.data && playData.data.url) {
        return {
          url: playData.data.url.replace(/^http:/, 'https:'),
          source: 'kuwo',
          songName: song.name,
          singerName: song.artist,
        };
      }
    } catch (e) {
      // 忽略单条错误，继续尝试下一个
    }
  }

  return null;
}

// ============ 咪咕音乐 ============
async function tryMigu(keyword, ua) {
  // 1. 搜索歌曲
  const searchUrl = `https://m.music.migu.cn/migu/remoting/scr_search_tag?keyword=${encodeURIComponent(
    keyword
  )}&type=2&rows=1&pgc=1`;
  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': ua,
      Referer: 'https://m.music.migu.cn/',
    },
  });
  const searchData = await searchResp.json();

  if (!searchData || !searchData.musics || searchData.musics.length === 0) {
    return null;
  }

  const song = searchData.musics[0];
  const contentId = song.copyrightId || song.id;

  // 2. 获取播放链接
  const playUrl = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?toneFlag=Standard&formatType=mp3&channel=0&from=3&netType=01&loginFlag=0&contentId=${contentId}`;
  const playResp = await fetch(playUrl, {
    headers: {
      'User-Agent': ua,
      Referer: 'https://m.music.migu.cn/',
    },
  });
  const playData = await playResp.json();

  if (
    playData &&
    playData.data &&
    playData.data.listenUrl
  ) {
    return {
      url: playData.data.listenUrl.replace(/^http:/, 'https:'),
      source: 'migu',
      songName: song.songName,
      singerName: song.singer,
    };
  }

  return null;
}
