import store from '@/store';
import request from '@/utils/request';
import { mapTrackPlayableStatus } from '@/utils/common';
import {
  cacheTrackDetail,
  getTrackDetailFromCache,
  cacheLyric,
  getLyricFromCache,
} from '@/utils/db';

// =================================================================
// Batching helpers — neutralise the Cloudflare URL-truncation bug.
// -----------------------------------------------------------------
// Original YesPlayMusic code everywhere does:
//   getTrackDetail([id1,id2,...,id50].join(','))
// which produces a ~3000 byte query string that Cloudflare/edge
// proxies truncate mid-flight (ERR_CONNECTION_CLOSED).  The same
// applies to /song/url for long id lists.
//
// The fix lives here (at the SDK/call level) so every 8 callers
// (artist.vue / album.vue / playlist.vue / next.vue / search.vue /
// searchType.vue / TrackList.vue / actions.js) benefit automatically
// with zero code changes.  Any call passing > 20 ids is:
//   1) split into chunks of CHUNK_SIZE each
//   2) sent as POST with ids[] in the BODY (not URL)  <- no length limit
//   3) per-chunk responses merged into one songs[] / privileges[]
// =================================================================
const CHUNK_SIZE = 50; // NCM server accepts up to 1000 per call; 50 keeps memory light.
function _toIdArray(ids) {
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  return String(ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function _fetchSongDetailChunk(idsChunk) {
  // Use POST (body payload) for any chunk so long lists never overflow
  // the URL.  For single-chunk small lists (<=10 items) we still use
  // GET so behaviour is unchanged for short requests.
  if (idsChunk.length <= 10) {
    return request({
      url: '/song/detail',
      method: 'get',
      params: { ids: idsChunk.join(',') },
    });
  }
  return request({
    url: '/song/detail',
    method: 'post',
    data: { ids: idsChunk.join(',') },
  });
}
async function _fetchSongUrlChunk(idsChunk, extraParams = {}) {
  if (idsChunk.length <= 10) {
    return request({
      url: '/song/url',
      method: 'get',
      params: { id: idsChunk.join(','), ...extraParams },
    });
  }
  return request({
    url: '/song/url',
    method: 'post',
    data: { id: idsChunk.join(','), ...extraParams },
  });
}

/**
 * 获取音乐 url
 * 说明 : 使用歌单详情接口后 , 能得到的音乐的 id, 但不能得到的音乐 url, 调用此接口, 传入的音乐 id( 可多个 , 用逗号隔开 ), 可以获取对应的音乐的 url,
 * !!!未登录状态返回试听片段(返回字段包含被截取的正常歌曲的开始时间和结束时间)
 * @param {string} id - 音乐的 id，例如 id=405998841,33894312
 */
export function getMP3(id) {
  const getBr = () => {
    // 当返回的 quality >= 400000时，就会优先返回 hi-res
    const quality = store.state.settings?.musicQuality ?? '320000';
    return quality === 'flac' ? '350000' : quality;
  };
  const idsArr = _toIdArray(id);
  if (idsArr.length === 0) {
    return Promise.resolve({ code: 200, data: [] });
  }
  const extraParams = { br: getBr() };
  const chunks = _chunk(idsArr, CHUNK_SIZE);
  return Promise.all(chunks.map(c => _fetchSongUrlChunk(c, extraParams))).then(results => {
    const merged = { code: 200, data: [] };
    for (const r of results) {
      if (r) merged.code = r.code ?? merged.code;
      if (r?.data && Array.isArray(r.data)) merged.data.push(...r.data);
    }
    return merged;
  });
}

/**
 * 获取歌曲详情
 * 说明 : 调用此接口 , 传入音乐 id(支持多个 id, 用 , 隔开), 可获得歌曲详情(注意:歌曲封面现在需要通过专辑内容接口获取)
 * @param {string} ids - 音乐 id, 例如 ids=405998841,33894312
 */
export function getTrackDetail(ids) {
  const idsArr = _toIdArray(ids);
  if (idsArr.length === 0) {
    return Promise.resolve({ code: 200, songs: [], privileges: [] });
  }

  const fetchLatest = () => {
    const chunks = _chunk(idsArr, CHUNK_SIZE);
    return Promise.all(chunks.map(c => _fetchSongDetailChunk(c)))
      .then(responses => {
        const songs = [];
        const privileges = [];
        for (const r of responses) {
          if (r?.songs && Array.isArray(r.songs)) songs.push(...r.songs);
          if (r?.privileges && Array.isArray(r.privileges)) privileges.push(...r.privileges);
        }
        // cache every song+priv pair using the bulk utility
        for (const song of songs) {
          const priv = privileges.find(t => t.id === song.id);
          cacheTrackDetail(song, priv);
        }
        const mappedSongs = mapTrackPlayableStatus(songs, privileges);
        return { code: 200, songs: mappedSongs, privileges };
      });
  };

  // Kick off a background refresh so cache stays warm even when we
  // return from cache below.
  fetchLatest().catch(() => { /* swallow — cache result is acceptable */ });

  return getTrackDetailFromCache(idsArr).then(result => {
    if (result) {
      result.songs = mapTrackPlayableStatus(result.songs, result.privileges);
      return result;
    }
    return fetchLatest();
  });
}

/**
 * 获取歌词
 * 说明 : 调用此接口 , 传入音乐 id 可获得对应音乐的歌词 ( 不需要登录 )
 * @param {number} id - 音乐 id
 */
export function getLyric(id) {
  const fetchLatest = () => {
    return request({
      url: '/lyric',
      method: 'get',
      params: {
        id,
      },
    }).then(result => {
      cacheLyric(id, result);
      return result;
    });
  };

  fetchLatest();

  return getLyricFromCache(id).then(result => {
    return result ?? fetchLatest();
  });
}

/**
 * 获取云盘歌曲内嵌歌词 * 说明 : 调用此接口 , 传入音乐 id 可获得云盘歌曲的内嵌歌词
 * @param {number} songId - 音乐 id
 * @param {number} userId - 用户 id
 */
export function getCloudLyric(songId, userId) {
  const fetchLatest = () => {
    return request({
      url: '/api',
      method: 'get',
      params: {
        uri: `/api/cloud/lyric/get`,
        data: {
          songId,
          userId,
          lv: '-1',
          kv: '-1',
        },
        crypto: 'eapi',
      },
    }).then(result => {
      cacheLyric(songId, result);
      return result;
    });
  };

  fetchLatest();

  return getLyricFromCache(songId).then(result => {
    return result ?? fetchLatest();
  });
}

/**
 * 新歌速递
 * 说明 : 调用此接口 , 可获取新歌速递
 * @param {number} type - 地区类型 id, 对应以下: 全部:0 华语:7 欧美:96 日本:8 韩国:16
 */
export function topSong(type) {
  return request({
    url: '/top/song',
    method: 'get',
    params: {
      type,
    },
  });
}

/**
 * 喜欢音乐
 * 说明 : 调用此接口 , 传入音乐 id, 可喜欢该音乐
 * - id - 歌曲 id
 * - like - 默认为 true 即喜欢 , 若传 false, 则取消喜欢
 * @param {Object} params
 * @param {number} params.id
 * @param {boolean=} [params.like]
 */
export function likeATrack(params) {
  params.timestamp = new Date().getTime();
  // POST instead of GET:
  //   Cloudflare Worker Basic Auth front-end historically returns 405 for
  //   non-GET verbs that hit the auth layer; the earlier fix also made the
  //   /like endpoint POST-based in the playlist/playlist files.  Sending as
  //   POST body also sidesteps URL length limits (not relevant here but
  //   consistent with other mutations).
  return request({
    url: '/like',
    method: 'post',
    data: params,
  });
}

/**
 * 听歌打卡
 * 说明 : 调用此接口 , 传入音乐 id, 来源 id，歌曲时间 time，更新听歌排行数据
 * - id - 歌曲 id
 * - sourceid - 歌单或专辑 id
 * - time - 歌曲播放时间,单位为秒
 * @param {Object} params
 * @param {number} params.id
 * @param {number} params.sourceid
 * @param {number=} params.time
 */
export function scrobble(params) {
  params.timestamp = new Date().getTime();
  return request({
    url: '/scrobble',
    method: 'post',
    data: params,
  });
}
