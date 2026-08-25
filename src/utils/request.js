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
  baseURL = process.env.VUE_APP_NETEASE_API_URL;
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
