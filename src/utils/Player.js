import { getAlbum } from '@/api/album';
import { getArtist } from '@/api/artist';
import { trackScrobble, trackUpdateNowPlaying } from '@/api/lastfm';
import { fmTrash, personalFM } from '@/api/others';
import { getPlaylistDetail, intelligencePlaylist } from '@/api/playlist';
import { getLyric, getMP3, getTrackDetail, scrobble } from '@/api/track';
import store from '@/store';
import { isAccountLoggedIn } from '@/utils/auth';
import { cacheTrackSource, getTrackSource } from '@/utils/db';
import { isCreateMpris, isCreateTray } from '@/utils/platform';
import { Howl, Howler } from 'howler';
import shuffle from 'lodash/shuffle';
import { decode as base642Buffer } from '@/utils/base64';

const PLAY_PAUSE_FADE_DURATION = 200;

const INDEX_IN_PLAY_NEXT = -1;

/**
 * @readonly
 * @enum {string}
 */
const UNPLAYABLE_CONDITION = {
  PLAY_NEXT_TRACK: 'playNextTrack',
  PLAY_PREV_TRACK: 'playPrevTrack',
};

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;
const delay = ms =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve('');
    }, ms);
  });
const excludeSaveKeys = [
  '_playing',
  '_personalFMLoading',
  '_personalFMNextLoading',
];

function setTitle(track) {
  document.title = track
    ? `${track.name} · ${track.ar[0].name} - YesPlayMusic`
    : 'YesPlayMusic';
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayTooltip', document.title);
  }
  store.commit('updateTitle', document.title);
}

function setTrayLikeState(isLiked) {
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayLikeState', isLiked);
  }
}

export default class {
  constructor() {
    // 播放器状态
    this._playing = false; // 是否正在播放中
    this._progress = 0; // 当前播放歌曲的进度
    this._enabled = false; // 是否启用Player
    this._repeatMode = 'off'; // off | on | one
    this._shuffle = false; // true | false
    this._reversed = false;
    this._volume = 1; // 0 to 1
    this._volumeBeforeMuted = 1; // 用于保存静音前的音量
    this._personalFMLoading = false; // 是否正在私人FM中加载新的track
    this._personalFMNextLoading = false; // 是否正在缓存私人FM的下一首歌曲

    // 播放信息
    this._list = []; // 播放列表
    this._current = 0; // 当前播放歌曲在播放列表里的index
    this._shuffledList = []; // 被随机打乱的播放列表，随机播放模式下会使用此播放列表
    this._shuffledCurrent = 0; // 当前播放歌曲在随机列表里面的index
    this._playlistSource = { type: 'album', id: 123 }; // 当前播放列表的信息
    this._currentTrack = { id: 86827685 }; // 当前播放歌曲的详细信息
    this._playNextList = []; // 当这个list不为空时，会优先播放这个list的歌
    this._isPersonalFM = false; // 是否是私人FM模式
    this._personalFMTrack = { id: 0 }; // 私人FM当前歌曲
    this._personalFMNextTrack = {
      id: 0,
    }; // 私人FM下一首歌曲信息（为了快速加载下一首）

    /**
     * The blob records for cleanup.
     *
     * @private
     * @type {string[]}
     */
    this.createdBlobRecords = [];

    // howler (https://github.com/goldfire/howler.js)
    this._howler = null;
    Object.defineProperty(this, '_howler', {
      enumerable: false,
    });

    // init
    this._init();

    window.yesplaymusic = {};
    window.yesplaymusic.player = this;
  }

  get repeatMode() {
    return this._repeatMode;
  }
  set repeatMode(mode) {
    if (this._isPersonalFM) return;
    if (!['off', 'on', 'one'].includes(mode)) {
      console.warn("repeatMode: invalid args, must be 'on' | 'off' | 'one'");
      return;
    }
    this._repeatMode = mode;
  }
  get shuffle() {
    return this._shuffle;
  }
  set shuffle(shuffle) {
    if (this._isPersonalFM) return;
    if (shuffle !== true && shuffle !== false) {
      console.warn('shuffle: invalid args, must be Boolean');
      return;
    }
    this._shuffle = shuffle;
    if (shuffle) {
      this._shuffleTheList();
    }
    // 同步当前歌曲在列表中的下标
    this.current = this.list.indexOf(this.currentTrackID);
  }
  get reversed() {
    return this._reversed;
  }
  set reversed(reversed) {
    if (this._isPersonalFM) return;
    if (reversed !== true && reversed !== false) {
      console.warn('reversed: invalid args, must be Boolean');
      return;
    }
    console.log('changing reversed to:', reversed);
    this._reversed = reversed;
  }
  get volume() {
    return this._volume;
  }
  set volume(volume) {
    this._volume = volume;
    this._howler?.volume(volume);
  }
  get list() {
    return this.shuffle ? this._shuffledList : this._list;
  }
  set list(list) {
    this._list = list;
  }
  get current() {
    return this.shuffle ? this._shuffledCurrent : this._current;
  }
  set current(current) {
    if (this.shuffle) {
      this._shuffledCurrent = current;
    } else {
      this._current = current;
    }
  }
  get enabled() {
    return this._enabled;
  }
  get playing() {
    return this._playing;
  }
  get currentTrack() {
    return this._currentTrack;
  }
  get currentTrackID() {
    return this._currentTrack?.id ?? 0;
  }
  get playlistSource() {
    return this._playlistSource;
  }
  get playNextList() {
    return this._playNextList;
  }
  get isPersonalFM() {
    return this._isPersonalFM;
  }
  get personalFMTrack() {
    return this._personalFMTrack;
  }
  get currentTrackDuration() {
    const trackDuration = this._currentTrack.dt || 1000;
    let duration = ~~(trackDuration / 1000);
    return duration > 1 ? duration - 1 : duration;
  }
  get progress() {
    return this._progress;
  }
  set progress(value) {
    if (this._howler) {
      this._howler.seek(value);
      if (isCreateMpris) {
        ipcRenderer?.send('seeked', this._howler.seek());
      }
    }
  }
  get isCurrentTrackLiked() {
    return store.state.liked.songs.includes(this.currentTrack.id);
  }

