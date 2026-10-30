import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function git(args: string[], cwd = process.cwd(), input?: string, index?: string) {
  const result = spawnSync('git', args, {
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
  for (const entry of entries) {
    const end = blobs.indexOf('\n', offset);
    const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
    const bytes = blobs.subarray(end + 1, end + 1 + size);
    offset = end + 2 + size;
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.mode === '120000') symlinkSync(bytes.toString(), target);
    else writeFileSync(target, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600 });
  }
  return entries.map((entry) => entry.path);
}

function markdownText(path: string) {
  let fence = '';
  const listIndents: number[] = [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => {
      line = line.replace(/\t/g, '    ');
      if (!line.trim()) return '';
      const indent = line.search(/\S/);
      while (indent < (listIndents.at(-1) ?? 0)) listIndents.pop();
      const container = listIndents.at(-1) ?? 0;
      let content = line.slice(container);
      const item = /^ {0,3}(?:[-+*]|\d+[.)]) +/.exec(content);
      if (!fence && item) {
        listIndents.push(container + item[0].length);
        content = content.slice(item[0].length);
      }
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

function checkLinks(root: string, files: string[]) {
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const source = join(root, file);
    if (!realpathSync(source).startsWith(`${root}/`))
      throw new Error(`${file}: document leaves snapshot`);
    const text = markdownText(source).replace(/(`+)[^\n]*?\1/g, '');
    const links = [
      ...text.matchAll(/\]\(\s*(<[^>\n]*>|(?:[^\s()]+|\([^()\n]*\))+)(?:\s+["'][^\n]*["'])?\s*\)/g),
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
      const inside = relative(root, realpathSync(target));
      if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
        throw new Error(`${file}: local target leaves snapshot: ${link}`);
      }
      if (
        fragment &&
        target.endsWith('.md') &&
        !headingIds(markdownText(target)).has(decodeURIComponent(fragment))
      ) {
        throw new Error(`${file}: missing heading ${link}`);
      }
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
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commands = staged ? ['check', 'typecheck'] : ['check', 'typecheck', 'test'];
  for (const name of commands) {
    if (typeof manifest.scripts?.[name] !== 'string' || !manifest.scripts[name].trim())
      throw new Error(`Quality check unavailable: npm run ${name} is not configured`);
  }
  if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) {
    const lock = join(root, 'package-lock.json');
    if (
      !existsSync(lock) ||
      !existsSync(join(source, 'package-lock.json')) ||
      !readFileSync(lock).equals(readFileSync(join(source, 'package-lock.json'))) ||
      !existsSync(join(source, 'node_modules'))
    ) {
      throw new Error(
        `Prepare installed dependencies for the ${staged ? 'staged' : 'pushed'} package-lock.json first`,
      );
    }
    cpSync(join(source, 'node_modules'), join(root, 'node_modules'), { recursive: true });
  }
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: dirname(root),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
  };
  for (const args of [['ls', '--offline', '--all'], ...commands.map((name) => ['run', name])]) {
    const result = spawnSync('npm', args, { cwd: root, env, stdio: ['ignore', 2, 2] });
    if (result.error)
      throw new Error(`Quality check unavailable: npm ${args.join(' ')}: ${result.error.message}`);
    if (result.signal)
      throw new Error(`Quality check unavailable: npm stopped by ${result.signal}`);
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
  }
}

function installHook(staged = false) {
  const hooks = resolve(git(['rev-parse', '--git-path', 'hooks']).toString().trim());
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  if (configured.status !== 1)
    throw new Error('Custom core.hooksPath requires manual hook integration');
  const name = staged ? 'pre-commit' : 'pre-push';
  const primary = join(hooks, name);
  const wrapper = `#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/scripts/pre-push.ts"${staged ? ' --staged' : ''} "$@"\n`;
  let destination = primary;
  if (
    existsSync(primary) &&
    (lstatSync(primary).isSymbolicLink() || !(lstatSync(primary).mode & 0o111))
  ) {
    throw new Error(`Existing ${name} hook is linked or not executable; preserved`);
  }
  if (existsSync(primary) && readFileSync(primary, 'utf8') !== wrapper) {
    const text = readFileSync(primary, 'utf8');
    if (
      staged ||
      !text.includes('# gstack-redact pre-push (managed)') ||
      !text.includes('hooks/pre-push.local')
    ) {
      throw new Error(`Existing ${name} hook requires manual integration; preserved`);
    }
    destination = join(hooks, 'pre-push.local');
  }
  if (existsSync(destination)) {
    if (
      lstatSync(destination).isSymbolicLink() ||
      readFileSync(destination, 'utf8') !== wrapper ||
      !(lstatSync(destination).mode & 0o111)
    ) {
      throw new Error('Existing hook preserved; integrate manually');
    }
  } else {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(destination, wrapper, { flag: 'wx', mode: 0o700 });
  }
  process.stderr.write(`Installed ${destination}\n`);
}

function checkSnapshot(
  source: string,
  selection: { mode: 'staged' } | { mode: 'push'; commit: string; changed: string[] },
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
      const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        cwd: source,
      });
      if (head.error) throw head.error;
      if (head.status !== 0 && head.status !== 1) throw new Error(head.stderr.toString());
      const base =
        head.status === 0
          ? head.stdout.toString().trim()
          : git(['hash-object', '-t', 'tree', '--stdin'], source, '').toString().trim();
      git(['diff', '--check', base, tree], source);
      changed = git(['diff', '--name-only', '-z', base, tree], source)
        .toString()
        .split('\0')
        .filter(Boolean);
    } else {
      tree = selection.commit;
      changed = selection.changed;
    }
    const files = snapshot(tree, root);
    checkSkills(root, files);
    checkLinks(root, files);
    if (changed.some((file) => !file.endsWith('.md'))) qualityChecks(root, source, staged);
    if (stagedTree && stagedTree() !== tree)
      throw new Error('Index changed during staged checks; retry the commit');
    process.stderr.write(`Verified ${staged ? 'staged tree ' : ''}${tree}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes('--docs')) {
    if (process.argv[2] !== '--docs') throw new Error('Usage: --docs FILE.md ...');
    const root = git(['rev-parse', '--show-toplevel']).toString().trim();
    checkDocuments(realpathSync(root), process.argv.slice(3));
    process.exit(0);
  }
  if (process.argv.includes('--install') || process.argv.includes('--install-pre-commit')) {
    installHook(process.argv.includes('--install-pre-commit'));
    process.exit(0);
  }
  const source = git(['rev-parse', '--show-toplevel']).toString().trim();
  if (process.argv.includes('--staged')) {
    checkSnapshot(source, { mode: 'staged' });
    process.exit(0);
  }
  const input = readFileSync(0, 'utf8');
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
    git(['rev-parse', '--verify', `${commit}^{commit}`]);
    const comparison = /^0+$/.test(base)
      ? git(['hash-object', '-t', 'tree', '--stdin'], undefined, '').toString().trim()
      : base;
    git(['diff', '--check', comparison, commit]);
    const changed = git(['diff', '--name-only', '-z', comparison, commit])
      .toString()
      .split('\0')
      .filter(Boolean);
    checkSnapshot(source, { mode: 'push', commit, changed });
  }
} catch (error) {
  process.stderr.write(
    `${process.argv[2] === '--docs' ? 'Documentation' : process.argv.includes('--staged') || process.argv.includes('--install-pre-commit') ? 'Commit' : 'Push'} check failed: ${(error as Error).message}\n`,
  );
  process.exitCode = 1;
}
