// Cloudflare Pages Function: Catch-all /api/* proxy -> NCM API Enhanced
// Paths: /api/:path*
// 除 /api/unblock 单独处理外，其余 API 请求通过 Cloudflare 边缘代理到 NCM API Enhanced
// 好处：用户手机只访问 Cloudflare（国内电信网络比 Vercel 稳定得多），
//       Cloudflare -> Vercel 走机房骨干不受运营商限制。

const NCM_API_BASE = 'https://api-enhanced-sooty-six.vercel.app';

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // 构造转发 URL：保留 pathname 后缀和 query
  const target = new URL(url.pathname.replace(/^\/api/, '') + url.search, NCM_API_BASE);

  // 构造转发请求：保留方法、headers（剔除受管制的 hop-by-hop 头）、body
  const headers = new Headers(request.headers);
  const restricted = [
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'origin',
    'referer',
  ];
  for (const h of restricted) headers.delete(h);
  headers.set('Host', target.hostname);
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');

  // 登录态传递处理（优先高覆盖顺序）：
  // 1) cookie 请求头（浏览器同源 withCredentials） -> 提取 MUSIC_U 附加为 query
  // 2) X-NCM-Cookie 自定义头
  // 3) URL 上已有的 cookie= 查询参数
  const cookieHeader = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const musicUMatch = cookieHeader.match(/(?:^|;\s*)MUSIC_U=([^;]+)/);
  const musicUFromCookie = musicUMatch ? decodeURIComponent(musicUMatch[1]) : '';
  const ncmCookieHeader =
    request.headers.get('X-NCM-Cookie') ||
    request.headers.get('x-ncm-cookie') ||
    '';
  const existingCookie = target.searchParams.get('cookie') || '';
  const mergedCookie = [existingCookie, ncmCookieHeader, musicUFromCookie ? `MUSIC_U=${musicUFromCookie}` : '']
    .filter(Boolean)
    .join('; ');
  if (mergedCookie) {
    target.searchParams.set('cookie', mergedCookie);
  }
  // 转发阶段删除 set-cookie 头的上游合并（cookie 本身会被 NCM 当作 ?cookie= 读取）
  headers.delete('cookie');
  headers.delete('set-cookie');

  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  let resp;
  try {
    resp = await fetch(target.toString(), init);
  } catch (err) {
    return new Response(
      JSON.stringify({
        code: 502,
        msg: 'Bad Gateway: upstream NCM API request failed',
        error: String(err && err.message ? err.message : err),
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': url.origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        },
      }
    );
  }

  // 构建响应：复制 body、status，清除部分响应头，并添加 CORS
  const respHeaders = new Headers(resp.headers);
  for (const h of restricted) respHeaders.delete(h);
  respHeaders.set('Access-Control-Allow-Origin', url.origin || '*');
  respHeaders.set('Access-Control-Allow-Credentials', 'true');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, X-NCM-Cookie');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.delete('content-security-policy');
  respHeaders.delete('content-security-policy-report-only');

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}