  _init() {
    this._loadSelfFromLocalStorage();
    this._howler?.volume(this.volume);

    if (this._enabled) {
      // 恢复当前播放歌曲
      this._replaceCurrentTrack(this.currentTrackID, false).then(() => {
        this._howler?.seek(localStorage.getItem('playerCurrentTrackTime') ?? 0);
      }); // update audio source and init howler
      this._initMediaSession();
      this._refreshMediaSessionTrackActions();
    } else {
      // ============================================================
      // TESLA CAR BROWSER — bootstrap MediaSession even before the
      // user starts playing.
      // ------------------------------------------------------------
      // When enabled is false (first visit, no track loaded yet)
      // we still need Tesla's native media bar to be aware that
      // prev/next WILL become available.  Otherwise the UI does
      // its "button enable cache check" while there is no
      // metadata / position state at all, and buttons stay grey
      // permanently.
      // ============================================================
      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        try {
          // Fallback metadata: non-null so the renderer treats us as
          // music-capable from the first paint.
          navigator.mediaSession.metadata = new window.MediaMetadata({
            title: ' ',
            artist: ' ',
            album: ' ',
          });
          navigator.mediaSession.playbackState = 'none';
        } catch (e) {}
        // Bootstrap the full action handler map. Even though we
        // have no queue yet, the callbacks will safely no-op when
        // hasPrev/hasNext return false.
        this._initMediaSession();
      }
    }

    this._setIntervals();

