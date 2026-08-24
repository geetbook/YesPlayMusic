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
    <audio
      ref="teslaAudio"
      id="tesla-audio"
      preload="auto"
      playsinline
      webkit-playsinline
      x5-playsinline
      style="position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;"
      @play="onTeslaAudioPlay"
      @pause="onTeslaAudioPause"
      @ended="onTeslaAudioEnded"
      @timeupdate="onTeslaAudioTimeUpdate"
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
import { isAccountLoggedIn, isLooseLoggedIn } from '@/utils/auth';
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
    if (this.isElectron) ipcRenderer(this);
    window.addEventListener('keydown', this.handleKeydown);
    this.fetchData();
    this.$nextTick(() => {
      this.initTeslaAudio();
      this.initKeepalive();
      this.initVisibilityHandler();
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
    fetchData() {
      if (!isLooseLoggedIn()) return;
      this.$store.dispatch('fetchLikedSongs');
      this.$store.dispatch('fetchLikedSongsWithDetails');
      this.$store.dispatch('fetchLikedPlaylist');
      if (isAccountLoggedIn()) {
        this.$store.dispatch('fetchLikedAlbums');
        this.$store.dispatch('fetchLikedArtists');
        this.$store.dispatch('fetchLikedMVs');
        this.$store.dispatch('fetchCloudDisk');
      }
    },
    handleScroll() {
      this.$refs.scrollbar.handleScroll();
    },
    initTeslaAudio() {
      this.teslaAudioEl = this.$refs.teslaAudio;
      if (!this.teslaAudioEl) return;
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
        this.teslaAudioEl.src = sound._src;
        if (!this.teslaAudioEl.paused) {
          this.teslaAudioEl.pause();
        }
        this.teslaAudioEl.currentTime = 0;
        this.setTeslaAudioMetadata(track, track.al?.picUrl);
      }
    },
    playTeslaAudio() {
      if (!this.teslaAudioEl) return;
      if (this.teslaAudioEl.src) {
        this.teslaAudioEl.play().catch(() => {});
      }
    },
    pauseTeslaAudio() {
      if (!this.teslaAudioEl) return;
      this.teslaAudioEl.pause();
    },
    seekTeslaAudio(time) {
      if (!this.teslaAudioEl) return;
      this.teslaAudioEl.currentTime = time || 0;
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
      if (this.player) {
        this.player._nextTrackCallback();
      }
    },
    onTeslaAudioTimeUpdate() {
      if (this.player && this.teslaAudioEl) {
        if (Math.abs(this.player.seek() - this.teslaAudioEl.currentTime) > 2) {
          this.player.seek(this.teslaAudioEl.currentTime);
        }
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
