import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInstallFromLock } from '../src/install.ts';
import * as localLock from '../src/local-lock.ts';
import * as add from '../src/add.ts';

vi.mock('../src/local-lock.ts');
vi.mock('../src/add.ts');
vi.mock('../src/sync.ts', () => ({
  runSync: vi.fn(),
  parseSyncOptions: vi.fn().mockReturnValue({ options: {} }),
}));
vi.mock('../src/agents.ts', () => ({
  getUniversalAgents: vi.fn().mockReturnValue(['cursor']),
}));

describe('runInstallFromLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(add.installFromSourceDetails).mockResolvedValue({
      installed: ['skill-a'],
      failed: [],
      repoPaths: { 'skill-a': 'skills/skill-a/SKILL.md' },
      hashes: { 'skill-a': 'hash' },
    });
    vi.mocked(add.restoreWellKnownSkills).mockResolvedValue({
      installed: [],
      missing: [],
      ambiguous: [],
      failed: [],
      digests: {},
      hashes: {},
    });
  });

  it('restores self-hosted GitLab project locks from sourceUrl', async () => {
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-a': {
          source: 'acme/skills',
          sourceUrl: 'https://gitlab.example.com/acme/skills.git',
          sourceType: 'git',
          skillPath: 'skills/skill-a/SKILL.md',
          computedHash: 'hash',
        },
      },
    });

    await runInstallFromLock([]);

    expect(add.installFromSourceDetails).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://gitlab.example.com/acme/skills.git' }),
      expect.objectContaining({
        agents: ['cursor'],
        includeInternal: true,
        fullDepth: true,
      })
    );
  });

  it('does not restore generic git shorthands as GitHub without sourceUrl', async () => {
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-a': {
          source: 'acme/skills',
          sourceType: 'git',
          skillPath: 'skills/skill-a/SKILL.md',
          computedHash: 'hash',
        },
      },
    });

    await runInstallFromLock([]);

    expect(add.installFromSourceDetails).not.toHaveBeenCalled();
  });

  it('restores well-known sources without exiting on a missing skill', async () => {
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'skill-a': {
          source: 'example.com',
          sourceUrl: 'https://example.com',
          sourceType: 'well-known',
          computedHash: 'hash',
          wellKnownDigest: 'sha256:old',
        },
      },
    });
    vi.mocked(add.restoreWellKnownSkills).mockResolvedValue({
      installed: ['skill-a'],
      missing: [],
      ambiguous: [],
      failed: [],
      digests: { 'skill-a': 'sha256:new' },
      hashes: { 'skill-a': 'new-hash' },
    });

    await runInstallFromLock([]);

    expect(add.installFromSourceDetails).not.toHaveBeenCalled();
    expect(add.restoreWellKnownSkills).toHaveBeenCalledWith(
      'https://example.com',
      ['skill-a'],
      ['cursor']
    );
    expect(localLock.addSkillsToLocalLock).toHaveBeenCalledWith(
      {
        'skill-a': expect.objectContaining({
          sourceType: 'well-known',
          computedHash: 'new-hash',
          wellKnownDigest: 'sha256:new',
        }),
      },
      expect.any(String)
    );
  });

  it('restores every skill from one repository with a single source install', async () => {
    const entry = {
      source: 'acme/skills',
      sourceType: 'github',
      computedHash: 'hash',
    };
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        alpha: { ...entry, skillPath: 'skills/alpha/SKILL.md' },
        beta: { ...entry, skillPath: 'skills/beta/SKILL.md' },
      },
    });
    vi.mocked(add.installFromSourceDetails).mockResolvedValue({
      installed: ['alpha', 'beta'],
      failed: [],
      repoPaths: { alpha: 'skills/alpha/SKILL.md', beta: 'skills/beta/SKILL.md' },
      hashes: { alpha: 'hash', beta: 'hash' },
    });

    await runInstallFromLock([]);

    expect(add.installFromSourceDetails).toHaveBeenCalledTimes(1);
  });
});
