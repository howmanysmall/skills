import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restoreWellKnownSkills } from '../src/add.ts';
import { getUniversalAgents } from '../src/agents.ts';
import { wellKnownProvider, type WellKnownSkill } from '../src/providers/index.ts';

function fixture(installName: string): WellKnownSkill {
  return {
    name: installName,
    installName,
    description: `${installName} description`,
    content: `---\nname: ${installName}\ndescription: d\n---\n# ${installName}\n`,
    sourceUrl: `https://example.com/${installName}/SKILL.md`,
    providerId: 'well-known',
    sourceIdentifier: 'example.com',
    files: new Map([
      ['SKILL.md', `---\nname: ${installName}\ndescription: d\n---\n# ${installName}\n`],
    ]),
    indexEntry: {
      name: installName,
      type: 'skill-md',
      description: 'd',
      url: `https://example.com/${installName}/SKILL.md`,
      digest: `sha256:${installName}`,
    } as WellKnownSkill['indexEntry'],
  };
}

describe('restoreWellKnownSkills', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'skills-wellknown-restore-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it('restores published skills and reports a missing one without exiting', async () => {
    vi.spyOn(wellKnownProvider, 'fetchAllSkills').mockResolvedValue([
      fixture('alpha'),
      fixture('beta'),
    ]);

    const result = await restoreWellKnownSkills(
      'https://example.com',
      ['alpha', 'removed-skill'],
      getUniversalAgents().slice(0, 2),
      { cwd }
    );

    expect(result.installed).toEqual(['alpha']);
    expect(result.missing).toEqual(['removed-skill']);
    expect(result.error).toBeUndefined();
    expect(existsSync(join(cwd, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(result.hashes.alpha).toMatch(/^[a-f0-9]{64}$/);
    expect(result.digests.alpha).toBe('sha256:alpha');

    const installed = await readFile(join(cwd, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf-8');
    expect(installed).toContain('# alpha');
    expect(existsSync(join(cwd, '.agents', 'skills', 'removed-skill'))).toBe(false);
  });

  it('reports a source that has no reachable index as an error', async () => {
    vi.spyOn(wellKnownProvider, 'fetchAllSkills').mockResolvedValue([]);

    const result = await restoreWellKnownSkills(
      'https://example.com',
      ['alpha'],
      getUniversalAgents().slice(0, 1),
      { cwd }
    );

    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(['alpha']);
  });
});
