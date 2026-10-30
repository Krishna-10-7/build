import { PRODUCTS, type Product, type CartLine, findProduct, lineTotal, rupees } from './store.ts';

export interface PageCtx {
  cartCount: number;
  wishCount: number;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1814; background: #faf8f5; }
  a { color: inherit; }
  .site-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; background: #fff; border-bottom: 1px solid #ebe4dc; }
  .logo { font-weight: 700; text-decoration: none; font-size: 18px; }
  .site-nav { display: flex; gap: 18px; align-items: center; }
  .site-nav a { text-decoration: none; }
  .badge { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; background: #d9652f; color: #fff; font-size: 12px; text-align: center; }
  .page { max-width: 880px; margin: 32px auto; padding: 0 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #ebe4dc; border-radius: 10px; padding: 20px; }
  .price { font-size: 20px; font-weight: 600; }
  .field { display: grid; gap: 4px; margin: 12px 0; max-width: 320px; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #cfc6bc; border-radius: 6px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .btn { font: inherit; padding: 9px 16px; border-radius: 6px; border: 1px solid #cfc6bc; background: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn-primary { background: #d9652f; border-color: #d9652f; color: #fff; }
  .cart-items { list-style: none; padding: 0; }
  .cart-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ebe4dc; }
  .status { min-height: 24px; font-weight: 600; }
`;

function layout(title: string, ctx: PageCtx, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ShopLite</title>
<style>${STYLE}</style>
</head>
<body>
<header class="site-header">
  <a href="/" class="logo">ShopLite</a>
  <nav class="site-nav" aria-label="Main">
    <a href="/wishlist" class="wish-link">Wishlist <span class="badge" data-testid="wish-badge">${ctx.wishCount}</span></a>
    <a href="/cart" class="cart-link">Cart <span class="badge" data-testid="cart-badge">${ctx.cartCount}</span></a>
  </nav>
</header>
<main class="page">
${body}
</main>
<script>
const track = (event) => fetch('/api/analytics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, path: location.pathname }) }).catch(() => {});
track('view');
${script}
</script>
</body>
</html>`;
}

export function homePage(ctx: PageCtx): string {
  const cards = PRODUCTS.map(
    (p) => `<article class="card">
    <h2><a href="/product/${p.slug}">${p.name}</a></h2>
    <p>${p.blurb}</p>
    <p class="price">${rupees(p.price)}</p>
  </article>`,
  ).join('\n');
  return layout('Home', ctx, `<h1>New in</h1>\n<section class="grid" aria-label="Products">\n${cards}\n</section>`);
}

export function productPage(p: Product, ctx: PageCtx): string {
  const body = `<section class="card product" aria-labelledby="product-title">
  <h1 id="product-title">${p.name}</h1>
  <p>${p.blurb}</p>
  <p class="price">${rupees(p.price)}</p>
  <div class="field">
    <label for="qty">Quantity</label>
    <input id="qty" name="qty" type="number" min="1" value="1" placeholder="Qty">
  </div>
  <div class="actions">
    <button class="btn btn-primary" data-testid="add-to-cart" data-action="cart">Add to cart</button>
    <button class="btn" data-action="saved">Save for later</button>
    <button class="btn" data-action="wishlist">Add to wishlist</button>
  </div>
  <p class="status" role="status" id="product-msg"></p>
</section>`;
  const script = `
const slug = ${JSON.stringify(p.slug)};
const msg = document.getElementById('product-msg');
const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then((r) => r.json());
document.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async () => {
  const action = btn.dataset.action;
  track('click:' + action);
  const qty = Math.max(1, parseInt(document.getElementById('qty').value, 10) || 1);
  if (action === 'cart') {
    const res = await post('/api/cart/items', { slug, qty });
    document.querySelector('[data-testid="cart-badge"]').textContent = res.count;
    msg.textContent = 'Added to cart';
  } else if (action === 'wishlist') {
    const res = await post('/api/wishlist', { slug });
    document.querySelector('[data-testid="wish-badge"]').textContent = res.count;
    msg.textContent = 'Added to wishlist';
  } else {
    await post('/api/saved', { slug });
    msg.textContent = 'Saved for later';
  }
}));`;
  return layout(p.name, ctx, body, script);
}

export function cartPage(lines: CartLine[], total: number, ctx: PageCtx): string {
  const items = lines
    .map((l) => {
      const p = findProduct(l.slug);
      return `<li class="cart-item" data-line="${l.id}">
      <span>${p?.name ?? l.slug} × ${l.qty}</span>
      <span>${rupees(lineTotal(l))}</span>
      <button class="btn" data-remove="${l.id}">Remove</button>
    </li>`;
    })
    .join('\n');
  const body = `<section class="card cart" aria-labelledby="cart-title">
  <h1 id="cart-title">Your cart</h1>
  ${lines.length ? `<ul class="cart-items">\n${items}\n</ul>` : '<p class="empty">Your cart is empty</p>'}
  <p>Total: <strong id="cart-total">${rupees(total)}</strong></p>
  <div class="actions">
    <a class="btn btn-primary" href="/checkout">Checkout</a>
  </div>
</section>`;
  const script = `
document.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
  await fetch('/api/cart/items/' + btn.dataset.remove, { method: 'DELETE' });
  location.reload();
}));`;
  return layout('Cart', ctx, body, script);
}

export function checkoutPage(ctx: PageCtx): string {
  const body = `<section class="card" aria-labelledby="checkout-title">
  <h1 id="checkout-title">Checkout</h1>
  <form class="checkout-form" novalidate>
    <div class="field">
      <label for="name">Full name</label>
      <input id="name" name="name" autocomplete="name" placeholder="Your name">
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com">
    </div>
    <div class="actions">
      <button class="btn btn-primary" type="submit" data-testid="place-order">Place order</button>
    </div>
  </form>
  <p class="status" role="status" id="order-msg"></p>
</section>`;
  const script = `
const form = document.querySelector('.checkout-form');
const out = document.getElementById('order-msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const res = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  out.textContent = res.ok ? 'Order placed. Your order number is ' + body.id + '.' : (body.error || 'Something went wrong');
  if (res.ok) document.querySelector('[data-testid="cart-badge"]').textContent = '0';
});`;
  return layout('Checkout', ctx, body, script);
}

export function wishlistPage(slugs: string[], ctx: PageCtx): string {
  const items = slugs.map((s) => `<li>${findProduct(s)?.name ?? s}</li>`).join('');
  return layout('Wishlist', ctx, `<section class="card"><h1>Wishlist</h1>${items ? `<ul>${items}</ul>` : '<p>Nothing here yet</p>'}</section>`);
}

export function notFoundPage(ctx: PageCtx): string {
  return layout('Not found', ctx, '<h1>Page not found</h1>');
}
