import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as store from './store.ts';
import * as pages from './pages.ts';

const PORT = Number(process.env.SHOPLITE_PORT ?? 4100);

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), 'application/json');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const jar = cookies(req);
  let sid = jar.sl_sid;
  if (!sid) {
    sid = randomUUID();
    res.setHeader('set-cookie', `sl_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  const s = store.session(sid);
  const ctx = () => ({ cartCount: store.cartCount(sid), wishCount: s.wishlist.size });
  const method = req.method ?? 'GET';
  const path = url.pathname;

  try {
    if (method === 'GET' && path === '/') return send(res, 200, pages.homePage(ctx()));
    if (method === 'GET' && path.startsWith('/product/')) {
      const p = store.findProduct(path.slice('/product/'.length));
      return p ? send(res, 200, pages.productPage(p, ctx())) : send(res, 404, pages.notFoundPage(ctx()));
    }
    if (method === 'GET' && path === '/cart') return send(res, 200, pages.cartPage(s.cart, store.cartTotal(sid), ctx()));
    if (method === 'GET' && path === '/checkout') return send(res, 200, pages.checkoutPage(ctx()));
    if (method === 'GET' && path === '/wishlist') return send(res, 200, pages.wishlistPage([...s.wishlist], ctx()));
    if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });

    if (method === 'GET' && path === '/api/products') return json(res, 200, store.PRODUCTS);
    if (method === 'GET' && path === '/api/cart') {
      return json(res, 200, { items: s.cart, count: store.cartCount(sid), total: store.cartTotal(sid) });
    }
    if (method === 'POST' && path === '/api/cart/items') {
      const body = await readJson(req);
      const slug = String(body.slug ?? '');
      if (!store.findProduct(slug)) return json(res, 400, { error: 'Unknown product' });
      const qty = Math.max(1, Math.min(99, Number(body.qty) || 1));
      const line = store.addToCart(sid, slug, qty);
      return json(res, 201, { line, count: store.cartCount(sid) });
    }
    if (method === 'DELETE' && path.startsWith('/api/cart/items/')) {
      const ok = store.removeLine(sid, Number(path.split('/').pop()));
      return json(res, ok ? 200 : 404, { count: store.cartCount(sid) });
    }
    if (method === 'POST' && path === '/api/wishlist') {
      const body = await readJson(req);
      s.wishlist.add(String(body.slug ?? ''));
      return json(res, 201, { count: s.wishlist.size });
    }
    if (method === 'POST' && path === '/api/saved') {
      const body = await readJson(req);
      s.saved.add(String(body.slug ?? ''));
      return json(res, 201, { count: s.saved.size });
    }
    if (method === 'POST' && path === '/api/orders') {
      const body = await readJson(req);
      if (!s.cart.length) return json(res, 400, { error: 'Your cart is empty' });
      if (!String(body.name ?? '').trim() || !String(body.email ?? '').includes('@')) {
        return json(res, 422, { error: 'Enter your name and a valid email' });
      }
      return json(res, 201, { id: store.placeOrder(sid) });
    }
    if (method === 'POST' && path === '/api/analytics') {
      await readJson(req);
      res.writeHead(204).end();
      return;
    }
    send(res, 404, pages.notFoundPage(ctx()));
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, () => console.log(`ShopLite on http://localhost:${PORT}`));
