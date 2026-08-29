import request from '@/utils/request';
import { mapTrackPlayableStatus } from '@/utils/common';
import { isAccountLoggedIn } from '@/utils/auth';
import { getTrackDetail } from '@/api/track';

/**
 * 获取歌手单曲
 * 说明 : 调用此接口 , 传入歌手 id, 可获得歌手部分信息和热门歌曲
 * @param {number} id - 歌手 id, 可由搜索接口获得
 */
export function getArtist(id) {
  return request({
    url: '/artists',
    method: 'get',
    params: {
      id,
      timestamp: new Date().getTime(),
    },
  }).then(async data => {
    // ================================================================
    // Avoid the /song/detail long-URL Cloudflare truncation bug.
    // ----------------------------------------------------------------
    // When NOT logged in, the original code did:
    //   getTrackDetail(data.hotSongs.map(t=>t.id).join(','))
    // which builds a querystring of 50 ids (~200+ chars each) → a
    // 2000–4000 byte URL that Cloudflare/CDN edge closes mid-flight
    // (ERR_CONNECTION_CLOSED).  The `/artists` endpoint already
    // returns the full hotSongs payload with ar/al/dt/name/pop —
    // we don't need a second /song/detail round-trip.  Skip the
    // fetch entirely and just mark playback status in-place.
    // ================================================================
    if (!Array.isArray(data.hotSongs)) data.hotSongs = [];
    try {
      data.hotSongs = mapTrackPlayableStatus(data.hotSongs);
    } catch (e) {
      // If mapping fails for any reason, fall back to the raw list so
      // the user at least sees 50 songs (some playable, some greyed).
    }
    return data;
  });
}

/**
 * 获取歌手专辑
 * 说明 : 调用此接口 , 传入歌手 id, 可获得歌手专辑内容
 * - id: 歌手 id
 * - limit: 取出数量 , 默认为 50
 * - offset: 偏移数量 , 用于分页 , 如 :( 页数 -1)*50, 其中 50 为 limit 的值 , 默认为 0
 * @param {Object} params
 * @param {number} params.id
 * @param {number=} params.limit
 * @param {number=} params.offset
 */
export function getArtistAlbum(params) {
  return request({
    url: '/artist/album',
    method: 'get',
    params,
  });
}

/**
 * 歌手榜
 * 说明 : 调用此接口 , 可获取排行榜中的歌手榜
 * - type : 地区
 * 1: 华语
 * 2: 欧美
 * 3: 韩国
 * 4: 日本
 * @param {number=} type
 */
export function toplistOfArtists(type = null) {
  let params = {};
  if (type) {
    params.type = type;
  }
  return request({
    url: '/toplist/artist',
    method: 'get',
    params,
  });
}
/**
 * 获取歌手 mv
 * 说明 : 调用此接口 , 传入歌手 id, 可获得歌手 mv 信息 , 具体 mv 播放地址可调 用/mv传入此接口获得的 mvid 来拿到 , 如 : /artist/mv?id=6452,/mv?mvid=5461064
 * @param {number} params.id 歌手 id, 可由搜索接口获得
 * @param {number} params.offset
 * @param {number} params.limit
 */
export function artistMv(params) {
  return request({
    url: '/artist/mv',
    method: 'get',
    params,
  });
}

/**
 * 收藏歌手
 * 说明 : 调用此接口 , 传入歌手 id, 可收藏歌手
 * - id: 歌手 id
 * - t: 操作,1 为收藏,其他为取消收藏
 * @param {Object} params
 * @param {number} params.id
 * @param {number} params.t
 */
export function followAArtist(params) {
  // Mutation → POST body + keep query params (cookie/realIP injection).
  return request({
    url: '/artist/sub',
    method: 'post',
    data: params,
    params,
  });
}

/**
 * 相似歌手
 * 说明 : 调用此接口 , 传入歌手 id, 可获得相似歌手
 * - id: 歌手 id
 * @param {number} id
 */
export function similarArtists(id) {
  // Idempotent read — kept as POST for historical compatibility with the
  // NCM upstream module (both methods work).  Use POST body + query so
  // cookie/realIP injection keeps flowing.
  const payload = { id };
  return request({
    url: '/simi/artist',
    method: 'post',
    data: payload,
    params: payload,
  });
}