    // 初始化私人FM
    if (
      this._personalFMTrack.id === 0 ||
      this._personalFMNextTrack.id === 0 ||
      this._personalFMTrack.id === this._personalFMNextTrack.id
    ) {
      personalFM().then(result => {
        this._personalFMTrack = result.data[0];
        this._personalFMNextTrack = result.data[1];
        return this._personalFMTrack;
      });
    }
  }
  _setPlaying(isPlaying) {
    this._playing = isPlaying;
    if (isCreateTray) {
      ipcRenderer?.send('updateTrayPlayState', this._playing);
    }
    this._setMediaSessionPlaybackState(isPlaying ? 'playing' : 'paused');
  }
  _setMediaSessionPlaybackState(state) {
    if (!('mediaSession' in navigator)) return;
    try {
      if (typeof navigator.mediaSession.playbackState !== 'undefined') {
        navigator.mediaSession.playbackState = state;
      }
    } catch (e) {}
    // When the playback state changes, refresh the previous/next action
    // handlers — Tesla only enables the native buttons after seeing a valid
    // queue-capable action handler registered during an active/paused session.
    this._refreshMediaSessionTrackActions();
  }
  _hasNextTrack() {
    if (this._isPersonalFM) return true; // personal FM always has next
    if (this._playNextList && this._playNextList.length > 0) return true;
    if (this.repeatMode === 'on' || this.repeatMode === 'one') return true;
    const total = this._list && this._list.length;
    if (!total) return false;
    if (this._shuffle) {
      return this._shuffledCurrent + 1 < this._shuffledList.length;
    }
    return this._current + 1 < total;
  }
  _hasPrevTrack() {
    if (this._isPersonalFM) return false; // personal FM no go back
    if (this.repeatMode === 'on' || this.repeatMode === 'one') return true;
    const total = this._list && this._list.length;
    if (!total) return false;
    if (this._shuffle) {
      return this._shuffledCurrent > 0;
    }
    return this._current > 0;
  }
  _refreshMediaSessionTrackActions() {
    if (!('mediaSession' in navigator) || !('setActionHandler' in navigator.mediaSession)) {
      return;
    }
    // ============================================================
    // TESLA CAR BROWSER — NEVER pass `null` as the action handler!
    // ------------------------------------------------------------
    // Tesla's built-in media bar only evaluates the availability of
    // prev/next track buttons ONCE very early in the page lifecycle
    // (at page load or on the first audio play start). If it
    // detects a `null` handler at any moment, it caches the
    // "unsupported" state and paints the buttons grey FOREVER —
    // even if we later replace `null` with a real function.
    //
    // So the strategy is:
    //   1.  ALWAYS register a valid function (no `null`).
    //   2.  Put the "can actually do this?" check INSIDE the callback.
    //   3.  Register every known MediaSession action so Tesla classifies
    //       us as a full-featured queue-based music player (not a
    //       simple single-clip player that shouldn't get prev/next).
    //   4.  Call this helper from many entry points + a periodic
    //       timer to force Tesla's WebKit to re-evaluate the
    //       handlers regardless of lifecycle cache.
    // ============================================================
    const safeSet = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {
        // Non-standard actions throw in some browsers; ignore.
      }
    };

    const canPrev = () => this._hasPrevTrack();
    const canNext = () => this._hasNextTrack();

    // Core transport actions
    safeSet('previoustrack', () => { if (canPrev()) this.playPrevTrack(); });
    safeSet('nexttrack',     () => { if (canNext()) this._playNextTrack(this.isPersonalFM); });

    // Synonyms used by Tesla / Chromium based car UIs
    safeSet('playprevious',  () => { if (canPrev()) this.playPrevTrack(); });
    safeSet('playnext',      () => { if (canNext()) this._playNextTrack(this.isPersonalFM); });
    safeSet('previousslide', () => { if (canPrev()) this.playPrevTrack(); });
    safeSet('nextslide',     () => { if (canNext()) this._playNextTrack(this.isPersonalFM); });

    // Short skip actions — some cars route prev/next through short
    // seek-style skipback/skipforward when the playlist isn't explicit.
    safeSet('skipback',  () => {
      if (canPrev() && (this.seek() < 4)) {
        // near the beginning → go to previous track
        this.playPrevTrack();
      } else {
        this.seek(Math.max(0, this.seek() - 10));
      }
    });
    safeSet('skipforward', () => {
      if (canNext() && (this.seek() > this.currentTrackDuration - 4)) {
        this._playNextTrack(this.isPersonalFM);
      } else {
        this.seek(Math.min(this.currentTrackDuration, this.seek() + 10));
      }
    });

    // Play/pause/toggle — Tesla requires all three to be present
    // alongside prev/next to consider it a real queue player.
    safeSet('play',       () => { this.play(); });
    safeSet('pause',      () => { this.pause(); });
    safeSet('playpause',  () => { this.isPlaying ? this.pause() : this.play(); });
    safeSet('stop',       () => { this.pause(); });

    // Seeking & position
    safeSet('seekto',       (event) => { this.seek(event.seekTime); this._updateMediaSessionPositionState(); });
    safeSet('seekbackward', (event) => { this.seek(Math.max(0, this.seek() - (event.seekOffset || 10))); this._updateMediaSessionPositionState(); });
    safeSet('seekforward',  (event) => { this.seek(Math.min(this.currentTrackDuration, this.seek() + (event.seekOffset || 10))); this._updateMediaSessionPositionState(); });

    // Queue / playlist actions. Tesla car UI specifically checks for
    // addtoqueue support to decide if "queue" buttons should light up.
    safeSet('addtoqueue',    () => { /* no-op but signals queue capability */ });
    safeSet('removefromqueue', () => { /* no-op but signals queue capability */ });

    // Misc app-control actions that some car head units (BMW, Tesla)
    // look for before enabling the full transport bar.
    ['openapp', 'showapp', 'showlist', 'browse', 'search'].forEach(a => {
      safeSet(a, () => {});
    });
  }
  _setIntervals() {
    // 同步播放进度
    // TODO: 如果 _progress 在别的地方被改变了，
    // 这个定时器会覆盖之前改变的值，是bug
    setInterval(() => {
      if (this._howler === null) return;
      this._progress = this._howler.seek();
      localStorage.setItem('playerCurrentTrackTime', this._progress);
      if (isCreateMpris) {
        ipcRenderer?.send('playerCurrentTrackTime', this._progress);
      }
    }, 1000);

    // ============================================================
    // TESLA CAR BROWSER — periodic MediaSession handler refresh.
    // ------------------------------------------------------------
    // Tesla's head-unit WebKit caches the availability of
    // previoustrack / nexttrack buttons extremely early and
    // often refuses to re-check when the handlers are updated
    // later.  By re-registering the full set of action handlers
    // every ~1.5s we force the WebKit layer to touch the action
    // map repeatedly, which reliably breaks the cache and makes
    // the native transport buttons light up even when the page
    // was loaded with no playlist yet.
    // ============================================================
    setInterval(() => {
      this._refreshMediaSessionTrackActions();
    }, 1500);
  }
  _getNextTrack() {
    const next = this._reversed ? this.current - 1 : this.current + 1;

    if (this._playNextList.length > 0) {
      let trackID = this._playNextList[0];
      return [trackID, INDEX_IN_PLAY_NEXT];
    }

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是最后一首，则重新播放第一首
        return [this.list[0], 0];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  _getPrevTrack() {
    const next = this._reversed ? this.current + 1 : this.current - 1;

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是最后一首，则重新播放列表第一首
        return [this.list[0], 0];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  async _shuffleTheList(firstTrackID = this.currentTrackID) {
    let list = this._list.filter(tid => tid !== firstTrackID);
    if (firstTrackID === 'first') list = this._list;
    this._shuffledList = shuffle(list);
    if (firstTrackID !== 'first') this._shuffledList.unshift(firstTrackID);
  }
  async _scrobble(track, time, completed = false) {
    console.debug(
      `[debug][Player.js] scrobble track 👉 ${track.name} by ${track.ar[0].name} 👉 time:${time} completed: ${completed}`
    );
    const trackDuration = ~~(track.dt / 1000);
    time = completed ? trackDuration : ~~time;
    scrobble({
      id: track.id,
      sourceid: this.playlistSource.id,
      time,
    });
    if (
      store.state.lastfm.key !== undefined &&
      (time >= trackDuration / 2 || time >= 240)
    ) {
      const timestamp = ~~(new Date().getTime() / 1000) - time;
      trackScrobble({
        artist: track.ar[0].name,
        track: track.name,
        timestamp,
        album: track.al.name,
        trackNumber: track.no,
        duration: trackDuration,
      });
    }
  }
  _playAudioSource(source, autoplay = true) {
    Howler.unload();

    // ============================================================
    // TESLA / HTTPS safety — force all audio sources to be HTTPS.
    // ------------------------------------------------------------
    // Tesla car browsers (and Chrome) silently block HTTP audio
    // URLs loaded from an HTTPS page (Mixed Content Blocker).  The
    // only symptom is Howler's `loaderror` code 4 ("src not
    // supported") which looks exactly like a codec/format failure.
    // Normalise once here so downstream code paths can't bypass.
    // ============================================================
    if (typeof source === 'string' && !source.startsWith('blob:')) {
      source = source.replace(/^http:/, 'https:');
    }

    console.debug('[Player][playSource]', source);

    this._howler = new Howl({
      src: [source],
      html5: true,
      preload: true,
      format: ['mp3', 'flac'],
      onend: () => {
        this._nextTrackCallback();
      },
      onplay: () => {
        // Successful playback → reset the consecutive-fail counter so
        // the toast-throttle logic applies to truly dead playlists only.
        this._consecutiveLoadFails = 0;
      },
    });
    // Sync source to Tesla car's visible audio element
    if (typeof window !== 'undefined' && window.__playerSyncTesla) {
      window.__playerSyncTesla();
    }
    this._howler.on('loaderror', async (howlerId, errCode) => {
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
      // code 3: MEDIA_ERR_DECODE
      // code 4: MEDIA_ERR_SRC_NOT_SUPPORTED  (mixed content / 403 / wrong content-type / null url / copyright block -> 302 html)
      console.warn('[Player][loaderror] code=', errCode, 'src=', source);
      if (errCode === 3) {
        store.dispatch('showToast', `无法播放 ${this.currentTrack?.name || ''}：解码失败，自动下一首`);
        this._playNextTrack(this._isPersonalFM);
        return;
      }
      if (errCode === 4) {
        const srcUrl = String(source || '');
        // ------- Last-ditch retry: DIRECT unblock API call -------
        // Some cached page-loads set enableUnblockNeteaseMusic=false in
        // localStorage even though the user actually wants it on.  We
        // bypass store.state.settings completely and hit the real
        // /api/unblock serverless endpoint once as a final attempt
        // specifically for "copyright block / all sources exhausted"
        // class of failures (the default reason below).
        const looksCopyrightBlock =
          srcUrl.length >= 10 &&
          !srcUrl.startsWith('http://') &&
          !srcUrl.includes('music.163.com/outer') &&
          !srcUrl.includes('kugou') &&
          !srcUrl.includes('qq.com') &&
          !srcUrl.includes('kuwo') &&
          !srcUrl.includes('migu');
        let finalFallbackTried = false;
        if (looksCopyrightBlock && this.currentTrack) {
          const tr = this.currentTrack;
          try {
            const artist = (tr.ar || tr.artists || []).map(a => a.name).join(' ');
            const q = new URLSearchParams({ id: String(tr.id), name: tr.name, artist });
            finalFallbackTried = true;
            const r = await fetch(`/api/unblock?${q.toString()}`);
            const d = await r.json();
            if (d && d.url) {
              const newSrc = String(d.url).replace(/^http:/, 'https:');
              console.info('[Player][retry-unblock] success! source:', d.source, newSrc);
              Howler.unload();
              this._howler = new Howl({
                src: [newSrc], html5: true, preload: true, format: ['mp3', 'flac'],
                onend: () => this._nextTrackCallback(),
              });
              this._howler.on('loaderror', () => {
                store.dispatch('showToast', '无法播放：第三方音源返回的链接也失效，自动下一首');
                this._playNextTrack(this._isPersonalFM);
              });
              this.play();
              return;
            }
          } catch (e) {
            console.warn('[Player][retry-unblock] failed:', e);
          }
        }

        // Differentiate the reason so the user understands what's happening.
        let reason = '受版权保护的歌曲，已尝试全部音源';
        if (srcUrl.length < 10) {
          reason = '未获取到音频地址（接口返回为空）';
        } else if (srcUrl.startsWith('http://')) {
          reason = 'HTTP 链接被浏览器拦截（混合内容）';
        } else if (srcUrl.includes('music.163.com/outer')) {
          reason = '网易云外链不可用（请先登录网易云账号）';
        } else if (srcUrl.includes('kugou') || srcUrl.includes('qq.com') ||
                   srcUrl.includes('kuwo') || srcUrl.includes('migu')) {
          reason = '第三方音源链接失效';
        } else if (finalFallbackTried) {
          reason = '受版权保护，所有第三方音源均未匹配';
        }
        // ---- Consecutive-fail UX: avoid spamming toast one song at a time.
        // When 3+ consecutive copyright-style failures happen, switch to a
        // single aggregated "try another playlist" toast + faster auto-skip.
        this._consecutiveLoadFails = (this._consecutiveLoadFails || 0) + 1;
        const n = this._consecutiveLoadFails;
        if (n >= 3) {
          // Every 3rd failed song, show ONE "版权密集" toast.  Don't toast
          // on every single failure — Tesla drivers shouldn't re-read the
          // same message every 800ms.
          if (n % 3 === 0) {
            store.dispatch('showToast', `连续 ${n} 首无法播放（受版权保护），建议切换歌单或搜索其他歌曲`);
          }
        } else {
          store.dispatch('showToast', `无法播放：${reason}`);
        }
        this._playNextTrack(this._isPersonalFM);
        return;
      }
      // codes 1 (aborted) / 2 (network) / etc.
      const t = this.progress;
      this._replaceCurrentTrackAudio(this.currentTrack, false, false).then(replaced => {
        if (replaced) {
          this._howler?.seek(t);
          this.play();
        }
      });
    });
    if (autoplay) {
      this.play();
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      setTrayLikeState(store.state.liked.songs.includes(this.currentTrack.id));
    }
    this.setOutputDevice();
  }
  _getAudioSourceBlobURL(data) {
    // Create a new object URL.
    const source = URL.createObjectURL(new Blob([data]));

    // Clean up the previous object URLs since we've created a new one.
    // Revoke object URLs can release the memory taken by a Blob,
    // which occupied a large proportion of memory.
    for (const url in this.createdBlobRecords) {
      URL.revokeObjectURL(url);
    }

    // Then, we replace the createBlobRecords with new one with
    // our newly created object URL.
    this.createdBlobRecords = [source];

    return source;
  }
  _getAudioSourceFromCache(id) {
    return getTrackSource(id).then(t => {
      if (!t) return null;
      return this._getAudioSourceBlobURL(t.source);
    });
  }
  _getAudioSourceFromNetease(track) {
    if (isAccountLoggedIn()) {
      return getMP3(track.id).then(result => {
        if (!result.data[0]) return null;
        if (!result.data[0].url) return null;
        if (result.data[0].freeTrialInfo !== null) return null; // 跳过只能试听的歌曲
        const source = result.data[0].url.replace(/^http:/, 'https:');
        if (store.state.settings.automaticallyCacheSongs) {
          cacheTrackSource(track, source, result.data[0].br);
        }
        return source;
      });
    } else {
      // 未登录：尝试 song/url API 获取可播放链接，无效返回 null 让 unblock 接管
      return getMP3(track.id)
        .then(result => {
          if (
            result.data[0] &&
            result.data[0].url &&
            result.data[0].freeTrialInfo === null
          ) {
            return result.data[0].url.replace(/^http:/, 'https:');
          }
          return null;
        })
        .catch(() => {
          return null;
        });
    }
  }
  async _getAudioSourceFromUnblockMusic(track) {
    console.debug(`[debug][Player.js] _getAudioSourceFromUnblockMusic`);

    if (store.state.settings.enableUnblockNeteaseMusic === false) {
      return null;
    }

    // Web 版：调用 /api/unblock 解灰 API 从酷狗音源获取
    if (process.env.IS_ELECTRON !== true) {
      try {
        const artistName = (track.ar || track.artists || [])
          .map(a => a.name)
          .join(' ');
        const params = new URLSearchParams({
          id: track.id,
          name: track.name,
          artist: artistName,
        });
        const resp = await fetch(`/api/unblock?${params.toString()}`);
        const data = await resp.json();
        if (data && data.url) {
          // ✅ CRITICAL: All audio sources served over HTTPS page must be
          // HTTPS URLs — otherwise Chrome/Tesla block it as Mixed Content
          // and Howler hits onerror code 4 ("src not supported").
          const url = String(data.url).replace(/^http:/, 'https:');
          if (store.state.settings.automaticallyCacheSongs) {
            cacheTrackSource(track, url, 128000, `unm:${data.source}`);
          }
          return url;
        }
        return null;
      } catch (err) {
        console.error('[unblock] failed:', err);
        return null;
      }
    }

    /**
     *
     * @param {string=} searchMode
     * @returns {import("@unblockneteasemusic/rust-napi").SearchMode}
     */
    const determineSearchMode = searchMode => {
      /**
       * FastFirst = 0
       * OrderFirst = 1
       */
      switch (searchMode) {
        case 'fast-first':
          return 0;
        case 'order-first':
          return 1;
        default:
          return 0;
      }
    };

    const retrieveSongInfo = await ipcRenderer.invoke(
      'unblock-music',
      store.state.settings.unmSource,
      track,
      {
        enableFlac: store.state.settings.unmEnableFlac || null,
        proxyUri: store.state.settings.unmProxyUri || null,
        searchMode: determineSearchMode(store.state.settings.unmSearchMode),
        config: {
          'joox:cookie': store.state.settings.unmJooxCookie || null,
          'qq:cookie': store.state.settings.unmQQCookie || null,
          'ytdl:exe': store.state.settings.unmYtDlExe || null,
        },
      }
    );

    if (store.state.settings.automaticallyCacheSongs && retrieveSongInfo?.url) {
      // 对于来自 bilibili 的音源
      // retrieveSongInfo.url 是音频数据的base64编码
      // 其他音源为实际url
      const url =
        retrieveSongInfo.source === 'bilibili'
          ? `data:application/octet-stream;base64,${retrieveSongInfo.url}`
          : retrieveSongInfo.url;
      cacheTrackSource(track, url, 128000, `unm:${retrieveSongInfo.source}`);
    }

    if (!retrieveSongInfo) {
      return null;
    }

    if (retrieveSongInfo.source !== 'bilibili') {
      return retrieveSongInfo.url;
    }

    const buffer = base642Buffer(retrieveSongInfo.url);
    return this._getAudioSourceBlobURL(buffer);
  }
  _getAudioSource(track) {
    return this._getAudioSourceFromCache(String(track.id))
      .then(source => {
        return source ?? this._getAudioSourceFromNetease(track);
      })
      .then(source => {
        return source ?? this._getAudioSourceFromUnblockMusic(track);
      })
      .then(source => {
        if (source) {
          // One last defensive HTTPS conversion — every upstream (Netease,
          // unblock 酷狗/QQ/酷我/咪咕, cache Blob URLs) can occasionally
          // return an HTTP URL, which gets silently blocked as Mixed Content
          // on our HTTPS page, resulting in MEDIA_ERR_SRC_NOT_SUPPORTED.
          // Blob URLs (blob:https://...) are already origin-bound so we leave
          // them alone.
          if (typeof source === 'string' && !source.startsWith('blob:')) {
            source = source.replace(/^http:/, 'https:');
          }
          return source;
        }
        // 最后 fallback：网易云外链接口（already HTTPS）
        return `https://music.163.com/song/media/outer/url?id=${track.id}`;
      });
  }
  _replaceCurrentTrack(
    id,
    autoplay = true,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK
  ) {
    if (autoplay && this._currentTrack.name) {
      this._scrobble(this.currentTrack, this._howler?.seek());
    }
    return getTrackDetail(id).then(data => {
      const track = data.songs[0];
      this._currentTrack = track;
      this._updateMediaSessionMetaData(track);
      return this._replaceCurrentTrackAudio(
        track,
        autoplay,
        true,
        ifUnplayableThen
      );
    });
  }
  /**
   * @returns 是否成功加载音频，并使用加载完成的音频替换了howler实例
   */
  _replaceCurrentTrackAudio(
    track,
    autoplay,
    isCacheNextTrack,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK
  ) {
    return this._getAudioSource(track).then(source => {
      if (source) {
        let replaced = false;
        if (track.id === this.currentTrackID) {
          this._playAudioSource(source, autoplay);
          replaced = true;
        }
        if (isCacheNextTrack) {
          this._cacheNextTrack();
        }
        return replaced;
      } else {
        store.dispatch('showToast', `无法播放 ${track.name}`);
        switch (ifUnplayableThen) {
          case UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK:
            this._playNextTrack(this.isPersonalFM);
            break;
          case UNPLAYABLE_CONDITION.PLAY_PREV_TRACK:
            this.playPrevTrack();
            break;
          default:
            store.dispatch(
              'showToast',
              `undefined Unplayable condition: ${ifUnplayableThen}`
            );
            break;
        }
        return false;
      }
    });
  }
  _cacheNextTrack() {
    let nextTrackID = this._isPersonalFM
      ? this._personalFMNextTrack?.id ?? 0
      : this._getNextTrack()[0];
    if (!nextTrackID) return;
    if (this._personalFMTrack.id == nextTrackID) return;
    getTrackDetail(nextTrackID).then(data => {
      let track = data.songs[0];
      this._getAudioSource(track);
    });
  }
  _loadSelfFromLocalStorage() {
    const player = JSON.parse(localStorage.getItem('player'));
    if (!player) return;
    for (const [key, value] of Object.entries(player)) {
      this[key] = value;
    }
  }
  _initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.playPrevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this._playNextTrack(this.isPersonalFM);
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', event => {
        this.seek(event.seekTime);
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekbackward', event => {
        this.seek(this.seek() - (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekforward', event => {
        this.seek(this.seek() + (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
      // Enhanced actions for Tesla car and modern browsers
      if ('setActionHandler' in navigator.mediaSession) {
        try {
          navigator.mediaSession.setActionHandler('playnext', () => {
            this._playNextTrack(this.isPersonalFM);
          });
        } catch (e) {}
        try {
          navigator.mediaSession.setActionHandler('previoustrack', () => {
            this.playPrevTrack();
          });
        } catch (e) {}
        try {
          navigator.mediaSession.setActionHandler('addtoqueue', () => {});
        } catch (e) {}
      }
      // Tesla car search button handlers — try to intercept "search/browse" style
      // actions emitted by Tesla native media bar so they redirect to our in-app
      // /search route instead of launching Tesla's other music apps.
      this._bindTeslaMediaSearchActions();
      this._refreshMediaSessionTrackActions();
    }
  }
  _bindTeslaMediaSearchActions() {
    if (!('mediaSession' in navigator) || !('setActionHandler' in navigator.mediaSession)) {
      return;
    }
    const triggerSearch = () => {
      if (typeof window !== 'undefined' && window.__teslaGoToSearch) {
        window.__teslaGoToSearch();
      } else if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('tesla:media-search'));
      }
    };
    // Standard MediaSession action candidates that some UIs emit for the search button.
    const candidateActions = [
      'seekto',
      'enterpictureinpicture',
      'leavepictureinpicture',
      'togglecamera',
      'togglemicrophone',
      'hangup',
      'previousslide',
      'nextslide',
      'pause',
    ];
    candidateActions.forEach(() => {});
    // Try to register the non-standard "search" action used by some car head units
    // (e.g. Android Automotive), and harmlessly ignore it on unsupported engines.
    const nonStandardSearchActions = [
      'search',
      'browse',
      'openapp',
      'showapp',
      'showlist',
      'showqueue',
    ];
    nonStandardSearchActions.forEach(action => {
      try {
        navigator.mediaSession.setActionHandler(action, () => {
          triggerSearch();
        });
      } catch (e) {
        // ignore unsupported action names
      }
    });
    // Also dispatch a custom event so App.vue can react to "showqueue" style
    // interactions when Tesla exposes the search button as a queue/app launcher.
    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
        // Tesla sometimes emits stop+search together; debounce and check intent
        if (typeof window !== 'undefined') {
          window.__teslaStopTs = Date.now();
        }
      });
    } catch (e) {}
    // Hook into audio element events: Tesla WebKit may trigger seek on the audio
    // element when the search icon is clicked. Monitor anomalous seeks as a clue.
    if (typeof window !== 'undefined') {
      window.__teslaTriggerSearch = triggerSearch;
    }
  }
  _updateMediaSessionMetaData(track) {
    if ('mediaSession' in navigator === false) {
      return;
    }
    let artists = track.ar.map(a => a.name);
    const metadata = {
      title: track.name,
      artist: artists.join(','),
      album: track.al.name,
      artwork: [
        {
          src: track.al.picUrl + '?param=224y224',
          type: 'image/jpg',
          sizes: '224x224',
        },
        {
          src: track.al.picUrl + '?param=512y512',
          type: 'image/jpg',
          sizes: '512x512',
        },
      ],
      length: this.currentTrackDuration,
      trackId: this.current,
      url: '/trackid/' + track.id,
    };

    navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    // After updating metadata, re-evaluate the next/prev transport enabled
    // state so Tesla's native media bar paints the buttons in an active state
    // (instead of greyed out) when there is a queue.
    this._refreshMediaSessionTrackActions();
    if (isCreateMpris) {
      this._updateMprisState(track, metadata);
    }
    // Sync metadata to Tesla car audio element
    if (typeof window !== 'undefined' && window.__playerSetMetadataTesla) {
      window.__playerSetMetadataTesla(track, track.al?.picUrl);
    }
  }
  // OSDLyrics 会检测 Mpris 状态并寻找对应歌词文件，所以要在更新 Mpris 状态之前保证歌词下载完成
  async _updateMprisState(track, metadata) {
    if (!store.state.settings.enableOsdlyricsSupport) {
      return ipcRenderer?.send('metadata', metadata);
    }

    let lyricContent = await getLyric(track.id);

    if (!lyricContent.lrc || !lyricContent.lrc.lyric) {
      return ipcRenderer?.send('metadata', metadata);
    }

    ipcRenderer.send('sendLyrics', {
      track,
      lyrics: lyricContent.lrc.lyric,
    });

    ipcRenderer.on('saveLyricFinished', () => {
      ipcRenderer?.send('metadata', metadata);
    });
  }
  _updateMediaSessionPositionState() {
    if ('mediaSession' in navigator === false) {
      return;
    }
    if ('setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({
          duration: ~~(this.currentTrack.dt / 1000),
          playbackRate: 1.0,
          position: this.seek(),
        });
      } catch (e) {
        // setPositionState throws when dt is 0 or audio not loaded yet.
        // Ignore silently — it's not fatal.
      }
    }
    // Tesla car uses presence of PositionState to decide if prev/next
    // buttons should be enabled for "real music content" vs a
    // single short clip. Re-register handlers right after updating
    // position state so the UI re-reads the action map.
    this._refreshMediaSessionTrackActions();
  }
  _nextTrackCallback() {
    this._scrobble(this._currentTrack, 0, true);
    if (!this.isPersonalFM && this.repeatMode === 'one') {
      this._replaceCurrentTrack(this.currentTrackID);
    } else {
      this._playNextTrack(this.isPersonalFM);
    }
  }
  _loadPersonalFMNextTrack() {
    if (this._personalFMNextLoading) {
      return [false, undefined];
    }
    this._personalFMNextLoading = true;
    return personalFM()
      .then(result => {
        if (!result || !result.data) {
          this._personalFMNextTrack = undefined;
        } else {
          this._personalFMNextTrack = result.data[0];
          this._cacheNextTrack(); // cache next track
        }
        this._personalFMNextLoading = false;
        return [true, this._personalFMNextTrack];
      })
      .catch(() => {
        this._personalFMNextTrack = undefined;
        this._personalFMNextLoading = false;
        return [false, this._personalFMNextTrack];
      });
  }
  _playDiscordPresence(track, seekTime = 0) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    let copyTrack = { ...track };
    copyTrack.dt -= seekTime * 1000;
    ipcRenderer?.send('playDiscordPresence', copyTrack);
  }
  _pauseDiscordPresence(track) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    ipcRenderer?.send('pauseDiscordPresence', track);
  }
  _playNextTrack(isPersonal) {
    if (isPersonal) {
      this.playNextFMTrack();
    } else {
      this.playNextTrack();
    }
  }

  appendTrack(trackID) {
    this.list.append(trackID);
  }
  playNextTrack() {
    // TODO: 切换歌曲时增加加载中的状态
    const [trackID, index] = this._getNextTrack();
    if (trackID === undefined) {
      this._howler?.stop();
      this._setPlaying(false);
      return false;
    }
    let next = index;
    if (index === INDEX_IN_PLAY_NEXT) {
      this._playNextList.shift();
      next = this.current;
    }
    this.current = next;
    this._replaceCurrentTrack(trackID);
    return true;
  }
  async playNextFMTrack() {
    if (this._personalFMLoading) {
      return false;
    }

    this._isPersonalFM = true;
    if (!this._personalFMNextTrack) {
      this._personalFMLoading = true;
      let result = null;
      let retryCount = 5;
      for (; retryCount >= 0; retryCount--) {
        result = await personalFM().catch(() => null);
        if (!result) {
          this._personalFMLoading = false;
          store.dispatch('showToast', 'personal fm timeout');
          return false;
        }
        if (result.data?.length > 0) {
          break;
        } else if (retryCount > 0) {
          await delay(1000);
        }
      }
      this._personalFMLoading = false;

      if (retryCount < 0) {
        let content = '获取私人FM数据时重试次数过多，请手动切换下一首';
        store.dispatch('showToast', content);
        console.log(content);
        return false;
      }
      // 这里只能拿到一条数据
      this._personalFMTrack = result.data[0];
    } else {
      if (this._personalFMNextTrack.id === this._personalFMTrack.id) {
        return false;
      }
      this._personalFMTrack = this._personalFMNextTrack;
    }
    if (this._isPersonalFM) {
      this._replaceCurrentTrack(this._personalFMTrack.id);
    }
    this._loadPersonalFMNextTrack();
    return true;
  }
  playPrevTrack() {
    const [trackID, index] = this._getPrevTrack();
    if (trackID === undefined) return false;
    this.current = index;
    this._replaceCurrentTrack(
      trackID,
      true,
      UNPLAYABLE_CONDITION.PLAY_PREV_TRACK
    );
    return true;
  }
  saveSelfToLocalStorage() {
    let player = {};
    for (let [key, value] of Object.entries(this)) {
      if (excludeSaveKeys.includes(key)) continue;
      player[key] = value;
    }

    localStorage.setItem('player', JSON.stringify(player));
  }

  pause() {
    this._howler?.fade(this.volume, 0, PLAY_PAUSE_FADE_DURATION);

    this._howler?.once('fade', () => {
      this._howler?.pause();
      this._setPlaying(false);
      setTitle(null);
      this._pauseDiscordPresence(this._currentTrack);
      // Sync to Tesla car audio element
      if (typeof window !== 'undefined' && window.__playerPauseTesla) {
        window.__playerPauseTesla();
      }
    });
  }
  play() {
    if (this._howler?.playing()) return;

    this._howler?.play();

    this._howler?.once('play', () => {
      this._howler?.fade(0, this.volume, PLAY_PAUSE_FADE_DURATION);

      // 播放时确保开启player.
      // 避免因"忘记设置"导致在播放时播放器不显示的Bug
      this._enabled = true;
      this._setPlaying(true);
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      this._playDiscordPresence(this._currentTrack, this.seek());
      // Sync to Tesla car audio element
      if (typeof window !== 'undefined' && window.__playerPlayTesla) {
        window.__playerPlayTesla();
        window.__playerSetMetadataTesla(this._currentTrack, this._currentTrack.al?.picUrl);
      }
      if (store.state.lastfm.key !== undefined) {
        trackUpdateNowPlaying({
          artist: this.currentTrack.ar[0].name,
          track: this.currentTrack.name,
          album: this.currentTrack.al.name,
          trackNumber: this.currentTrack.no,
          duration: ~~(this.currentTrack.dt / 1000),
        });
      }
    });
  }
  playOrPause() {
    if (this._howler?.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }
  seek(time = null, sendMpris = true) {
    if (isCreateMpris && sendMpris && time) {
      ipcRenderer?.send('seeked', time);
    }
    if (time !== null) {
      this._howler?.seek(time);
      if (this._playing)
        this._playDiscordPresence(this._currentTrack, this.seek(null, false));
      // Sync to Tesla car audio element
      if (typeof window !== 'undefined' && window.__playerSeekTesla) {
        window.__playerSeekTesla(time);
      }
    }
    return this._howler === null ? 0 : this._howler.seek();
  }
  mute() {
    if (this.volume === 0) {
      this.volume = this._volumeBeforeMuted;
    } else {
      this._volumeBeforeMuted = this.volume;
      this.volume = 0;
    }
  }
  setOutputDevice() {
    if (this._howler?._sounds.length <= 0 || !this._howler?._sounds[0]._node) {
      return;
    }
    this._howler?._sounds[0]._node.setSinkId(store.state.settings.outputDevice);
  }

  replacePlaylist(
    trackIDs,
    playlistSourceID,
    playlistSourceType,
    autoPlayTrackID = 'first'
  ) {
    this._isPersonalFM = false;
    this.list = trackIDs;
    this.current = 0;
    this._playlistSource = {
      type: playlistSourceType,
      id: playlistSourceID,
    };
    this._refreshMediaSessionTrackActions();
    if (this.shuffle) this._shuffleTheList(autoPlayTrackID);
    if (autoPlayTrackID === 'first') {
      this._replaceCurrentTrack(this.list[0]);
    } else {
      this.current = this.list.indexOf(autoPlayTrackID);
      this._replaceCurrentTrack(autoPlayTrackID);
    }
  }
  playAlbumByID(id, trackID = 'first') {
    getAlbum(id).then(data => {
      let trackIDs = data.songs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'album', trackID);
    });
  }
  playPlaylistByID(id, trackID = 'first', noCache = false) {
    console.debug(
      `[debug][Player.js] playPlaylistByID 👉 id:${id} trackID:${trackID} noCache:${noCache}`
    );
    getPlaylistDetail(id, noCache).then(data => {
      let trackIDs = data.playlist.trackIds.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'playlist', trackID);
    });
  }
  playArtistByID(id, trackID = 'first') {
    getArtist(id).then(data => {
      let trackIDs = data.hotSongs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'artist', trackID);
    });
  }
  playTrackOnListByID(id, listName = 'default') {
    if (listName === 'default') {
      this._current = this._list.findIndex(t => t === id);
    }
    this._replaceCurrentTrack(id);
  }
  playIntelligenceListById(id, trackID = 'first', noCache = false) {
    getPlaylistDetail(id, noCache).then(data => {
      const randomId = Math.floor(
        Math.random() * (data.playlist.trackIds.length + 1)
      );
      const songId = data.playlist.trackIds[randomId].id;
      intelligencePlaylist({ id: songId, pid: id }).then(result => {
        let trackIDs = result.data.map(t => t.id);
        this.replacePlaylist(trackIDs, id, 'playlist', trackID);
      });
    });
  }
  addTrackToPlayNext(trackID, playNow = false) {
    this._playNextList.push(trackID);
    if (playNow) {
      this.playNextTrack();
    }
  }
  playPersonalFM() {
    this._isPersonalFM = true;
    if (this.currentTrackID !== this._personalFMTrack.id) {
      this._replaceCurrentTrack(this._personalFMTrack.id, true);
    } else {
      this.playOrPause();
    }
  }
  async moveToFMTrash() {
    this._isPersonalFM = true;
    let id = this._personalFMTrack.id;
    if (await this.playNextFMTrack()) {
      fmTrash(id);
    }
  }

  sendSelfToIpcMain() {
    if (process.env.IS_ELECTRON !== true) return false;
    let liked = store.state.liked.songs.includes(this.currentTrack.id);
    ipcRenderer?.send('player', {
      playing: this.playing,
      likedCurrentTrack: liked,
    });
    setTrayLikeState(liked);
  }

  switchRepeatMode() {
    if (this._repeatMode === 'on') {
      this.repeatMode = 'one';
    } else if (this._repeatMode === 'one') {
      this.repeatMode = 'off';
    } else {
      this.repeatMode = 'on';
    }
    if (isCreateMpris) {
      ipcRenderer?.send('switchRepeatMode', this.repeatMode);
    }
  }
  switchShuffle() {
    this.shuffle = !this.shuffle;
    if (isCreateMpris) {
      ipcRenderer?.send('switchShuffle', this.shuffle);
    }
  }
  switchReversed() {
    this.reversed = !this.reversed;
  }

  clearPlayNextList() {
    this._playNextList = [];
  }
  removeTrackFromQueue(index) {
    this._playNextList.splice(index, 1);
  }
}
