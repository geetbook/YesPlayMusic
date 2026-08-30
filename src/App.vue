<template>
  <div id="app" :class="{ 'user-select-none': userSelectNone }">
    <Scrollbar v-show="!showLyrics" ref="scrollbar" />
    <Navbar v-show="showNavbar" ref="navbar" />
    <main
      ref="main"
      :style="{ overflow: enableScrolling ? 'auto' : 'hidden' }"
      @scroll="handleScroll"
    >
      <keep-alive>
        <router-view v-if="$route.meta.keepAlive"></router-view>
      </keep-alive>
      <router-view v-if="!$route.meta.keepAlive"></router-view>
    </main>
    <transition name="slide-up">
      <Player v-if="enablePlayer" v-show="showPlayer" ref="player" />
    </transition>
    <Toast />
    <ModalAddTrackToPlaylist v-if="isAccountLoggedIn" />
    <ModalNewPlaylist v-if="isAccountLoggedIn" />
    <transition v-if="enablePlayer" name="slide-up">
      <Lyrics v-show="showLyrics" />
    </transition>
    <!-- Tesla car needs a visible audio element to enable native media controls -->
    <!-- IMPORTANT: opacity:0 or display:none causes Tesla to ignore it, so -->
    <!-- we keep size > 0 but clip it out of the viewport (left: -9999px).     -->
    <!-- playsinline + webkit-playsinline ensures the element is considered a -->
    <!-- "now playing session" even on WebKit builds that force fullscreen.    -->
    <audio
      ref="teslaAudio"
      id="tesla-audio"
      preload="auto"
      playsinline
      webkit-playsinline
      x5-playsinline
      muted
      style="position:fixed;bottom:0;left:-9999px;width:2px;height:2px;z-index:-1;pointer-events:none;object-position:0 0;"
      @play="onTeslaAudioPlay"
      @pause="onTeslaAudioPause"
      @ended="onTeslaAudioEnded"
      @timeupdate="onTeslaAudioTimeUpdate"
      @loadedmetadata="onTeslaAudioLoadedMeta"
    ></audio>
  </div>
</template>

<script>
import ModalAddTrackToPlaylist from './components/ModalAddTrackToPlaylist.vue';
import ModalNewPlaylist from './components/ModalNewPlaylist.vue';
import Scrollbar from './components/Scrollbar.vue';
import Navbar from './components/Navbar.vue';
import Player from './components/Player.vue';
import Toast from './components/Toast.vue';
import { ipcRenderer } from './electron/ipcRenderer';
import { isAccountLoggedIn, isLooseLoggedIn, backupCurrentCookies, restoreBackupCookies } from '@/utils/auth';
import Lyrics from './views/lyrics.vue';
import { mapState } from 'vuex';

