import { PRODUCTS, type Product, type CartLine, findProduct, lineTotal, rupees } from './store.ts';
import type { Flags } from './mutations.ts';

export interface PageCtx {
  cartCount: number;
  wishCount: number;
  flags: Flags;
}

/** D3 renames every presentational class. Script hooks use data-js and never change. */
function classes(flags: Flags) {
  return (name: string) => (flags.has('D3') ? `sl-${name}-v2` : name);
}

function style(flags: Flags): string {
  const c = classes(flags);
  return `
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1814; background: #faf8f5; }
  a { color: inherit; }
  .${c('site-header')} { display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; background: #fff; border-bottom: 1px solid #ebe4dc; }
  .${c('logo')} { font-weight: 700; text-decoration: none; font-size: 18px; }
  .${c('site-nav')} { display: flex; gap: 18px; align-items: center; }
  .${c('site-nav')} a { text-decoration: none; }
  .${c('badge')} { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; background: #d9652f; color: #fff; font-size: 12px; text-align: center; }
  .${c('page')} { max-width: 880px; margin: 32px auto; padding: 0 20px; }
  .${c('grid')} { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .${c('card')} { background: #fff; border: 1px solid #ebe4dc; border-radius: 10px; padding: 20px; }
  .${c('price')} { font-size: 20px; font-weight: 600; }
  .${c('field')} { display: grid; gap: 4px; margin: 12px 0; max-width: 320px; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #cfc6bc; border-radius: 6px; }
  .${c('actions')} { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .${c('btn')} { font: inherit; padding: 9px 16px; border-radius: 6px; border: 1px solid #cfc6bc; background: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
  .${c('btn-primary')} { background: #d9652f; border-color: #d9652f; color: #fff; }
  .${c('btn')}:disabled { opacity: .5; cursor: not-allowed; }
  .${c('cart-items')} { list-style: none; padding: 0; }
  .${c('cart-item')} { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ebe4dc; }
  .${c('status')} { min-height: 24px; font-weight: 600; }
  .${c('sticky-buy')} { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 28px; background: #fff; border-top: 1px solid #ebe4dc; display: flex; justify-content: flex-end; }
  .${c('promo-overlay')} { position: fixed; inset: 0; background: rgba(28, 24, 20, .04); z-index: 10; }
  .${c('promo-overlay')} p { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); background: #fff; padding: 8px 14px; border-radius: 8px; border: 1px solid #ebe4dc; }
`;
}

/** D1 and the R4 redesign rename test ids. */
function testid(flags: Flags, id: string): string {
  if (flags.has('R4')) return ({ 'add-to-cart': 'add-item', 'cart-badge': 'nav-count' } as Record<string, string>)[id] ?? id;
  if (flags.has('D12') && id === 'add-to-cart') return 'add-to-cart-btn';
  if (flags.has('D1')) return ({ 'add-to-cart': 'btn-add-cart', 'cart-badge': 'bag-count', 'place-order': 'submit-order' } as Record<string, string>)[id] ?? id;
  return id;
}

/** D2 removes element ids; labels then fall back to wrapping. */
function idAttr(flags: Flags, id: string): string {
  return flags.has('D2') ? '' : ` id="${id}"`;
}

