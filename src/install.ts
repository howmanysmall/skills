import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readLocalLock, addSkillsToLocalLock, type LocalSkillLockEntry } from './local-lock.ts';
import { installFromSourceDetails, restoreWellKnownSkills, type InstallSpinner } from './add.ts';
import { runSync, parseSyncOptions } from './sync.ts';
import { getUniversalAgents } from './agents.ts';
import { buildLocalCloneSource, formatSourceInput } from './update-source.ts';
import { parseSource } from './source-parser.ts';
import { filterSkills } from './skills.ts';
import { normalizeSkillPath, resolveSkillLocations } from './skill-relocation.ts';
import type { AgentType, Skill } from './types.ts';

const DEFAULT_INSTALL_CONCURRENCY = 4;

/** How many repositories to fetch and install at once. */
function getInstallConcurrency(): number {
  const raw = process.env.SKILLS_INSTALL_CONCURRENCY;
  if (!raw) return DEFAULT_INSTALL_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INSTALL_CONCURRENCY;
}

/** Spinner that does nothing; concurrent sources cannot share a clack spinner. */
const silentSpinner: InstallSpinner = {
  start: () => {},
  message: () => {},
  stop: () => {},
};

interface LockedSourceGroup {
  /** Source shown in messages. */
  label: string;
  /** Value accepted by parseSource, including the ref. */
  installSource: string;
  entries: Record<string, LocalSkillLockEntry>;
  fullDepth: boolean;
  /** Whether an exact locked skillPath can be targeted in this source. */
  exactPathDisambiguates: boolean;
}

interface RestoreOutcome {
  /** Lock entries for skills that installed successfully. */
  lockUpdates: Record<string, LocalSkillLockEntry>;
  missing: string[];
  ambiguous: string[];
  failures: string[];
  error?: string;
  relocated: Array<{ name: string; from: string; to: string }>;
}

/**
 * Select the locked skills a source should install.
 *
 * An exact locked path wins; a skill that moved is found by its unique name;
 * a skill that is gone is reported instead of failing the whole restore.
 */
function selectLockedSkills(
  skills: Skill[],
  repoPaths: Record<string, string>,
  entries: Record<string, LocalSkillLockEntry>,
  exactPathDisambiguates: boolean
): { selected: Skill[]; resolution: Pick<RestoreOutcome, 'missing' | 'ambiguous' | 'relocated'> } {
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const relocated: RestoreOutcome['relocated'] = [];

  const discovered = Object.entries(repoPaths).map(([name, skillPath]) => ({ name, skillPath }));
  const locations = resolveSkillLocations(Object.keys(entries), entries, discovered, {
    exactPathDisambiguates,
  });

  const pathToSkill = new Map<string, Skill>();
  for (const [name, skillPath] of Object.entries(repoPaths)) {
    const skill = skills.find((candidate) => candidate.name === name);
    if (skill) pathToSkill.set(normalizeSkillPath(skillPath), skill);
  }

  const selected: Skill[] = [];
  const seen = new Set<string>();
  for (const [name, skillPath] of locations.resolvedPaths) {
    const skill = pathToSkill.get(normalizeSkillPath(skillPath));
    if (!skill) {
      missing.push(name);
      continue;
    }
    if (!seen.has(name)) {
      selected.push(skill);
      seen.add(name);
    }
    const from = entries[name]?.skillPath;
    if (from && normalizeSkillPath(from) !== normalizeSkillPath(skillPath)) {
      relocated.push({ name, from, to: skillPath });
    }
  }

  missing.push(...locations.deletedSkills);
  ambiguous.push(...locations.ambiguousSkills);

  // Entries recorded before skillPath tracking reinstall by name.
  for (const name of Object.keys(entries)) {
    if (entries[name]?.skillPath) continue;
    if (seen.has(name) || missing.includes(name)) continue;
    const match = filterSkills(skills, [name])[0];
    if (!match) {
      missing.push(name);
      continue;
    }
    selected.push(match);
    seen.add(name);
  }

  return { selected, resolution: { missing, ambiguous, relocated } };
}

