import { z } from 'zod';

/**
 * How a key is found on the page. locators.json maps keys to these entries,
 * and it is the only file the healer is allowed to change.
 */
export const LocatorEntry = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('testid'), value: z.string() }),
  z.object({ strategy: z.literal('role'), role: z.string(), name: z.string() }),
  z.object({ strategy: z.literal('label'), name: z.string() }),
  z.object({ strategy: z.literal('id'), value: z.string() }),
  z.object({ strategy: z.literal('css'), selector: z.string() }),
]);
export type LocatorEntry = z.infer<typeof LocatorEntry>;

export const LocatorMap = z.record(z.string(), LocatorEntry);
export type LocatorMap = z.infer<typeof LocatorMap>;

export function describeLocator(e: LocatorEntry): string {
  switch (e.strategy) {
    case 'testid':
      return `testid=${e.value}`;
    case 'role':
      return `role=${e.role}[name="${e.name}"]`;
    case 'label':
      return `label="${e.name}"`;
    case 'id':
      return `#${e.value}`;
    case 'css':
      return e.selector;
  }
}

/** What an element looked like on the last green run. Used to find it again after it moves. */
export const Fingerprint = z.object({
  role: z.string(),
  name: z.string(),
  text: z.string(),
  near: z.string(),
  landmarks: z.array(z.string()),
  testid: z.string(),
  tag: z.string(),
  id: z.string(),
  type: z.string(),
  attrName: z.string(),
  href: z.string(),
  placeholder: z.string(),
  index: z.number(),
  siblings: z.number(),
  visible: z.boolean(),
  enabled: z.boolean(),
});
export type Fingerprint = z.infer<typeof Fingerprint>;

/** What an action step caused: API calls, URL change and the watched elements' text. */
export const EffectSignature = z.object({
  requests: z.array(z.string()),
  urlBefore: z.string(),
  urlAfter: z.string(),
  watched: z.record(z.string(), z.object({ before: z.string(), after: z.string() })),
});
export type EffectSignature = z.infer<typeof EffectSignature>;

export const Baseline = z.object({
  ticket: z.string(),
  recordedAt: z.string(),
  target: z.string(),
  fingerprints: z.record(z.string(), Fingerprint),
  /** Keyed by `AC-1#2`: criterion id and step index. */
  effects: z.record(z.string(), EffectSignature),
});
export type Baseline = z.infer<typeof Baseline>;
