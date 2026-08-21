// 解灰 API：从酷狗音乐获取可播放的音频链接
// 用于网易云音乐中因版权下架无法播放的歌曲
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

  try {
    // 1. 在酷狗音乐搜索歌曲
    const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(keyword)}&pagesize=1&page=1`;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();

    if (
      !searchData ||
      !searchData.data ||
      !searchData.data.info ||
      searchData.data.info.length === 0
    ) {
      return res.json({ code: 200, url: null, source: null, msg: '未找到匹配歌曲' });
    }

    const song = searchData.data.info[0];
    const hash = song.hash;

    // 2. 获取播放链接
    const playUrl = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
    const playResp = await fetch(playUrl);
    const playData = await playResp.json();

    if (playData && playData.url) {
      // 转换为 https
      const url = playData.url.replace(/^http:/, 'https:');
      return res.json({
        code: 200,
        url: url,
        source: 'kugou',
        songName: song.songname,
        singerName: song.singername,
      });
    }

    // 3. 尝试备用接口
    const backupUrl = `http://www.kugou.com/yy/index.php?r=play/getdata&hash=${hash}`;
    const backupResp = await fetch(backupUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const backupData = await backupResp.json();

    if (backupData && backupData.data && backupData.data.play_url) {
      const url = backupData.data.play_url.replace(/^http:/, 'https:');
      return res.json({
        code: 200,
        url: url,
        source: 'kugou',
        songName: song.songname,
        singerName: song.singername,
      });
    }

    return res.json({ code: 200, url: null, source: null, msg: '无法获取播放链接' });
  } catch (err) {
    return res.json({ code: 200, url: null, source: null, msg: err.message });
  }
};
