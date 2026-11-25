import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const checkerPath = 'scripts/pre-push.ts';

function git(args: string[], cwd = process.cwd(), input?: string, index?: string) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd,
    input,
    env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Git command failed');
  return result.stdout;
}

function snapshot(commit: string, destination: string) {
  const entries = git(['ls-tree', '-rz', '--full-tree', commit])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      if (type !== 'blob') throw new Error('Submodules are not supported by the push check');
      return { mode, oid, path: entry.slice(tab + 1) };
    });
  const blobs = git(['cat-file', '--batch'], undefined, entries.map((e) => e.oid).join('\n'));
  let offset = 0;
  const links: { target: string; bytes: Buffer }[] = [];
  for (const entry of entries) {
    const end = blobs.indexOf('\n', offset);
    const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
    const bytes = blobs.subarray(end + 1, end + 1 + size);
    offset = end + 2 + size;
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.mode === '120000') links.push({ target, bytes });
    else
      writeFileSync(target, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 });
  }
  for (const { target, bytes } of links) {
    try {
      symlinkSync(bytes, target);
    } catch {
      throw new Error('Could not create snapshot symlink');
    }
  }
  for (const { target } of links) {
    let resolved: string;
    try {
      resolved = realpathSync.native(target);
    } catch {
      throw new Error('Unresolved snapshot symlink');
    }
    const inside = relative(destination, resolved);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error('Symlink outside snapshot');
  }
  return entries.map((entry) => entry.path);
}

function markdownText(path: string) {
  let fence = '';
  const quotePrefix = /^ {0,3}> ?/;
  const listPrefix = /^ {0,3}(?:[-+*]|\d+[.)])(?: {1,4}(?! )| )/;
  const containers: (number | 'quote')[] = [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => {
      let content = line.replace(/\t/g, '    ');
      let depth = 0;
      for (const container of containers) {
        if (container === 'quote') {
          const quote = quotePrefix.exec(content);
          if (!quote) break;
          content = content.slice(quote[0].length);
        } else {
          if (content.slice(0, container).trim()) break;
          content = content.slice(container);
        }
        depth++;
      }
      if (depth < containers.length) {
        containers.length = depth;
        fence = '';
      }
      while (!fence) {
        const quote = quotePrefix.exec(content)?.[0];
        const prefix = quote ?? listPrefix.exec(content)?.[0];
        if (!prefix) break;
        containers.push(quote ? 'quote' : prefix.length);
        content = content.slice(prefix.length);
      }
      if (!content.trim()) return '';
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = '';
        return '';
      }
      if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
        fence = marker[1];
        return '';
      }
      return /^ {4}/.test(content) ? '' : content;
    })
    .join('\n');
}