/** Restore one repository's locked skills, cloning and discovering it once. */
async function restoreSourceGroup(
  group: LockedSourceGroup,
  agents: AgentType[]
): Promise<RestoreOutcome> {
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const relocated: RestoreOutcome['relocated'] = [];

  const details = await installFromSourceDetails(parseSource(group.installSource), {
    skills: [],
    agents,
    includeInternal: true,
    fullDepth: group.fullDepth,
    spinner: silentSpinner,
    select: async (skills, repoPaths) => {
      const selection = selectLockedSkills(
        skills,
        repoPaths,
        group.entries,
        group.exactPathDisambiguates
      );
      missing.push(...selection.resolution.missing);
      ambiguous.push(...selection.resolution.ambiguous);
      relocated.push(...selection.resolution.relocated);
      return selection.selected;
    },
  });

  const installed = new Set(details.installed);
  const lockUpdates: Record<string, LocalSkillLockEntry> = {};
  for (const [name, entry] of Object.entries(group.entries)) {
    if (!installed.has(name)) continue;
    lockUpdates[name] = {
      ...entry,
      ...(details.repoPaths[name] && { skillPath: details.repoPaths[name] }),
      ...(details.hashes[name] && { computedHash: details.hashes[name] }),
    };
  }

  return {
    lockUpdates,
    missing,
    ambiguous,
    failures: details.failed,
    error: details.error,
    relocated,
  };
}

/** Restore one well-known source without letting a missing skill exit the CLI. */
async function restoreWellKnownGroup(
  url: string,
  entries: Record<string, LocalSkillLockEntry>,
  agents: AgentType[]
): Promise<RestoreOutcome> {
  const details = await restoreWellKnownSkills(url, Object.keys(entries), agents);
  const lockUpdates: Record<string, LocalSkillLockEntry> = {};
  for (const name of details.installed) {
    lockUpdates[name] = {
      ...entries[name]!,
      ...(details.hashes[name] && { computedHash: details.hashes[name] }),
      ...(details.digests[name] && { wellKnownDigest: details.digests[name] }),
    };
  }
  return {
    lockUpdates,
    missing: details.missing,
    ambiguous: details.ambiguous,
    failures: details.failed,
    error: details.error,
    relocated: [],
  };
}

