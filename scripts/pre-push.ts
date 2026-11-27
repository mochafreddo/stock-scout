import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

const thematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const parenthesizedTitle = /\((?:\\.|[^()\\\n]|\n(?![ \t]*\n))*\)/;
const linkTitle = String.raw`"(?:\\.|[^"\\\n]|\n(?![ \t]*\n))*"|'(?:\\.|[^'\\\n]|\n(?![ \t]*\n))*'|${parenthesizedTitle.source}`;
const destinationCharacter = /[^\s()]/.source;
const githubLinkParenthesisLimit = 32;
let destinationPart = destinationCharacter;
for (let depth = 0; depth < githubLinkParenthesisLimit; depth++)
  destinationPart = String.raw`${destinationCharacter}|\((?:${destinationPart})*\)`;
const inlineSpace = /[ \t]*(?:\n[ \t]*)?/.source;
const inlineLink = new RegExp(
  String.raw`\]\(${inlineSpace}(?<inlineTarget><[^>\n]*>|(?:${destinationPart})+)(?:(?=[ \t\n])${inlineSpace}(?:${linkTitle}))?${inlineSpace}\)`,
  'g',
);
const referenceDefinition = new RegExp(
  String.raw`^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(?<referenceTarget><[^>\n]*>|\S+)(?:(?:[ \t]+|\n[ \t]*)(?:${linkTitle}))?[ \t]*$`,
  'gm',
);

const htmlTag = /<\/?([a-z][\w-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/;
const rawHtml = new RegExp([/<!--[\s\S]*?(?:-->|$)/.source, htmlTag.source].join('|'), 'gi');

function markdownText(path: string) {
  let blockEnd = '';
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
        blockEnd = '';
      }
      while (!blockEnd && !thematicBreak.test(content)) {
        const quote = quotePrefix.exec(content)?.[0];
        const prefix = quote ?? listPrefix.exec(content)?.[0];
        if (!prefix) break;
        containers.push(quote ? 'quote' : prefix.length);
        content = content.slice(prefix.length);
      }
      if (!content.trim()) return '';
      if (blockEnd === '-->' || (!blockEnd && /^ {0,3}<!--/.test(content))) {
        const end = content.indexOf('-->');
        if (end < 0) {
          blockEnd = '-->';
          return '';
        }
        blockEnd = '';
        return (content.slice(end + 3).match(rawHtml) ?? [])
          .filter((tag) => !tag.startsWith('<!--'))
          .join('');
      }
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      if (blockEnd) {
        if (
          marker &&
          marker[1][0] === blockEnd[0] &&
          marker[1].length >= blockEnd.length &&
          !marker[2].trim()
        )
          blockEnd = '';
        return '';
      }
      if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
        blockEnd = marker[1];
        return '';
      }
      return content;
    })
    .join('\n');
}

const inlineCodeOrEscape = /\\[\\<`]|(?<!`)(`+)(?!`)(?:[^\n]|\n(?![ \t]*\n))*?(?<!`)\1(?!`)/g;
const atxHeading = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/;
const markdownInline = new RegExp(
  [
    /^ {4}.*$/.source,
    inlineCodeOrEscape.source,
    /<!--(?:[^\n]|\n(?![ \t]*\n))*?-->/.source,
    htmlTag.source,
    inlineLink.source,
    referenceDefinition.source,
    `(?<atx>${atxHeading.source})`,
    `(?<blockBreak>${setextUnderline.source}|${thematicBreak.source})`,
    /\\[[\]]|\[|\]|\n(?:[ \t]*\n)?/.source,
  ].join('|'),
  'gim',
);

function* markdownMatches(text: string) {
  const pattern = new RegExp(markdownInline);
  let labels = 0;
  let heading = false;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [token] = match;
    if (match.groups?.atx) {
      labels = 0;
      heading = true;
    } else if (token.startsWith('\n')) {
      if (heading || token.length > 1) labels = 0;
      heading = false;
    } else if (match.groups?.blockBreak) {
      labels = 0;
    } else if (token === '[') labels++;
    else if (token === ']') labels = Math.max(0, labels - 1);
    else if (match.groups?.inlineTarget) {
      const continuation = token.split('\n').slice(1);
      const crossesBlock =
        continuation.length > 0 &&
        (heading ||
          continuation.some(
            (line) =>
              atxHeading.test(line) || setextUnderline.test(line) || thematicBreak.test(line),
          ));
      if (labels && !crossesBlock) yield match;
      else pattern.lastIndex = match.index + 1;
      labels = Math.max(0, labels - 1);
    } else {
      yield match;
    }
  }
}

