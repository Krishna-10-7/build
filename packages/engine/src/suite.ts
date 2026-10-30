import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Baseline, Contract, LocatorMap, type GateResult } from '@sentinelqa/core';
import { LOC_HELPER, PLAYWRIGHT_CONFIG, generateSpec, sha256 } from './codegen.ts';

/**
 * One folder per ticket:
 *   contract.json      compiled criteria (editable before generation)
 *   <TICKET>.spec.ts   generated Playwright spec, hash-locked
 *   loc.ts             locator helper the spec imports
 *   locators.json      key -> locator; the only file a heal writes
 *   baseline.json      fingerprints and effects from the last green baseline run
 *   spec.lock.json     sha256 of the spec and the contract it came from
 */
export class Suite {
  constructor(readonly dir: string, readonly ticket: string) {}

  static at(root: string, ticket: string): Suite {
    return new Suite(join(root, ticket), ticket);
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  get specFile() {
    return this.path(`${this.ticket}.spec.ts`);
  }

  private async readJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(name: string, data: unknown) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(name), JSON.stringify(data, null, 2) + '\n');
  }

  async contract(): Promise<Contract | null> {
    const raw = await this.readJson<unknown>('contract.json');
    return raw ? Contract.parse(raw) : null;
  }

  async saveContract(c: Contract) {
    await this.writeJson('contract.json', Contract.parse(c));
  }

  async locators(): Promise<LocatorMap> {
    return LocatorMap.parse((await this.readJson<unknown>('locators.json')) ?? {});
  }

  async saveLocators(map: LocatorMap) {
    const sorted = Object.fromEntries(Object.entries(LocatorMap.parse(map)).sort(([a], [b]) => a.localeCompare(b)));
    await this.writeJson('locators.json', sorted);
  }

  async baseline(): Promise<Baseline | null> {
    const raw = await this.readJson<unknown>('baseline.json');
    return raw ? Baseline.parse(raw) : null;
  }

  async saveBaseline(b: Baseline) {
    await this.writeJson('baseline.json', Baseline.parse(b));
  }

  /** Writes the spec from the contract and locks its hash. */
  async generate(): Promise<{ file: string; sha256: string }> {
    const contract = await this.contract();
    if (!contract) throw new Error(`${this.ticket} has no contract yet`);
    const spec = generateSpec(contract);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.specFile, spec);
    await writeFile(this.path('loc.ts'), LOC_HELPER);
    await writeFile(this.path('playwright.config.ts'), PLAYWRIGHT_CONFIG);
    const lock = { spec: `${this.ticket}.spec.ts`, sha256: sha256(spec), contractSha256: sha256(JSON.stringify(contract)), at: new Date().toISOString() };
    await this.writeJson('spec.lock.json', lock);
    return { file: this.specFile, sha256: lock.sha256 };
  }

  /** Gate 1: the spec on disk is byte-for-byte what was generated from the current contract. */
  async verifySpec(): Promise<GateResult> {
    const lock = await this.readJson<{ sha256: string; contractSha256: string }>('spec.lock.json');
    if (!lock) return { ok: false, detail: 'no spec.lock.json; generate the spec first' };
    let spec: string;
    try {
      spec = await readFile(this.specFile, 'utf8');
    } catch {
      return { ok: false, detail: 'spec file is missing' };
    }
    const now = sha256(spec);
    if (now !== lock.sha256) return { ok: false, detail: `spec hash changed: ${now.slice(0, 10)} != locked ${lock.sha256.slice(0, 10)}` };
    const contract = await this.contract();
    if (!contract || sha256(JSON.stringify(contract)) !== lock.contractSha256) {
      return { ok: false, detail: 'contract changed since the spec was generated' };
    }
    return { ok: true, detail: `unchanged (sha256 ${now.slice(0, 10)})` };
  }
}