function headingIds(text: string) {
  const ids = new Set<string>();
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const slug = match[1]
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    let id = slug;
    let suffix = 0;
    while (ids.has(id)) id = `${slug}-${++suffix}`;
    ids.add(id);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

function checkLinks(root: string, files: string[], headingCache?: Map<string, Set<string>>) {
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const source = join(root, file);
    if (!realpathSync(source).startsWith(`${root}/`))
      throw new Error(`${file}: document leaves snapshot`);
    const text = markdownText(source).replace(/(`+)[^\n]*?\1/g, '');
    const links = [
      ...text.matchAll(/\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^()\n]*\))+)(?:\s+["'][^\n]*["'])?\s*\)/g),
      ...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm),
    ];
    for (const match of links) {
      const link = match[1].replace(/^<|>$/g, '');
      if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//')) continue;
      const [path, fragment] = link.split('#');
      const target = path
        ? resolve(
            path.startsWith('/') ? root : dirname(source),
            decodeURIComponent(path.replace(/^\//, '').split('?')[0]),
          )
        : source;
      if (!existsSync(target)) throw new Error(`${file}: missing local target ${link}`);
      const realTarget = realpathSync(target);
      const inside = relative(root, realTarget);
      if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
        throw new Error(`${file}: local target leaves snapshot: ${link}`);
      }
      if (!fragment || !target.endsWith('.md')) continue;
      const ids = headingCache?.get(realTarget) ?? headingIds(markdownText(target));
      headingCache?.set(realTarget, ids);
      if (!ids.has(decodeURIComponent(fragment)))
        throw new Error(`${file}: missing heading ${link}`);
    }
  }
}

function checkDocuments(root: string, paths: string[]) {
  if (!paths.length || paths.some((path) => path.startsWith('--')))
    throw new Error('Usage: --docs FILE.md ...');
  const files = [...new Set(paths.map((path) => relative(root, resolve(path))))];
  for (const file of files) {
    if (
      !file.endsWith('.md') ||
      file === '..' ||
      file.startsWith('../') ||
      isAbsolute(file) ||
      !realpathSync(join(root, file)).startsWith(`${root}/`) ||
      !lstatSync(realpathSync(join(root, file))).isFile()
    )
      throw new Error('Documentation must be Markdown files inside the repository');
    const check = spawnSync(
      'git',
      ['diff', '--no-index', '--check', '--', '/dev/null', realpathSync(join(root, file))],
      { encoding: 'utf8' },
    );
    if (check.error) throw check.error;
    if (check.status !== 0 && check.status !== 1)
      throw new Error(check.stderr || check.stdout || 'Git whitespace check failed');
  }
  checkLinks(root, files);
  process.stderr.write(`Verified ${files.length} working documents\n`);
}

function skillFile(path: string) {
  if (!existsSync(path) || !lstatSync(path).isFile())
    throw new Error(`${path}: skill metadata must be a regular file`);
  return readFileSync(path, 'utf8');
}

function checkSkills(root: string, files: string[]) {
  const names = new Set(
    files.flatMap((file) => /^\.agents\/skills\/([^/]+)\//.exec(file)?.[1] ?? []),
  );
  for (const name of names) {
    const directory = join(root, '.agents/skills', name);
    const link = join(root, '.claude/skills', name);
    if (
      !files.includes(`.claude/skills/${name}`) ||
      !lstatSync(link).isSymbolicLink() ||
      isAbsolute(readlinkSync(link)) ||
      resolve(dirname(link), readlinkSync(link)) !== directory
    ) {
      throw new Error(`${name}: Claude skill must be a relative symlink to its shared directory`);
    }

    const skill = skillFile(join(directory, 'SKILL.md'));
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
    const fields = frontmatter?.split(/\r?\n/) ?? [];
    const manual = fields.filter((line) => line.startsWith('disable-model-invocation:'));
    const nextField = fields
      .slice(fields.indexOf(manual[0]) + 1)
      .find((line) => line.trim() && !line.trimStart().startsWith('#'));
    const disabled = manual[0]?.match(
      /^disable-model-invocation:[ \t]*(true|false)[ \t]*(?:#.*)?$/,
    )?.[1];
    const policy = skillFile(join(directory, 'agents/openai.yaml'))
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:#.*)?$/.test(line));
    const implicit = policy[1]?.match(
      /^ +allow_implicit_invocation:[ \t]*(true|false)[ \t]*(?:#.*)?$/,
    )?.[1];
    if (
      !fields.every((line) => /^(?:\s|#|[A-Za-z][\w-]*:|$)/.test(line)) ||
      manual.length !== 1 ||
      (nextField !== undefined && /^\s/.test(nextField)) ||
      disabled === undefined ||
      policy.length !== 2 ||
      !/^policy:[ \t]*(?:#.*)?$/.test(policy[0]) ||
      implicit === undefined
    ) {
      throw new Error(
        `${name}: invocation metadata requires one frontmatter boolean and a policy-only block with one boolean`,
      );
    }
    if (disabled === implicit)
      throw new Error(`${name}: Claude and Codex invocation settings disagree`);

    if (
      files.includes(`.agents/skills/${name}/UPSTREAM.md`) &&
      !skillFile(join(directory, 'LICENSE')).trim()
    ) {
      throw new Error(`${name}: adapted skill LICENSE must not be empty`);
    }
  }
}

function qualityChecks(root: string, source: string, staged = false) {
  const manifestPath = join(root, 'package.json');
  if (!lstatSync(manifestPath).isFile()) throw new Error('Expected a snapshot package.json file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const commands = staged ? ['check', 'typecheck'] : ['check', 'typecheck', 'test'];
  for (const name of commands) {
    if (typeof manifest.scripts?.[name] !== 'string' || !manifest.scripts[name].trim())
      throw new Error(`Quality check unavailable: pnpm run ${name} is not configured`);
  }

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: dirname(root),
    CI: 'true',
    npm_config_offline: 'true',
    npm_config_modules_dir: 'node_modules',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_update_notifier: 'false',
  };
  const runPnpm = (args: string[], remedy = '') => {
    const result = spawnSync('pnpm', args, { cwd: root, env, stdio: ['ignore', 2, 2] });
    if (result.error)
      throw new Error(`Quality check unavailable: pnpm ${args.join(' ')}: ${result.error.message}`);
    if (result.signal)
      throw new Error(`Quality check unavailable: pnpm stopped by ${result.signal}`);
    if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed${remedy}`);
  };

  const lock = lstatSync(join(root, 'pnpm-lock.yaml'), { throwIfNoEntry: false });
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  if (lock || Object.keys(dependencies).length) {
    if (!lock?.isFile())
      throw new Error('Quality check unavailable: expected a snapshot pnpm-lock.yaml file');
    if (lstatSync(join(root, 'node_modules'), { throwIfNoEntry: false }))
      throw new Error('Quality check unavailable: snapshot already contains node_modules');

    const store = spawnSync('pnpm', ['store', 'path'], {
      cwd: source,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_manage_package_manager_versions: 'false',
      },
    });
    const storePath = store.stdout?.trim();
    if (store.status !== 0 || !storePath || !isAbsolute(storePath))
      throw new Error('Quality check unavailable: could not resolve the local pnpm store');
    env.npm_config_store_dir = storePath;
    runPnpm(
      [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--ignore-workspace',
        '--lockfile-dir=.',
        '--virtual-store-dir=node_modules/.pnpm',
        '--config.enable-global-virtual-store=false',
        '--package-import-method=copy',
      ],
      '. Prepare dependencies with pnpm install --frozen-lockfile first',
    );
  }
  for (const name of commands) runPnpm(['run', name]);
}

