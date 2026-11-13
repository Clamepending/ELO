// Serves the static site and one route: /api/gphoto, a pass-through for Google
// Photos Picker downloads, whose URLs reject browser CORS preflights. It only
// forwards GETs to https://*.googleusercontent.com with the caller's own bearer
// token, streams the response back, and stores nothing.

const ALLOWED_HOST = /\.googleusercontent\.com$/;

async function proxyPhoto(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return new Response('Missing token', { status: 401 });
  let target;
  try { target = new URL(new URL(request.url).searchParams.get('u')); } catch { return new Response('Bad url', { status: 400 }); }
  if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) return new Response('Host not allowed', { status: 403 });

  const upstream = await fetch(target, { headers: { authorization: auth }, redirect: 'follow' });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/gphoto') return proxyPhoto(request);
    return env.ASSETS.fetch(request);
  },
};