export default {
  name: 'App',
  components: {
    Navbar,
    Player,
    Toast,
    ModalAddTrackToPlaylist,
    ModalNewPlaylist,
    Lyrics,
    Scrollbar,
  },
  data() {
    return {
      isElectron: process.env.IS_ELECTRON,
      userSelectNone: false,
      teslaAudioEl: null,
      _keepaliveTimer: null,
      _lastPlayState: null,
      _autoResumeOnVisible: false,
      _resumeTrackId: null,
      _resumeSeekTime: 0,
    };
  },
  computed: {
    ...mapState(['showLyrics', 'settings', 'player', 'enableScrolling']),
    isAccountLoggedIn() {
      return isAccountLoggedIn();
    },
    showPlayer() {
      return (
        [
          'mv',
          'loginUsername',
          'login',
          'loginAccount',
          'lastfmCallback',
        ].includes(this.$route.name) === false
      );
    },
    enablePlayer() {
      return this.player.enabled && this.$route.name !== 'lastfmCallback';
    },
    showNavbar() {
      return this.$route.name !== 'lastfmCallback';
    },
  },
  created() {
    // ---- 跨设备登录态同步（车机共享收藏歌单的关键）----
    // 如果浏览器有网易云登录 cookie → 自动备份到 localStorage.ncmCookieBackup
    // 如果浏览器没 cookie 但有 ncmCookieBackup → 自动恢复
    // 这样车机等无 cookie 设备手动设一次 ncmCookieBackup 就能继承登录态
    try {
      const hasBrowserCookie = !!document.cookie && document.cookie.includes('MUSIC_U=');
      const hasBackup = !!localStorage.getItem('ncmCookieBackup');
      if (hasBrowserCookie && !hasBackup) {
        backupCurrentCookies();
        console.log('[cookie-sync] Auto-backed up browser cookies → ncmCookieBackup');
      } else if (!hasBrowserCookie && hasBackup) {
        restoreBackupCookies();
        console.log('[cookie-sync] Restored ncmCookieBackup → browser cookies');
      }
    } catch (_) {}

    if (this.isElectron) ipcRenderer(this);
    window.addEventListener('keydown', this.handleKeydown);
    this.fetchData();
    this.$nextTick(() => {
      this.initTeslaAudio();
      this.initKeepalive();
      this.initVisibilityHandler();
      this.initTeslaSearchHandler();
    });
  },
  methods: {
    handleKeydown(e) {
      if (e.code === 'Space') {
        if (e.target.tagName === 'INPUT') return false;
        if (this.$route.name === 'mv') return false;
        e.preventDefault();
        this.player.playOrPause();
      }
    },
    goToSearch() {
      try {
        const currentName = this.$route && this.$route.name;
        if (currentName && currentName.indexOf('search') === 0) {
          // already on a search page — try to focus the input via DOM
          this.$nextTick(() => {
            try {
              const input = document.querySelector(
                'input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]'
              );
              if (input && typeof input.focus === 'function') {
                input.focus();
              }
            } catch (e) {}
          });
          return;
        }
        this.$router.push('/search');
      } catch (e) {
        // fallback: direct location change so the SPA router catches it
        if (window.location && window.location.hash) {
          window.location.hash = '#/search';
        }
      }
    },
    initTeslaSearchHandler() {
      // Expose a public hook that MediaSession actions and the Tesla audio
      // element event listeners can invoke without circular dependencies.
      window.__teslaGoToSearch = () => this.goToSearch();
      // Listen for a custom event dispatched by Player.js search fallback
      window.addEventListener('tesla:media-search', () => this.goToSearch());
      // Tesla sometimes dispatches a synthetic keypress when the search icon
      // is tapped. The common car-OS convention is F3 or Ctrl+F for search.
      window.addEventListener('keydown', (e) => {
        if (
          e.key === 'F3' ||
          e.code === 'F3' ||
          (e.ctrlKey && (e.key === 'f' || e.key === 'F')) ||
          (e.metaKey && (e.key === 'f' || e.key === 'F'))
        ) {
          e.preventDefault();
          this.goToSearch();
        }
      });
      // Tesla WebKit occasionally sends hashchange / url intent signals when
      // the native media bar is asked to perform a "browse/search" action.
      // Intercept those and redirect them to our own search route.
      const interceptSearchIntent = () => {
        const hash = window.location.hash || '';
        const search = window.location.search || '';
        const combined = (hash + search).toLowerCase();
        const markers = [
          'tesla-search',
          'media-search',
          'car-search',
          'action=search',
          'action=browse',
          'intent=search',
          'open=search',
        ];
        if (markers.some((m) => combined.indexOf(m) !== -1)) {
          // strip synthetic markers and navigate to /search
          if (window.history && typeof window.history.replaceState === 'function') {
            const cleanUrl =
              window.location.protocol +
              '//' +
              window.location.host +
              window.location.pathname +
              '#/search';
            window.history.replaceState({}, '', cleanUrl);
          }
          if (this.$route && this.$route.path !== '/search') {
            this.$router.replace('/search').catch(() => {});
          }
        }
      };
      window.addEventListener('hashchange', interceptSearchIntent);
      interceptSearchIntent();
      // Additionally, watch the tesla-audio element for anomalous events that
      // Tesla fires when the native search icon is clicked: some builds trigger
      // a fast pause+play, a zero-duration seek, or an `emptied` event with no
      // src change. Detect those patterns and route to search.
      let lastPauseTs = 0;
      const audioEl = this.$refs.teslaAudio;
      if (audioEl) {
        audioEl.addEventListener('pause', () => {
          lastPauseTs = Date.now();
        });
        audioEl.addEventListener('play', () => {
          const dt = Date.now() - lastPauseTs;
          if (dt > 0 && dt < 120 && window.__teslaStopTs) {
            // pause-then-play faster than a human tap is a Tesla search hint
            const stopDt = Date.now() - window.__teslaStopTs;
            if (stopDt < 600) {
              this.goToSearch();
            }
          }
        });
        audioEl.addEventListener('loadedmetadata', () => {
          // no-op reserved for future Tesla-specific heuristics
        });
        audioEl.addEventListener('seeked', () => {
          // Detect seeks that jump precisely to 0 without a user tap on our UI
          // — on some Tesla builds the search icon triggers such a seek before
          // switching focus away. Guard by checking that no buttons in our UI
          // currently have focus.
          const active = document.activeElement;
          if (
            audioEl.currentTime === 0 &&
            (!active ||
              (active.tagName !== 'BUTTON' &&
                active.tagName !== 'A' &&
                active.tagName !== 'INPUT'))
          ) {
            // Only treat as search intent if it happens within a short window
            // after a stop/search signal was already seen.
            if (window.__teslaStopTs && Date.now() - window.__teslaStopTs < 500) {
              this.goToSearch();
            }
          }
        });
      }
    },
    fetchData() {
      if (!isLooseLoggedIn()) return;
      // 车机等场景：有 ncmCookieBackup 但没调过登录 → user 对象为空
      // 先 fetch userAccount 填充 user.userId，后续 fetchLikedPlaylist 才能用
      const user = this.$store.state.data.user;
      const needFetchUser = isAccountLoggedIn() && (!user || !user.userId);
      const doFetch = () => {
        this.$store.dispatch('fetchLikedSongs');
        this.$store.dispatch('fetchLikedSongsWithDetails');
        this.$store.dispatch('fetchLikedPlaylist');
        if (isAccountLoggedIn()) {
          this.$store.dispatch('fetchLikedAlbums');
          this.$store.dispatch('fetchLikedArtists');
          this.$store.dispatch('fetchLikedMVs');
          this.$store.dispatch('fetchCloudDisk');
        }
      };
      if (needFetchUser) {
        import('@/api/user').then(({ userAccount }) => {
          userAccount().then((data) => {
            if (data && data.account && data.account.id) {
              this.$store.commit('updateData', { key: 'user', value: data.account });
              this.$store.commit('updateData', { key: 'loginMode', value: 'account' });
            }
          }).catch(() => {}).finally(() => {
            // 等 userAccount 完成后再 doFetch，确保 uid 已填充
            doFetch();
          });
        });
      } else {
        doFetch();
      }
    },
    handleScroll() {
      this.$refs.scrollbar.handleScroll();
    },
    initTeslaAudio() {
      this.teslaAudioEl = this.$refs.teslaAudio;
      if (!this.teslaAudioEl) return;
      // Expose refresh hook back to Player so loadedmetadata can re-trigger
      // MediaSession track action registration from App.vue.
      if (window) {
        window.__playerRefreshMediaSessionTrackActions = () => {
          if (this.player && typeof this.player._refreshMediaSessionTrackActions === 'function') {
            this.player._refreshMediaSessionTrackActions();
          }
        };
        window.addEventListener('tesla:refresh-actions', () => {
          if (this.player && typeof this.player._refreshMediaSessionTrackActions === 'function') {
            this.player._refreshMediaSessionTrackActions();
          }
        });
      }
      if (this.player && this.player._howler) {
        this.syncTeslaAudioSource();
      }
      window.__playerSyncTesla = () => this.syncTeslaAudioSource();
      window.__playerPlayTesla = () => this.playTeslaAudio();
      window.__playerPauseTesla = () => this.pauseTeslaAudio();
      window.__playerSeekTesla = (t) => this.seekTeslaAudio(t);
      window.__playerSetMetadataTesla = (track, artwork) =>
        this.setTeslaAudioMetadata(track, artwork);
    },
    syncTeslaAudioSource() {
      if (!this.teslaAudioEl || !this.player) return;
      const track = this.player.currentTrack;
      if (!track || !this.player._howler) return;
      const sound = this.player._howler._sounds[0];
      if (sound && sound._src && sound._src !== this.teslaAudioEl.src) {
        // Stop the silent track first so Tesla re-evaluates "now playing"
        try {
          if (!this.teslaAudioEl.paused) {
            this.teslaAudioEl.pause();
          }
        } catch (e) {}
        this.teslaAudioEl.removeAttribute('src');
        try { this.teslaAudioEl.load(); } catch (e) {}
        this.teslaAudioEl.src = sound._src;
        try { this.teslaAudioEl.load(); } catch (e) {}
        this.teslaAudioEl.currentTime = 0;
        this.setTeslaAudioMetadata(track, track.al?.picUrl);
        // Kick a tiny synthetic play/pause so the UA announces the session
        // and enables transport controls, even on Tesla builds that require
        // an explicit media element play() before lighting up the buttons.
        try {
          const p = this.teslaAudioEl.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => {}).finally(() => {
              if (this.player && !this.player._playing) {
                try { this.teslaAudioEl.pause(); } catch (e2) {}
              }
            });
          }
        } catch (e) {}
      }
    },
    playTeslaAudio() {
      if (!this.teslaAudioEl) return;
      if (!this.teslaAudioEl.src && this.player && this.player._howler) {
        const sound = this.player._howler._sounds[0];
        if (sound && sound._src) {
          this.teslaAudioEl.src = sound._src;
          try { this.teslaAudioEl.load(); } catch (e) {}
        }
      }
      if (this.teslaAudioEl.src) {
        // Sync currentTime from actual Howler playback so the Tesla UI shows
        // progress from the correct position instead of always jumping to 0.
        try {
          if (this.player) {
            const t = this.player.seek();
            if (typeof t === 'number' && !isNaN(t) && isFinite(t)) {
              this.teslaAudioEl.currentTime = t;
            }
          }
        } catch (e) {}
        const p = this.teslaAudioEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    },
    pauseTeslaAudio() {
      if (!this.teslaAudioEl) return;
      try { this.teslaAudioEl.pause(); } catch (e) {}
    },
    seekTeslaAudio(time) {
      if (!this.teslaAudioEl) return;
      try {
        this.teslaAudioEl.currentTime = (time || 0) | 0;
      } catch (e) {}
    },
    setTeslaAudioMetadata(track, artwork) {
      if (!this.teslaAudioEl || !track) return;
      try {
        this.teslaAudioEl.title = track.name || '';
        this.teslaAudioEl.artist = track.ar ? track.ar.map((a) => a.name).join(',') : '';
        this.teslaAudioEl.album = track.al ? track.al.name : '';
        this.teslaAudioEl.cover = artwork || '';
        if (artwork) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            try {
              if (navigator.mediaSession) {
                navigator.mediaSession.metadata = new MediaMetadata({
                  title: track.name,
                  artist: track.ar ? track.ar.map((a) => a.name).join(',') : '',
                  album: track.al ? track.al.name : '',
                  artwork: [
                    { src: artwork + '?param=512y512', sizes: '512x512', type: 'image/jpeg' },
                  ],
                });
              }
            } catch (e) {}
          };
          img.src = artwork;
        } else if (navigator.mediaSession) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name,
            artist: track.ar ? track.ar.map((a) => a.name).join(',') : '',
            album: track.al ? track.al.name : '',
          });
        }
      } catch (e) {}
    },
    onTeslaAudioPlay() {
      if (this.player && !this.player._playing) {
        this.player.play();
      }
    },
    onTeslaAudioPause() {
      if (this.player && this.player._playing) {
        this.player.pause();
      }
    },
    onTeslaAudioEnded() {
      if (!this.player) return;
      // Tesla audio 是 muted 静音辅助元素，车机老 WebKit 上可能因
      // buffer 不完整 / duration 元数据错误而提前 ended。只有当
      // Howler（真正发声的音频）也接近末尾时才跳下一首。
      if (this.player._howler) {
        try {
          const howlDur = this.player._howler.duration();
          const howlSeek = this.player._howler.seek();
          if (howlDur > 0 && howlSeek >= howlDur - 2) {
            this.player._nextTrackCallback();
          }
          // else: Howler 还在播放中间，Tesla audio 提前 ended → 忽略
        } catch (e) {
          this.player._nextTrackCallback();
        }
      } else {
        this.player._nextTrackCallback();
      }
    },
    onTeslaAudioTimeUpdate() {
      if (!this.player || !this.teslaAudioEl || !this.player._howler) return;
      try {
        // 只在 Tesla audio duration 与 Howler 接近时才同步 currentTime，
        // 防止 Tesla audio 加载不完整（duration 偏短）时反向 seek Howler
        const teslaDur = this.teslaAudioEl.duration;
        const howlDur = this.player._howler.duration();
        if (teslaDur > 0 && howlDur > 0 &&
            Math.abs(teslaDur - howlDur) < 5 &&
            Math.abs(this.player.seek() - this.teslaAudioEl.currentTime) > 2) {
          this.player.seek(this.teslaAudioEl.currentTime);
        }
      } catch (e) {}
    },
    onTeslaAudioLoadedMeta() {
      // Once Tesla WebKit parses the media metadata, re-assert duration and
      // nudge MediaSession so the OS-level transport controls (prev/next) see
      // a valid session and stop drawing greyed-out buttons.
      try {
        if (navigator.mediaSession && typeof navigator.mediaSession.setPositionState === 'function') {
          const dur = this.teslaAudioEl && isFinite(this.teslaAudioEl.duration) && this.teslaAudioEl.duration > 0
            ? this.teslaAudioEl.duration
            : (this.player ? (this.player.currentTrackDuration || 0) : 0);
          const pos = this.player ? (this.player.seek() || 0) : 0;
          if (dur > 0) {
            navigator.mediaSession.setPositionState({
              duration: dur,
              playbackRate: 1.0,
              position: Math.min(pos, dur - 0.001),
            });
          }
        }
      } catch (e) {}
      // Ask Player to re-register next/prev handlers so Tesla refreshes their
      // enabled state now that a real audio stream has been observed.
      if (typeof window !== 'undefined' && window.__playerRefreshMediaSessionTrackActions) {
        try { window.__playerRefreshMediaSessionTrackActions(); } catch (e) {}
      } else if (typeof window !== 'undefined' && window.dispatchEvent) {
        try { window.dispatchEvent(new CustomEvent('tesla:refresh-actions')); } catch (e) {}
      }
    },
    initKeepalive() {
      if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = setInterval(() => {
        if (this._autoResumeOnVisible) {
          this.doKeepaliveFetch();
        }
      }, 20000);
      this.doKeepaliveFetch();
      window.addEventListener('online', () => this.doKeepaliveFetch());
      this._keepaliveWorker = null;
      if (typeof Worker !== 'undefined') {
        try {
          this._keepaliveWorker = new Worker(
            URL.createObjectURL(
              new Blob([
                `setInterval(function(){self.postMessage('tick');},15000);`,
              ], { type: 'application/javascript' })
            )
          );
          this._keepaliveWorker.onmessage = () => this.doKeepaliveFetch();
        } catch (e) {}
      }
    },
    doKeepaliveFetch() {
      const url = '/api/unblock?keepalive=' + Date.now();
      fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      }).catch(() => {});
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'KEEPALIVE' });
      }
    },
    initVisibilityHandler() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          if (this.player && this.player._playing) {
            this._autoResumeOnVisible = true;
            this._lastPlayState = true;
            this._resumeTrackId = this.player.currentTrackID;
            this._resumeSeekTime = this.player.seek();
          } else {
            this._lastPlayState = false;
          }
          if (this._keepaliveTimer) {
            this._keepaliveInterval = setInterval(() => {
              fetch('/api/unblock?keepalive=' + Date.now(), {
                cache: 'no-store',
              }).catch(() => {});
            }, 8000);
          }
        } else if (document.visibilityState === 'visible') {
          if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
          }
          if (this._autoResumeOnVisible && this._resumeTrackId) {
            this.player._replaceCurrentTrack(this._resumeTrackId).then(() => {
              this.player.seek(this._resumeSeekTime);
              this.player.play();
            });
            this._autoResumeOnVisible = false;
          }
        }
      });
      window.addEventListener('pageshow', (e) => {
        if (e.persisted && this._autoResumeOnVisible && this._resumeTrackId) {
          this.player._replaceCurrentTrack(this._resumeTrackId).then(() => {
            this.player.seek(this._resumeSeekTime);
            this.player.play();
          });
          this._autoResumeOnVisible = false;
        }
      });
      window.addEventListener('pagehide', () => {
        if (this.player && this.player._playing) {
          this._autoResumeOnVisible = true;
          this._resumeTrackId = this.player.currentTrackID;
          this._resumeSeekTime = this.player.seek();
          this.player.pause();
        }
      });
    },
  },
};
</script>

<style lang="scss">
#app {
  width: 100%;
  transition: all 0.4s;
}

main {
  position: fixed;
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
  overflow: auto;
  padding: 64px 10vw 96px 10vw;
  box-sizing: border-box;
  scrollbar-width: none; // firefox
}

@media (max-width: 1336px) {
  main {
    padding: 64px 5vw 96px 5vw;
  }
}

main::-webkit-scrollbar {
  width: 0px;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.4s;
}
.slide-up-enter,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
