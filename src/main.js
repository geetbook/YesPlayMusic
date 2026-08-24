import Vue from 'vue';
import VueGtag from 'vue-gtag';
import App from './App.vue';
import router from './router';
import store from './store';
import i18n from '@/locale';
import '@/assets/icons';
import '@/utils/filters';
import './registerServiceWorker';
import { dailyTask } from '@/utils/common';
import '@/assets/css/global.scss';
import NProgress from 'nprogress';
import '@/assets/css/nprogress.css';

window.resetApp = () => {
  localStorage.clear();
  indexedDB.deleteDatabase('yesplaymusic');
  document.cookie.split(';').forEach(function (c) {
    document.cookie = c
      .replace(/^ +/, '')
      .replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
  });
  return '已重置应用，请刷新页面（按Ctrl/Command + R）';
};
console.log(
  '如出现问题，可尝试在本页输入 %cresetApp()%c 然后按回车重置应用。',
  'background: #eaeffd;color:#335eea;padding: 4px 6px;border-radius:3px;',
  'background:unset;color:unset;'
);

// Register Service Worker for PWA (Tesla car needs this for background keepalive)
if ('serviceWorker' in navigator && !process.env.IS_ELECTRON) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => {
        console.log('SW registered:', reg.scope);
      })
      .catch((err) => {
        console.log('SW registration failed:', err);
      });
    // Periodic keepalive even when tab is hidden
    setInterval(() => {
      if (document.visibilityState === 'hidden') {
        fetch('/api/unblock?keepalive=' + Date.now(), {
          cache: 'no-store',
        }).catch(() => {});
      }
    }, 15000);
  });
}

// Google Analytics（vue-gtag）只在能访问 gtag 域名时异步注册
// 否则在国内手机网络会阻塞首屏加载（gtag 域名无法访问导致超时）
if (typeof window !== 'undefined') {
  window.addEventListener('load', function () {
    try {
      // 先做一次连通性探测：加载 gtag.js 的小资源，超时则放弃注册
      var probe = new Image();
      var timedOut = false;
      var timer = setTimeout(function () {
        timedOut = true;
        probe.onerror = probe.onload = null;
      }, 2000);
      probe.onload = function () {
        clearTimeout(timer);
        if (!timedOut) {
          Vue.use(
            VueGtag,
            {
              config: { id: 'G-KMJJCFZDKF' },
              disableScriptLoad: false,
            },
            router
          );
        }
      };
      probe.onerror = function () {
        clearTimeout(timer);
        // 无法访问 gtag，放弃注册（国内手机网络常见情况）
      };
      probe.src = 'https://www.googletagmanager.com/gtag/js?id=G-KMJJCFZDKF';
    } catch (e) {
      // 忽略所有 GA 初始化错误，不影响主应用运行
    }
  });
}
Vue.config.productionTip = false;

NProgress.configure({ showSpinner: false, trickleSpeed: 100 });
dailyTask();

new Vue({
  i18n,
  store,
  router,
  render: h => h(App),
}).$mount('#app');
