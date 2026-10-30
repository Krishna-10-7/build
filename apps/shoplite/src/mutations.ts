export interface Mutation {
  id: string;
  kind: 'drift' | 'regression';
  title: string;
}

/**
 * Drifts change how the page looks or is built but not what it does; a good healer
 * should recover. Regressions break behaviour; a healer must never paper over them.
 */
export const MUTATIONS: Mutation[] = [
  { id: 'D1', kind: 'drift', title: 'data-testid values renamed' },
  { id: 'D2', kind: 'drift', title: 'Element ids removed' },
  { id: 'D3', kind: 'drift', title: 'CSS class names changed' },
  { id: 'D4', kind: 'drift', title: '"Add to cart" relabelled "Add to bag"' },
  { id: 'D5', kind: 'drift', title: 'Add to cart wrapped in extra elements' },
  { id: 'D6', kind: 'drift', title: 'Add to cart moved to a sticky footer' },
  { id: 'D7', kind: 'drift', title: '<button> became <a role="button">' },
  { id: 'D8', kind: 'drift', title: 'Product action buttons reordered' },
  { id: 'D9', kind: 'drift', title: 'Checkout link became an icon with an aria-label' },
  { id: 'D10', kind: 'drift', title: 'Field placeholders changed, labels kept' },
  { id: 'D11', kind: 'drift', title: 'Page containers restructured' },
  { id: 'D12', kind: 'drift', title: 'Test id renamed and a similar decoy button added' },
  { id: 'R1', kind: 'regression', title: 'Add to cart button removed' },
  { id: 'R2', kind: 'regression', title: 'Add to cart permanently disabled' },
  { id: 'R3', kind: 'regression', title: 'Add to cart calls the wrong endpoint' },
  { id: 'R4', kind: 'regression', title: 'Test ids renamed and Add to cart / Add to wishlist labels swapped' },
  { id: 'R5', kind: 'regression', title: 'Cart total ignores quantity' },
  { id: 'R6', kind: 'regression', title: 'Order API returns 500' },
  { id: 'R7', kind: 'regression', title: 'Add to cart covered by an overlay' },
  { id: 'R8', kind: 'regression', title: 'Order confirmation never appears' },
];

const KNOWN = new Set(MUTATIONS.map((m) => m.id));

export type Flags = ReadonlySet<string>;

export function parseFlags(value: string | undefined): Flags {
  return new Set((value ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => KNOWN.has(s)));
}