function hookWrapper(name: 'pre-commit' | 'pre-push') {
  const checker = readFileSync(import.meta.filename, 'base64');
  return `#!/bin/sh
# Stock Scout snapshot checker (pinned at installation)
set -eu
temporary=$(mktemp -d "\${TMPDIR:-/tmp}/stock-scout-hook.XXXXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
checker="$temporary/pre-push.mts"
printf '%s' '${checker}' | base64 -d > "$checker"
node "$checker" --installed-${name} "$@"
`;
}

function requirePinnedChecker(tree: string, checker: Buffer | undefined) {
  if (!checker) return;
  const entry = git(['ls-tree', tree, '--', checkerPath]).toString();
  const oid = /^100(?:644|755) blob ([a-f\d]+)\t/.exec(entry)?.[1];
  if (!oid) throw new Error(`Checker missing or not a regular file in ${tree}: ${checkerPath}`);
  if (!checker.equals(git(['cat-file', 'blob', oid]))) {
    throw new Error(`Checker differs in ${tree}: ${checkerPath}. Review and reinstall the hook`);
  }
}

function installHook(name: 'pre-commit' | 'pre-push') {
  const hooks = resolve(git(['rev-parse', '--git-path', 'hooks']).toString().trim());
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  if (configured.status !== 1)
    throw new Error('Custom core.hooksPath requires manual hook integration');
  const primary = join(hooks, name);
  const wrapper = Buffer.from(hookWrapper(name));
  const primaryStat = lstatSync(primary, { throwIfNoEntry: false });
  let destination = primary;
  if (primaryStat) {
    if (!primaryStat.isFile() || !(primaryStat.mode & 0o111))
      throw new Error(`Existing ${name} hook is not a regular executable file; preserved`);
    const contents = readFileSync(primary);
    if (!wrapper.equals(contents)) {
      const text = contents.toString();
      if (
        name === 'pre-commit' ||
        !text.split('\n').includes('# gstack-redact pre-push (managed)') ||
        !text.includes('hooks/pre-push.local')
      ) {
        throw new Error(`Existing ${name} hook requires manual integration; preserved`);
      }
      destination = join(hooks, 'pre-push.local');
    }
  }

  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (!existing) {
    mkdirSync(hooks, { recursive: true });
    const temporary = mkdtempSync(join(hooks, '.stock-scout-hook-'));
    try {
      const draft = join(temporary, name);
      writeFileSync(draft, wrapper, { flag: 'wx', mode: 0o700 });
      linkSync(draft, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else if (
    !existing.isFile() ||
    !(existing.mode & 0o111) ||
    !wrapper.equals(readFileSync(destination))
  ) {
    throw new Error('Existing hook preserved; integrate manually');
  }
  process.stderr.write(`Installed ${destination}\n`);
}

type PushSelection = { mode: 'push'; commit: string; tree: string; changed: string[] };

function checkSnapshot(
  source: string,
  selection: { mode: 'staged' } | PushSelection,
  checker?: Buffer,
) {
  const staged = selection.mode === 'staged';
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), staged ? 'stock-scout-commit-' : 'stock-scout-push-')),
  );
  const root = join(temporary, 'snapshot');
  try {
    mkdirSync(root);
    let tree: string;
    let changed: string[];
    let stagedTree: (() => string) | undefined;
    if (selection.mode === 'staged') {
      const index = resolve(git(['rev-parse', '--git-path', 'index']).toString().trim());
      const copiedIndex = join(temporary, 'index');
      stagedTree = () => {
        cpSync(index, copiedIndex);
        return git(['write-tree'], source, undefined, copiedIndex).toString().trim();
      };
      tree = stagedTree();
      requirePinnedChecker(tree, checker);
      const head = spawnSync(
        'git',
        ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        {
          cwd: source,
        },
      );
      if (head.error) throw head.error;
      if (head.status !== 0 && head.status !== 1) throw new Error(head.stderr.toString());
      const base =
        head.status === 0
          ? head.stdout.toString().trim()
          : git(['hash-object', '-t', 'tree', '--stdin'], source, '').toString().trim();
      git(['diff', '--check', base, tree], source);
      changed = git(['diff', '--no-renames', '--name-only', '-z', base, tree], source)
        .toString()
        .split('\0')
        .filter(Boolean);
    } else {
      tree = selection.tree;
      changed = selection.changed;
    }
    const files = snapshot(tree, root);
    checkSkills(root, files);
    checkLinks(root, files, new Map());
    if (changed.some((file) => !file.endsWith('.md'))) qualityChecks(root, source, staged);
    if (stagedTree && stagedTree() !== tree)
      throw new Error('Index changed during staged checks; retry the commit');
    process.stderr.write(
      `Verified ${selection.mode === 'staged' ? `staged tree ${tree}` : selection.commit}\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const command = process.argv[2];
const installed = command === '--installed-pre-commit' || command === '--installed-pre-push';
const docsCommand = !installed && process.argv.includes('--docs');
const stagedCommand = command === '--staged' || command === '--installed-pre-commit';

function main() {
  if (docsCommand) {
    if (command !== '--docs') throw new Error('Usage: --docs FILE.md ...');
    const root = git(['rev-parse', '--show-toplevel']).toString().trim();
    checkDocuments(realpathSync(root), process.argv.slice(3));
    return;
  }
  if (command === '--print-hook') {
    const name = process.argv[3];
    if (process.argv.length !== 4 || (name !== 'pre-commit' && name !== 'pre-push'))
      throw new Error('Usage: --print-hook pre-commit|pre-push');
    process.stdout.write(hookWrapper(name));
    return;
  }
  if (command === '--install' || command === '--install-pre-commit') {
    installHook(command === '--install-pre-commit' ? 'pre-commit' : 'pre-push');
    return;
  }

  const source = git(['rev-parse', '--show-toplevel']).toString().trim();
  const checker = installed ? readFileSync(import.meta.filename) : undefined;
  if (stagedCommand) {
    checkSnapshot(source, { mode: 'staged' }, checker);
    return;
  }
  const input = readFileSync(0, 'utf8');
  const selections: PushSelection[] = [];
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.split(/\s+/);
    const [, commit, , base] = fields;
    if (
      fields.length !== 4 ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(commit) ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(base)
    ) {
      throw new Error('Invalid pre-push input');
    }
    if (/^0+$/.test(commit)) continue;
    const tree = git(['rev-parse', '--verify', `${commit}^{commit}^{tree}`])
      .toString()
      .trim();
    requirePinnedChecker(tree, checker);
    const comparison = /^0+$/.test(base)
      ? git(['hash-object', '-t', 'tree', '--stdin'], undefined, '').toString().trim()
      : base;
    git(['diff', '--check', comparison, tree]);
    const changed = git(['diff', '--no-renames', '--name-only', '-z', comparison, tree])
      .toString()
      .split('\0')
      .filter(Boolean);
    selections.push({ mode: 'push', tree, commit, changed });
  }
  for (const selection of selections) checkSnapshot(source, selection);
}

try {
  main();
} catch (error) {
  const label =
    command === '--docs'
      ? 'Documentation'
      : stagedCommand || command === '--install-pre-commit'
        ? 'Commit'
        : 'Push';
  process.stderr.write(`${label} check failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