function reportOutcome(label: string, outcome: RestoreOutcome): void {
  if (outcome.error) {
    p.log.error(`Failed to install from ${pc.cyan(label)}: ${outcome.error}`);
    process.exitCode = 1;
  }
  for (const item of outcome.relocated) {
    p.log.info(`${pc.cyan(item.name)} moved to ${pc.dim(item.to)}`);
  }
  const restored = Object.keys(outcome.lockUpdates);
  if (restored.length > 0) {
    p.log.success(`Restored ${restored.map((name) => pc.cyan(name)).join(', ')}`);
  }
  for (const name of outcome.missing) {
    p.log.error(
      `Missing upstream: ${pc.cyan(name)} (${label}) — run ${pc.cyan(`skills remove ${name}`)} to drop it from skills-lock.json`
    );
    process.exitCode = 1;
  }
  for (const name of outcome.ambiguous) {
    p.log.error(
      `Cannot restore ${pc.cyan(name)} (${label}): more than one skill in the source has that name`
    );
    process.exitCode = 1;
  }
  for (const failure of outcome.failures) {
    p.log.error(failure);
    process.exitCode = 1;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Install all skills from the local skills-lock.json.
 * Groups skills by source and installs each group; a failing source does not
 * stop the others.
 *
 * Only installs to .agents/skills/ (universal agents) -- the canonical
 * project-level location. Does not install to agent-specific directories.
 *
 * node_modules skills are handled via sync.
 */
export async function runInstallFromLock(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const lock = await readLocalLock(cwd);
  const skillEntries = Object.entries(lock.skills);

  if (skillEntries.length === 0) {
    p.log.warn('No project skills found in skills-lock.json');
    p.log.info(
      `Add project-level skills with ${pc.cyan('npx skills add <package>')} (without ${pc.cyan('-g')})`
    );
    return;
  }

  // Only install to .agents/skills/ (universal agents)
  const universalAgentNames = getUniversalAgents();

  // Separate node_modules and well-known sources from Git-backed sources.
  const nodeModuleSkills: string[] = [];
  const wellKnownGroups = new Map<string, Record<string, LocalSkillLockEntry>>();
  const sourceGroups = new Map<string, LockedSourceGroup>();

  for (const [skillName, entry] of skillEntries) {
    if (entry.sourceType === 'node_modules') {
      nodeModuleSkills.push(skillName);
      continue;
    }

    if (entry.sourceType === 'well-known') {
      const url = entry.sourceUrl || entry.source;
      const entries = wellKnownGroups.get(url) ?? {};
      entries[skillName] = entry;
      wellKnownGroups.set(url, entries);
      continue;
    }

    const cloneSource = buildLocalCloneSource(entry);
    // `buildLocalCloneSource` returns the repository, not the skill folder, so
    // every skill from one repo shares a clone and a discovery pass.
    if (!cloneSource) {
      p.log.error(
        `Cannot restore ${pc.cyan(skillName)}: skills-lock.json is missing sourceUrl for this generic Git source`
      );
      process.exitCode = 1;
      continue;
    }

    const key = `${cloneSource}\n${entry.ref ?? ''}\n${entry.sourceType}`;
    // Discover the whole repository: the restore installs by path, not by the
    // per-skill subpath the lock used to record.
    const fullDepth = entry.sourceType !== 'local';
    const existing = sourceGroups.get(key);
    if (existing) {
      existing.entries[skillName] = entry;
    } else {
      sourceGroups.set(key, {
        label: cloneSource,
        installSource: formatSourceInput(cloneSource, entry.ref),
        entries: { [skillName]: entry },
        fullDepth,
        exactPathDisambiguates: true,
      });
    }
  }

  const remoteCount = skillEntries.length - nodeModuleSkills.length;
  if (remoteCount > 0) {
    p.log.info(
      `Restoring ${pc.cyan(String(remoteCount))} skill${remoteCount !== 1 ? 's' : ''} from skills-lock.json into ${pc.dim('.agents/skills/')}`
    );
  }

  const pendingLockUpdates: Record<string, LocalSkillLockEntry> = {};

  // Install Git-backed sources; independent repositories run concurrently.
  const groups = [...sourceGroups.values()];
  for (const group of groups) {
    const count = Object.keys(group.entries).length;
    p.log.info(`Restoring ${count} skill${count !== 1 ? 's' : ''} from ${pc.cyan(group.label)}`);
  }
  await forEachConcurrent(groups, getInstallConcurrency(), async (group) => {
    try {
      const outcome = await restoreSourceGroup(group, universalAgentNames);
      Object.assign(pendingLockUpdates, outcome.lockUpdates);
      reportOutcome(group.label, outcome);
    } catch (error) {
      p.log.error(
        `Failed to install from ${pc.cyan(group.label)}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exitCode = 1;
    }
  });

  // Well-known sources publish an index; restore them one at a time.
  for (const [url, entries] of wellKnownGroups) {
    try {
      const outcome = await restoreWellKnownGroup(url, entries, universalAgentNames);
      Object.assign(pendingLockUpdates, outcome.lockUpdates);
      reportOutcome(url, outcome);
    } catch (error) {
      p.log.error(
        `Failed to install from ${pc.cyan(url)}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exitCode = 1;
    }
  }

  // One lock read/write for the whole restore. Unchanged entries are skipped,
  // so restoring an up-to-date lock leaves the file untouched.
  if (Object.keys(pendingLockUpdates).length > 0) {
    await addSkillsToLocalLock(pendingLockUpdates, cwd);
  }

  // Handle node_modules skills via sync
  if (nodeModuleSkills.length > 0) {
    p.log.info(
      `${pc.cyan(String(nodeModuleSkills.length))} skill${nodeModuleSkills.length !== 1 ? 's' : ''} from node_modules`
    );
    try {
      const { options: syncOptions } = parseSyncOptions(args);
      await runSync(args, { ...syncOptions, yes: true, agent: universalAgentNames });
    } catch (error) {
      p.log.error(
        `Failed to sync node_modules skills: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
