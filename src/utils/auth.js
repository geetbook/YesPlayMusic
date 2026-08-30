import Cookies from 'js-cookie';
import { logout } from '@/api/auth';
import store from '@/store';

export function setCookies(string) {
  const cookies = string.split(';;');
  cookies.map(cookie => {
    document.cookie = cookie;
    const cookieKeyValue = cookie.split(';')[0].split('=');
    localStorage.setItem(`cookie-${cookieKeyValue[0]}`, cookieKeyValue[1]);
  });
}

export function getCookie(key) {
  return Cookies.get(key) ?? localStorage.getItem(`cookie-${key}`);
}

export function removeCookie(key) {
  Cookies.remove(key);
  localStorage.removeItem(`cookie-${key}`);
}

// MUSIC_U 只有在账户登录的情况下才有
export function isLoggedIn() {
  return getCookie('MUSIC_U') !== undefined;
}

// 账号登录
export function isAccountLoggedIn() {
  return (
    getCookie('MUSIC_U') !== undefined &&
    store.state.data.loginMode === 'account'
  );
}

// 用户名搜索（用户数据为只读）
export function isUsernameLoggedIn() {
  return store.state.data.loginMode === 'username';
}

// 账户登录或者用户名搜索都判断为登录，宽松检查
// 也支持从 localStorage.ncmCookieBackup 读共享 cookie（车机等跨设备登录同步）
export function isLooseLoggedIn() {
  if (isAccountLoggedIn() || isUsernameLoggedIn()) return true;
  try {
    const backup = localStorage.getItem('ncmCookieBackup');
    if (backup && backup.includes('MUSIC_U=')) return true;
  } catch (_) {}
  return false;
}

// 把当前浏览器的网易云登录 cookie 存到 localStorage.ncmCookieBackup
// 让车机等其他设备可以通过手动设置 ncmCookieBackup 共享登录态
export function backupCurrentCookies() {
  try {
    const names = ['MUSIC_U', '__csrf', 'NMTID'];
    const parts = [];
    names.forEach((name) => {
      const val = getCookie(name);
      if (val) parts.push(`${name}=${val}`);
    });
    if (parts.length > 0) {
      const str = parts.join('; ');
      localStorage.setItem('ncmCookieBackup', str);
      return str;
    }
  } catch (_) {}
  return '';
}

// 恢复 ncmCookieBackup 到浏览器 cookie（车机导入登录态时用）
export function restoreBackupCookies() {
  try {
    const backup = localStorage.getItem('ncmCookieBackup');
    if (!backup) return false;
    backup.split(';').forEach((kv) => {
      const trimmed = kv.trim();
      if (!trimmed) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        // restore both js-cookie and cookie-xxx localStorage
        try { document.cookie = `${key}=${val}; path=/`; } catch (_) {}
        try { localStorage.setItem(`cookie-${key}`, val); } catch (_) {}
      }
    });
    return true;
  } catch (_) {}
  return false;
}

export function doLogout() {
  logout();
  removeCookie('MUSIC_U');
  removeCookie('__csrf');
  // 更新状态仓库中的用户信息
  store.commit('updateData', { key: 'user', value: {} });
  // 更新状态仓库中的登录状态
  store.commit('updateData', { key: 'loginMode', value: null });
  // 更新状态仓库中的喜欢列表
  store.commit('updateData', { key: 'likedSongPlaylistID', value: undefined });
}