const linkLabelEnd = '\uE000';
const headingTokens = new RegExp(
  [
    inlineCodeOrEscape.source,
    /\\[[_*\]]/.source,
    String.raw`\[|${linkLabelEnd}?\]`,
    /(?<=(?<before>.|^))(?<marker>[_*])\k<marker>*(?=(?<after>.|$))/.source,
  ].join('|'),
  'gu',
);
const headingPunctuation = /[\p{P}\p{S}]/u;

function stripHeadingEmphasis(title: string) {
  const tokens = Array.from(title.matchAll(headingTokens));
  const brackets: number[] = [];
  const linkStarts = new Set<number>();
  const linkEnds = new Set<number>();
  for (const { 0: token, index } of tokens) {
    if (token === '[') brackets.push(index);
    else if (token === ']' || token === `${linkLabelEnd}]`) {
      const opening = brackets.pop();
      if (opening !== undefined && token.startsWith(linkLabelEnd)) {
        linkStarts.add(opening);
        linkEnds.add(index);
      }
    }
  }

  const parts: string[] = [];
  const delimiters: { part: number; marker: string; canClose: boolean; size: number }[][] = [[]];
  let end = 0;
  for (const match of tokens) {
    const [token] = match;
    parts.push(title.slice(end, match.index), token);
    end = match.index + token.length;
    if (linkStarts.has(match.index)) delimiters.push([]);
    if (linkEnds.has(match.index)) delimiters.pop();
    const marker = match.groups?.marker;
    if (!marker) continue;
    const openers = delimiters[delimiters.length - 1];
    const before = match.groups?.before || ' ';
    const after = match.groups?.after || ' ';
    const beforePunct = before === linkLabelEnd || headingPunctuation.test(before);
    const afterPunct = after === linkLabelEnd || headingPunctuation.test(after);
    const left = !/\s/.test(after) && (!afterPunct || beforePunct || /\s/.test(before));
    const right = !/\s/.test(before) && (!beforePunct || afterPunct || /\s/.test(after));
    const canOpen = left && (marker === '*' || !right || beforePunct);
    const canClose = right && (marker === '*' || !left || afterPunct);
    const part = parts.length - 1;
    if (canClose) {
      for (let i = openers.length - 1; i >= 0 && parts[part]; i--) {
        const opener = openers[i];
        if (
          opener.marker !== marker ||
          ((opener.canClose || canOpen) &&
            (opener.size + token.length) % 3 === 0 &&
            (opener.size % 3 !== 0 || token.length % 3 !== 0))
        )
          continue;
        const used = Math.min(parts[part].length, parts[opener.part].length);
        parts[part] = parts[part].slice(used);
        parts[opener.part] = parts[opener.part].slice(used);
        openers.length = parts[opener.part] ? i + 1 : i;
      }
    }
    if (canOpen && parts[part]) openers.push({ part, marker, canClose, size: token.length });
  }
  return parts.join('') + title.slice(end);
}

const headingReference = new RegExp(
  [
    inlineCodeOrEscape.source,
    /\\[[\]]/.source,
    String.raw`\[([^\]\n${linkLabelEnd}]+)\](?:\[([^\]\n${linkLabelEnd}]*)\])?`,
  ].join('|'),
  'g',
);

function headingIds(text: string) {
  const anchors = new Set<string>();
  const referenceLabels = new Set<string>();
  const pieces: string[] = [];
  let end = 0;
  for (const match of markdownMatches(text)) {
    const [token, ticks, tag, attributes, destination, label] = match;
    pieces.push(text.slice(end, match.index));
    end = match.index + token.length;
    if (destination) {
      pieces.push(`${linkLabelEnd}]`);
      continue;
    }
    if (label) referenceLabels.add(label.toLowerCase());
    if (ticks || token.startsWith('\\')) {
      pieces.push(token);
      continue;
    }
    if (tag && !token.startsWith('</')) {
      const attribute = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
      for (const [, key, double, single, bare] of attributes.matchAll(attribute)) {
        const value = double ?? single ?? bare;
        const name = key.toLowerCase();
        if (value && (name === 'id' || (tag.toLowerCase() === 'a' && name === 'name')))
          anchors.add(value);
      }
    }
    pieces.push(token.replace(/[^\n]/g, ''));
  }
  const visible = pieces.join('') + text.slice(end);
  const ids = new Set<string>();
  const paragraph: string[] = [];
  for (const line of visible.split('\n')) {
    const atx = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const underline = setextUnderline.test(line);
    const title = atx?.[1] ?? (underline ? paragraph.join(' ') : '');
    if (atx || underline || thematicBreak.test(line) || !line.trim()) paragraph.length = 0;
    else paragraph.push(line.trim());
    if (!title) continue;
    const labelText = title.replace(headingReference, (token, _ticks, label, reference) =>
      label && referenceLabels.has((reference || label).toLowerCase())
        ? `[${label}${linkLabelEnd}]`
        : token,
    );
    const slug = stripHeadingEmphasis(labelText)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    let id = slug;
    let suffix = 0;
    while (ids.has(id)) id = `${slug}-${++suffix}`;
    ids.add(id);
  }
  return new Set([...ids, ...anchors]);
}

