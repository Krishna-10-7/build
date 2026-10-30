export interface Product {
  slug: string;
  name: string;
  price: number;
  blurb: string;
}

export const PRODUCTS: Product[] = [
  { slug: 'clay-mug', name: 'Clay Mug', price: 349, blurb: 'Hand-thrown stoneware, 350 ml.' },
  { slug: 'linen-tote', name: 'Linen Tote', price: 599, blurb: 'Washed linen with a leather strap.' },
  { slug: 'brass-lamp', name: 'Brass Lamp', price: 1299, blurb: 'Warm desk light with a dimmer.' },
];

export function findProduct(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

export interface CartLine {
  id: number;
  slug: string;
  qty: number;
}

interface Session {
  cart: CartLine[];
  wishlist: Set<string>;
  saved: Set<string>;
}

const sessions = new Map<string, Session>();
let nextLineId = 1;
let nextOrderId = 1001;

export function session(sid: string): Session {
  let s = sessions.get(sid);
  if (!s) {
    s = { cart: [], wishlist: new Set(), saved: new Set() };
    sessions.set(sid, s);
  }
  return s;
}

export function addToCart(sid: string, slug: string, qty: number): CartLine {
  const cart = session(sid).cart;
  const existing = cart.find((l) => l.slug === slug);
  if (existing) {
    existing.qty += qty;
    return existing;
  }
  const line = { id: nextLineId++, slug, qty };
  cart.push(line);
  return line;
}

export function removeLine(sid: string, id: number): boolean {
  const cart = session(sid).cart;
  const i = cart.findIndex((l) => l.id === id);
  if (i < 0) return false;
  cart.splice(i, 1);
  return true;
}

export function cartCount(sid: string): number {
  return session(sid).cart.reduce((n, l) => n + l.qty, 0);
}

export function lineTotal(line: CartLine): number {
  return (findProduct(line.slug)?.price ?? 0) * line.qty;
}

export function cartTotal(sid: string): number {
  return session(sid).cart.reduce((n, l) => n + lineTotal(l), 0);
}

export function placeOrder(sid: string): number {
  session(sid).cart = [];
  return nextOrderId++;
}

export function rupees(n: number): string {
  return '₹' + n.toLocaleString('en-IN');
}
