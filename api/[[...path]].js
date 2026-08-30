// Vercel Function: Catch-all /api/* proxy -> NCM API Enhanced
// 自动合并后端共享 cookie (NCM_SHARED_COOKIE env var) + 浏览器 cookie
// 让所有设备（包括车机无 cookie 的）都继承 PC 的网易云登录态

const NCM_API_BASE = 'https://api-enhanced-sooty-six.vercel.app';

// 不被 catch-all 代理的路径（已有独立处理）
const LOCAL_HANDLERS = ['/unblock'];

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-NCM-Cookie, Cookie',
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS',
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 让 unblock.js 等独立 function 自己处理
  for (const h of LOCAL_HANDLERS) {
    if (pathname.startsWith(`/api${h}`)) {
      // return undefined 让 Vercel 路由到下一个 handler
      return;
    }
  }

  // 构造转发 URL：去掉 /api 前缀，保留 pathname + query
  const match = pathname.match(/^\/api\/(.*)$/);
  const apiPath = match ? match[1] : '';
  const target = new URL('/' + apiPath + url.search, NCM_API_BASE);

  // ====== 登录态合并 ======
  // 优先级（后来覆盖前面的同名字段）：
  //   URL ?cookie= 参数 < X-NCM-Cookie 头 < NCM_SHARED_COOKIE env < 浏览器 Cookie 头
  const envSharedCookie = process.env.NCM_SHARED_COOKIE || '';
  const browserCookie = req.headers.cookie || req.headers.Cookie || '';
  const customHeaderCookie =
    req.headers['x-ncm-cookie'] || req.headers['X-NCM-Cookie'] || '';
  const existingCookie = target.searchParams.get('cookie') || '';

  // 浏览器 cookie 里可能有 MUSIC_U / __csrf / NMTID 等，全部提取
  const browserCleaned = browserCookie
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');

  const mergedCookie = [
    existingCookie,
    customHeaderCookie,
    envSharedCookie,
    browserCleaned,
  ]
    .filter(Boolean)
    .join('; ');

  if (mergedCookie) {
    target.searchParams.set('cookie', mergedCookie);
  }
  // ========================

  // 构造转发 headers
  const headers = {};
  const hopByHop = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
  ]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (hopByHop.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'cookie') continue; // cookie 已通过 ?cookie= 传
    headers[k] = v;
  }
  headers['Host'] = target.hostname;

  const init = {
    method: req.method,
    headers,
    redirect: 'follow',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    return res.status(502).json({
      code: 502,
      msg: 'Bad Gateway',
      error: String(err && err.message ? err.message : err),
    });
  }

  // 复制响应
  const respHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (hopByHop.has(k.toLowerCase())) continue;
    respHeaders[k] = v;
  }
  // 覆盖 CORS
  respHeaders['Access-Control-Allow-Origin'] = '*';
  respHeaders['Access-Control-Allow-Credentials'] = 'true';
  delete respHeaders['set-cookie']; // 不让上游 cookie 污染浏览器

  res.status(upstream.status);
  for (const [k, v] of Object.entries(respHeaders)) {
    res.setHeader(k, v);
  }

  const text = await upstream.text();
  return res.send(text);
};