function checkLinks(root: string, files: string[], headingCache?: Map<string, Set<string>>) {
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const source = join(root, file);
    if (!realpathSync(source).startsWith(`${root}/`))
      throw new Error(`${file}: document leaves snapshot`);
    for (const match of markdownMatches(markdownText(source))) {
      const destination = match.groups?.inlineTarget ?? match.groups?.referenceTarget;
      if (!destination) continue;
      const link = destination.replace(/^<|>$/g, '');
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
      let directory = root;
      for (const part of relative(root, target).split(sep).filter(Boolean)) {
        if (!readdirSync(directory).some((name) => name.normalize() === part.normalize()))
          throw new Error(`${file}: missing local target ${link}`);
        directory = join(directory, part);
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
      /^disable-model-invocation:[ \t]+(true|false)(?:[ \t]+(?:#.*)?)?$/,
    )?.[1];
    const policy = skillFile(join(directory, 'agents/openai.yaml'))
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:#.*)?$/.test(line));
    const implicit = policy[1]?.match(
      /^ +allow_implicit_invocation:[ \t]+(true|false)(?:[ \t]+(?:#.*)?)?$/,
    )?.[1];
    if (
      !fields.every((line) => /^(?:\s|#|[A-Za-z][\w-]*:|$)/.test(line)) ||
      manual.length !== 1 ||
      (nextField !== undefined && /^\s/.test(nextField)) ||
      disabled === undefined ||
      policy.length !== 2 ||
      !/^policy:(?:[ \t]+(?:#.*)?)?$/.test(policy[0]) ||
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
    if (!primaryStat.isFile())
      throw new Error(`Existing ${name} hook is not a regular executable file; preserved`);
    accessSync(primary, constants.X_OK);
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
      accessSync(draft, constants.X_OK);
      linkSync(draft, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else {
    if (!existing.isFile() || !wrapper.equals(readFileSync(destination)))
      throw new Error('Existing hook preserved; integrate manually');
    accessSync(destination, constants.X_OK);
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

const [command, ...operands] = process.argv.slice(2);
const installed = command === '--installed-pre-commit' || command === '--installed-pre-push';
const docsCommand = !installed && (command === '--docs' || operands.includes('--docs'));
const stagedCommand = command === '--staged' || command === '--installed-pre-commit';

function main() {
  if (docsCommand) {
    if (command !== '--docs') throw new Error('Usage: --docs FILE.md ...');
    const root = git(['rev-parse', '--show-toplevel']).toString().trim();
    checkDocuments(realpathSync(root), operands);
    return;
  }
  if (command === '--print-hook') {
    const [name] = operands;
    if (operands.length !== 1 || (name !== 'pre-commit' && name !== 'pre-push'))
      throw new Error('Usage: --print-hook pre-commit|pre-push');
    process.stdout.write(hookWrapper(name));
    return;
  }
  if (command === '--install' || command === '--install-pre-commit') {
    if (operands.length) throw new Error(`Usage: ${command}`);
    installHook(command === '--install-pre-commit' ? 'pre-commit' : 'pre-push');
    return;
  }

  if (stagedCommand) {
    if (operands.length) throw new Error(`Usage: ${command}`);
  } else if (command === '--installed-pre-push') {
    if (operands.length !== 0 && operands.length !== 2)
      throw new Error('Usage: --installed-pre-push [REMOTE LOCATION]');
  } else if (command !== undefined && (command.startsWith('-') || operands.length !== 1)) {
    throw new Error(
      'Usage: pre-push.ts [REMOTE LOCATION | --staged | --install | --install-pre-commit | --docs FILE.md ... | --print-hook pre-commit|pre-push]',
    );
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