function layout(title: string, ctx: PageCtx, body: string, script = '', after = ''): string {
  const c = classes(ctx.flags);
  const f = ctx.flags;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ShopLite</title>
<style>${style(f)}</style>
</head>
<body>
<header class="${c('site-header')}">
  <a href="/" class="${c('logo')}">ShopLite</a>
  <nav class="${c('site-nav')}" aria-label="Main">
    <a href="/wishlist" class="${c('wish-link')}">Wishlist <span class="${c('badge')}" data-js="wish-count" data-testid="${testid(f, 'wish-badge')}">${ctx.wishCount}</span></a>
    <a href="/cart" class="${c('cart-link')}">Cart <span class="${c('badge')}" data-js="cart-count" data-testid="${testid(f, 'cart-badge')}">${ctx.cartCount}</span></a>
  </nav>
</header>
<main class="${c('page')}">
${f.has('D11') ? `<div class="${c('page-inner')}"><div class="${c('layout')}">\n${body}\n</div></div>` : body}
</main>
${after}
<script>
const track = (event) => fetch('/api/analytics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, path: location.pathname }) }).catch(() => {});
const hook = (name) => document.querySelector('[data-js="' + name + '"]');
track('view');
${script}
</script>
</body>
</html>`;
}

export function homePage(ctx: PageCtx): string {
  const c = classes(ctx.flags);
  const cards = PRODUCTS.map(
    (p) => `<article class="${c('card')}">
    <h2><a href="/product/${p.slug}">${p.name}</a></h2>
    <p>${p.blurb}</p>
    <p class="${c('price')}">${rupees(p.price)}</p>
  </article>`,
  ).join('\n');
  return layout('Home', ctx, `<h1>New in</h1>\n<section class="${c('grid')}" aria-label="Products">\n${cards}\n</section>`);
}

export function productPage(p: Product, ctx: PageCtx): string {
  const f = ctx.flags;
  const c = classes(f);
  const cartLabel = f.has('R4') ? 'Add to wishlist' : f.has('D4') ? 'Add to bag' : 'Add to cart';
  const wishLabel = f.has('R4') ? 'Add to cart' : 'Add to wishlist';

  let addBtn = '';
  if (!f.has('R1')) {
    const attrs = `class="${c('btn')} ${c('btn-primary')}" data-testid="${testid(f, 'add-to-cart')}" data-action="cart"${f.has('R2') ? ' disabled' : ''}`;
    addBtn = f.has('D7') ? `<a href="#" role="button" ${attrs}>${cartLabel}</a>` : `<button ${attrs}>${cartLabel}</button>`;
    if (f.has('D5')) addBtn = `<div class="${c('btn-wrap')}"><span class="${c('btn-inner')}">${addBtn}</span></div>`;
  }
  const saveBtn = `<button class="${c('btn')}" data-action="saved">Save for later</button>`;
  const wishBtn = `<button class="${c('btn')}" data-action="wishlist">${wishLabel}</button>`;
  const decoy = f.has('D12') ? `<button class="${c('btn')} ${c('btn-primary')}" data-testid="add-to-compare" data-action="compare">Add to compare</button>` : '';
  const inline = f.has('D6') ? '' : addBtn;
  const buttons = f.has('D8') ? [saveBtn, wishBtn, decoy, inline] : [decoy, inline, saveBtn, wishBtn];
  const section = f.has('D11') ? 'article' : 'section';

  const body = `<${section} class="${c('card')} ${c('product')}" aria-labelledby="product-title">
  <h1 id="product-title">${p.name}</h1>
  <p>${p.blurb}</p>
  <p class="${c('price')}">${rupees(p.price)}</p>
  <div class="${c('field')}">
    <label${f.has('D2') ? '' : ' for="qty"'}>Quantity${f.has('D2') ? ` <input name="qty" data-js="qty" type="number" min="1" value="1" placeholder="Qty">` : ''}</label>
    ${f.has('D2') ? '' : `<input${idAttr(f, 'qty')} name="qty" data-js="qty" type="number" min="1" value="1" placeholder="${f.has('D10') ? 'How many?' : 'Qty'}">`}
  </div>
  <div class="${c('actions')}">
    ${buttons.filter(Boolean).join('\n    ')}
  </div>
  <p class="${c('status')}" role="status"${idAttr(f, 'product-msg')} data-js="product-msg"></p>
</${section}>`;

  const sticky = f.has('D6') && addBtn ? `<footer class="${c('sticky-buy')}">${addBtn}</footer>` : '';
  const overlay = f.has('R7') ? `<div class="${c('promo-overlay')}"><p>Free shipping this week</p></div>` : '';

  // Button behaviour lives in a table so mutations can swap or break handlers.
  const cartHandler = f.has('R3')
    ? `async (qty) => {
    await post('/api/cart/item', { slug, qty });
    const badge = hook('cart-count');
    badge.textContent = Number(badge.textContent) + qty;
    msg.textContent = 'Added to cart';
  }`
    : `async (qty) => {
    const res = await post('/api/cart/items', { slug, qty });
    hook('cart-count').textContent = res.count;
    msg.textContent = 'Added to cart';
  }`;
  const script = `
const slug = ${JSON.stringify(p.slug)};
const msg = hook('product-msg');
const post = (url, data) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then((r) => r.json());
const handlers = {
  cart: ${cartHandler},
  wishlist: async () => {
    const res = await post('/api/wishlist', { slug });
    hook('wish-count').textContent = res.count;
    msg.textContent = 'Added to wishlist';
  },
  saved: async () => {
    await post('/api/saved', { slug });
    msg.textContent = 'Saved for later';
  },
  compare: async () => {
    await post('/api/compare', { slug });
    msg.textContent = 'Added to compare';
  },
};
document.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async (e) => {
  e.preventDefault();
  const action = btn.dataset.action;
  track('click:' + action);
  const qty = Math.max(1, parseInt(hook('qty').value, 10) || 1);
  await handlers[action](qty);
}));`;
  return layout(p.name, ctx, body, script, sticky + overlay);
}

export function cartPage(lines: CartLine[], total: number, ctx: PageCtx): string {
  const f = ctx.flags;
  const c = classes(f);
  const items = lines
    .map((l) => {
      const p = findProduct(l.slug);
      return `<li class="${c('cart-item')}" data-line="${l.id}">
      <span>${p?.name ?? l.slug} × ${l.qty}</span>
      <span>${rupees(lineTotal(l))}</span>
      <button class="${c('btn')}" data-remove="${l.id}">Remove</button>
    </li>`;
    })
    .join('\n');
  const checkout = f.has('D9')
    ? `<a class="${c('btn')} ${c('btn-primary')}" href="/checkout" aria-label="Proceed to checkout">→</a>`
    : `<a class="${c('btn')} ${c('btn-primary')}" href="/checkout">Checkout</a>`;
  const section = f.has('D11') ? 'article' : 'section';
  const body = `<${section} class="${c('card')} ${c('cart')}" aria-labelledby="cart-title">
  <h1 id="cart-title">Your cart</h1>
  ${lines.length ? `<ul class="${c('cart-items')}">\n${items}\n</ul>` : `<p class="${c('empty')}">Your cart is empty</p>`}
  <p>Total: <strong${idAttr(f, 'cart-total')}>${rupees(total)}</strong></p>
  <div class="${c('actions')}">
    ${checkout}
  </div>
