import router from '@/router';
import { doLogout, getCookie } from '@/utils/auth';
import axios from 'axios';

let baseURL = '';
// Web 和 Electron 跑在不同端口避免同时启动时冲突
if (process.env.IS_ELECTRON) {
  if (process.env.NODE_ENV === 'production') {
    baseURL = process.env.VUE_APP_ELECTRON_API_URL;
  } else {
    baseURL = process.env.VUE_APP_ELECTRON_API_URL_DEV;
  }
} else {
  // Production web build: bypass the Cloudflare Worker Basic Auth layer that
  // sits in front of our custom domain (music.688810.xyz). The Worker correctly
  // forwards GET requests for static assets and read-only API queries (detail,
  // lyric, song/url) but has been observed to return HTTP 405 "Method Not
  // Allowed" for POST /playlist/subscribe and similar mutation requests, even
  // after we switched those endpoints to GET. By routing API calls directly
  // to the upstream NeteaseCloudMusicApi deployment we skip the extra proxy
  // layer entirely and eliminate the entire class of 405/403/CORS edge
  // problems caused by the Worker.
  //
  // This is safe because:
  //   1. The upstream API is a public Binaryify-style deployment (no auth on
  //      the API itself — auth lives in the MUSIC_U cookie / query-string
  //      credential that we explicitly attach below).
  //   2. We send credentials via query string (`cookie: MUSIC_U=…`) instead
  //      of the Cookie header, so cross-origin cookies are never required.
  //   3. The upstream already responds with permissive CORS headers for our
  //      use-case (GET/POST are allowed for browser XHR/fetch).
  //   4. Vercel Rewrite on the frontend project still routes `/api/*` through
  //      as a fallback (keeps unblock API endpoints and legacy URLs working).
  const DIRECT_UPSTREAM = 'https://api-enhanced-sooty-six.vercel.app';
  const envBase = process.env.VUE_APP_NETEASE_API_URL || '';
  if (
    typeof envBase === 'string' &&
    envBase.length &&
    envBase !== '/api' &&
    envBase !== '/api/'
  ) {
    // An explicit host-based API URL was set via env — honor it.
    baseURL = envBase;
  } else {
    // Default (either unset OR the relative "/api" placeholder) → go direct
    // to the upstream API host to avoid Cloudflare Worker method issues.
    baseURL = DIRECT_UPSTREAM;
  }
}

const service = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 15000,
});

service.interceptors.request.use(function (config) {
  if (!config.params) config.params = {};
  if (baseURL.length) {
    // Always forward MUSIC_U cookie to the upstream API as a query param.
    // - Browser cookie domains on custom domains (e.g. music.688810.xyz) do
    //   not automatically carry over to the rewrites target (Vercel API
    //   domain), so passing it in query params is the reliable cross-domain
    //   credential mechanism used by NeteaseCloudMusicApi servers.
    // - Previously this block only forwarded when baseURL[0] !== '/' (meaning
    //   an absolute external host) — but in our Vercel build baseURL is "/api"
    //   so the block was skipped entirely and requests like /playlist/subscribe
    //   were sent without session cookie → backend replied "需要登录" (301)
    //   and the UI silently did nothing.
    const musicU = getCookie('MUSIC_U');
    if (musicU !== null && musicU !== undefined) {
      // Encode the cookie *value* so characters like "+/=;%& ," don't corrupt
      // the query string when passed as a GET param (all playlist operations
      // now run through GET to avoid 405 from the Cloudflare edge layer).
      const encodedCookie =
        'MUSIC_U=' + encodeURIComponent(String(musicU)) + ';';
      if (!config.params.cookie) {
        config.params.cookie = encodedCookie;
      } else if (
        typeof config.params.cookie === 'string' &&
        config.params.cookie.indexOf('MUSIC_U=') === -1
      ) {
        config.params.cookie = encodedCookie + ' ' + config.params.cookie;
      }
    }
  } else {
    console.error("You must set up the baseURL in the service's config");
  }

  if (!process.env.IS_ELECTRON && !config.url.includes('/login')) {
    config.params.realIP = '211.161.244.70';
  }

  // Force real_ip
  try {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
    const enableRealIP = !!(settings && settings.enableRealIP);
    const realIP = settings && settings.realIP;
    if (process.env.VUE_APP_REAL_IP) {
      config.params.realIP = process.env.VUE_APP_REAL_IP;
    } else if (enableRealIP && realIP) {
      config.params.realIP = realIP;
    }
  } catch (e) {
    // localStorage parse failure shouldn't kill the request
  }

  try {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');
    const proxy = settings && settings.proxyConfig;
    if (proxy && ['HTTP', 'HTTPS'].includes(proxy.protocol)) {
      config.params.proxy = `${proxy.protocol}://${proxy.server}:${proxy.port}`;
    }
  } catch (e) {}

  return config;
});

service.interceptors.response.use(
  response => {
    const res = response.data;
    // Handle "需要登录" returned in the SUCCESS response body (status 200)
    if (res && typeof res === 'object' && res.code === 301 && res.msg === '需要登录') {
      console.warn('[request] Upstream replied with need-login on 200 body. Logging out now.');
      doLogout();
      if (process.env.IS_ELECTRON === true) {
        router.push({ name: 'loginAccount' });
      } else {
        router.push({ name: 'login' });
      }
    }
    return res;
  },
  async error => {
    /** @type {import('axios').AxiosResponse | null} */
    let response;
    let data;
    if (error === 'TypeError: baseURL is undefined') {
      response = error;
      data = error;
      console.error("You must set up the baseURL in the service's config");
    } else if (error && error.response) {
      response = error.response;
      data = response.data;
    }

    if (
      response &&
      typeof data === 'object' &&
      data &&
      data.code === 301 &&
      data.msg === '需要登录'
    ) {
      console.warn('Token has expired. Logout now!');

      // 登出帳戶
      doLogout();

      // 導向登入頁面
      if (process.env.IS_ELECTRON === true) {
        router.push({ name: 'loginAccount' });
      } else {
        router.push({ name: 'login' });
      }
    }

    // Always reject with a descriptive payload so .then() chains that skip
    // error handling still surface the failure instead of hanging forever
    // (e.g. playlist likePlaylist was stuck "clicking a dead button" because
    // the rejection was not bubbling up).
    const safeErr =
      (error && (error.message || error.stack)) ? error : new Error(
        (data && (data.message || data.msg)) ? (data.message || data.msg) : 'Request failed'
      );
    try { safeErr.response = response; } catch (_) {}
    try { safeErr.responseData = data; } catch (_) {}
    return Promise.reject(safeErr);
  }
);

export default service;