</${section}>`;
  const script = `
document.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
  await fetch('/api/cart/items/' + btn.dataset.remove, { method: 'DELETE' });
  location.reload();
}));`;
  return layout('Cart', ctx, body, script);
}

export function checkoutPage(ctx: PageCtx): string {
  const f = ctx.flags;
  const c = classes(f);
  const field = (id: string, label: string, attrs: string, placeholder: string) =>
    f.has('D2')
      ? `<label class="${c('field')}">${label} <input ${attrs} placeholder="${placeholder}"></label>`
      : `<div class="${c('field')}">
      <label for="${id}">${label}</label>
      <input id="${id}" ${attrs} placeholder="${placeholder}">
    </div>`;
  const section = f.has('D11') ? 'article' : 'section';
  const body = `<${section} class="${c('card')}" aria-labelledby="checkout-title">
  <h1 id="checkout-title">Checkout</h1>
  <form class="${c('checkout-form')}" data-js="checkout" novalidate>
    ${field('name', 'Full name', 'name="name" autocomplete="name"', f.has('D10') ? 'e.g. Asha Rao' : 'Your name')}
    ${field('email', 'Email', 'name="email" type="email" autocomplete="email"', f.has('D10') ? 'name@domain.com' : 'you@example.com')}
    <div class="${c('actions')}">
      <button class="${c('btn')} ${c('btn-primary')}" type="submit" data-testid="${testid(f, 'place-order')}">Place order</button>
    </div>
  </form>
  ${f.has('R8') ? '' : `<p class="${c('status')}" role="status"${idAttr(f, 'order-msg')} data-js="order-msg"></p>`}
</${section}>`;
  const script = `
const form = hook('checkout');
const out = hook('order-msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const res = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) hook('cart-count').textContent = '0';
  if (!out) return;
  out.textContent = res.ok ? 'Order placed. Your order number is ' + body.id + '.' : (body.error || 'Something went wrong');
});`;
  return layout('Checkout', ctx, body, script);
}

export function wishlistPage(slugs: string[], ctx: PageCtx): string {
  const c = classes(ctx.flags);
  const items = slugs.map((s) => `<li>${findProduct(s)?.name ?? s}</li>`).join('');
  return layout('Wishlist', ctx, `<section class="${c('card')}"><h1>Wishlist</h1>${items ? `<ul>${items}</ul>` : '<p>Nothing here yet</p>'}</section>`);
}

export function notFoundPage(ctx: PageCtx): string {
  return layout('Not found', ctx, '<h1>Page not found</h1>');
}
