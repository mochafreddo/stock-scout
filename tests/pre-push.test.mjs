import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/pre-push.ts', import.meta.url));

const fixtureGitConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitForFixturePackageScript = `${Object.entries(fixtureGitConfig)
  .map(([name, value]) => `${name}=${value}`)
  .join(' ')} git`;

function fixtureProcess(command, args, { cwd, env, ...options }) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    ...options,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      TMPDIR: tmpdir(),
      ...fixtureGitConfig,
      ...env,
    },
  });
}

function git(cwd, ...args) {
  const result = fixtureProcess('git', args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, initial = true) {
  const root = mkdtempSync(join(tmpdir(), 'stock-scout-push-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(cli, join(root, 'scripts/pre-push.ts'));
  writeFileSync(join(root, 'README.md'), '# Start\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        check: 'node -e "console.error(\'fixture check\')"',
        typecheck: 'node -e "console.error(\'fixture typecheck\')"',
        test: 'node -e "console.error(\'fixture test\')"',
      },
    }),
  );
  if (initial) {
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'baseline');
  }
  const base = initial ? git(root, 'rev-parse', 'HEAD') : null;
  return { root, base };
}

function run(root, tip, base, args = [], extraEnv = {}, timeout) {
  return fixtureProcess(process.execPath, [cli, ...args], {
    cwd: root,
    timeout,
    input: `refs/heads/main ${tip} refs/heads/main ${base}\n`,
    env: extraEnv,
  });
}

for (const mode of ['docs', 'staged', 'push']) {
  const args = mode === 'docs' ? ['--docs', 'README.md'] : mode === 'staged' ? ['--staged'] : [];
  function checkReadme(root, base, body) {
    writeFileSync(join(root, 'README.md'), body);
    if (mode !== 'docs') git(root, 'add', '.');
    if (mode === 'push') git(root, 'commit', '-m', 'link targets');
    return run(root, git(root, 'rev-parse', 'HEAD'), base, args);
  }

  test(`${mode} checks inline Markdown links with a parenthesized title`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'guide(v1).md'), '# Details\n');
    writeFileSync(join(root, 'guide(((v1))).md'), '# Details\n');
    const valid = '[Guide](guide(v1).md#details (first title))';
    for (const [link, diagnostic] of [
      [valid, null],
      ['[Guide](guide(((v1))).md#details (nested destination))', null],
      ['[Guide](missing((v1)).md (nested destination))', /missing local target/],
      ['[Guide](missing((((v1)))).md (nested destination))', /missing local target/],
      ['[Guide](missing((v1 draft)).md (spaces in an unbracketed target))', null],
      ['[Guide](missing(v1).md (first title))', /missing local target missing\(v1\)\.md/],
      ['[Guide](guide(v1).md#absent (first title))', /missing heading guide\(v1\)\.md#absent/],
      [`${valid} [Next](missing.md (second title))`, /missing local target missing\.md/],
    ]) {
      const result = checkReadme(root, base, `${link}\n`);
      assert.equal(result.status, diagnostic ? 1 : 0, result.stderr);
      if (diagnostic) assert.match(result.stderr, diagnostic);
    }
  });

  test(`${mode} checks multiline quoted link titles and escaped label openers`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'guide.md'), '# Details\n');
    for (const [text, diagnostic] of [
      ['[guide](guide.md#details "a\nb")', null],
      ["[guide](missing.md 'a\nb')", /missing local target missing\.md/],
      ['[guide](missing.md "a\nb")', /missing local target missing\.md/],
      ['[guide](missing.md "a\n\nb")', null],
      ['[guide](missing.md\n\n"a\nb")', null],
      ['[guide](missing.md "a\nb"\n\n)', null],
      ['[guide](missing.md "a\n# Heading\nb")', null],
      ['[guide](missing.md "a\n---\nb")', null],
      [String.raw`\[not a link](missing.md)`, null],
      ['# [\n\\[not a link](missing.md)', null],
      [String.raw`\\[even slash](missing.md)`, /missing local target missing\.md/],
      [
        String.raw`\[not a link](missing.md) [visible](absent.md)`,
        /missing local target absent\.md/,
      ],
      ['[Use it](guide.md "a\nb") [other](guide.md)\n===\n\n[Go](#use-it-other)', null],
    ]) {
      const result = checkReadme(root, base, `${text}\n`);
      assert.equal(result.status, diagnostic ? 1 : 0, result.stderr || text);
      if (diagnostic) assert.match(result.stderr, diagnostic);
    }
  });

  test(`${mode} checks rendered emphasis in Markdown heading anchors`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'guide.md'), '# Details\n');
    const headings = [
      '# _Read_ __this__',
      'Read _this_',
      '===',
      'Read this-1',
      '---',
      '# _snake_case_ \\_literal\\_ `_code_` unmatched_',
      '# [_one](guide.md) [two_](guide.md)',
      '# *A _B* C_',
      '# _[Wrapped](guide.md)_',
      '# [Inner _emphasis_][guide]',
      '# [Shortcut _label] outside_',
      '# [_ordinary] bracket_',
      '',
      '[guide]: guide.md',
      '[Shortcut _label]: guide.md',
    ].join('\n');
    for (const [targets, missing] of [
      [['read-this', 'read-this-1', 'read-this-1-1', 'snake_case-_literal_-_code_-unmatched_']],
      [['_one-two_', 'a-_b-c_', 'wrapped', 'inner-emphasis']],
      [['shortcut-_label-outside_', 'ordinary-bracket']],
      [['one-two'], 'one-two'],
      [['a-b-c'], 'a-b-c'],
      [['_read_-__this__'], '_read_-__this__'],
      [['read-_this_'], 'read-_this_'],
    ]) {
      const links = targets.map((target) => `[Jump](#${target})`).join('\n');
      const result = checkReadme(root, base, `${headings}\n\n${links}\n`);
      assert.equal(result.status, missing ? 1 : 0, result.stderr);
      if (missing) assert.ok(result.stderr.includes(`missing heading #${missing}`), result.stderr);
    }
  });

  for (const [kind, hidden, suffix = ''] of [
    ['block comment with a fence', '<!--\n```\n[example](hidden.md)\n-->\n'],
    ['block comment with an indented end', '<!--\n[example]: hidden.md\n    -->\n'],
    [
      'block comment with text on its closing line',
      '   <!--\n[example](hidden.md)\n--> [still hidden](hidden.md)\n',
    ],
    ['unclosed quoted block comment', '> <!--\n> [example](hidden.md)\n'],
    ['unclosed list item block comment', '- <!--\n  [example](hidden.md)\n'],
    ['inline comment', 'Text <!--\n[example](hidden.md)\n[example]: hidden.md\n-->'],
    [
      'paragraph with an unclosed inline comment before a block comment',
      'Intro <!--\n\n<!-- note -->\n',
    ],
    ['paragraph with an inline comment opener', 'Intro <!--\n\n', ' -->'],
    ['fence containing a comment opener', '```md\n<!--\n```\n'],
    ['code span', '``sample `\n[example](hidden.md)\n[example]: hidden.md\nend``'],
  ]) {
    test(`${mode} checks links immediately after a ${kind}`, (t) => {
      const { root, base } = fixture(t);
      const body = `# Use \`Tag\`\n\n[ref]: #use-tag\n\n${hidden}`;
      for (const destination of ['#use-tag', 'missing.md']) {
        const result = checkReadme(root, base, `${body}[visible](${destination})${suffix}\n`);
        assert.equal(result.status, destination === 'missing.md' ? 1 : 0, result.stderr);
        if (destination === 'missing.md')
          assert.match(result.stderr, /missing local target missing\.md/);
      }
    });
  }

  test(`${mode} checks a reference definition with a multiline title`, (t) => {
    const { root, base } = fixture(t);
    const valid = [
      '# [Single][single] [Parentheses][parentheses]',
      '[heading](#single-parentheses)',
      "[single]: #start 'first\nsecond'",
      '[parentheses]: #start (first\nsecond)',
      '[invalid]: hidden.md "first\n\nsecond"',
      '    [code](hidden.md)',
    ].join('\n\n');
    for (const target of ['#start', 'missing.md']) {
      const body = `# Start\n\n${valid}\n\n[Read][r]\n\n[r]: ${target} "first\n    second"\n`;
      const result = checkReadme(root, base, body);
      assert.equal(result.status, target === 'missing.md' ? 1 : 0, result.stderr);
      if (target === 'missing.md') assert.match(result.stderr, /missing local target missing\.md/);
    }
  });

  for (const target of ['guides/Intro.md', 'Guides/intro.md']) {
    test(`${mode} rejects the misspelled local path ${target}`, (t) => {
      const { root, base } = fixture(t);
      mkdirSync(join(root, 'Guides'));
      writeFileSync(join(root, 'Guides/Intro.md'), '# Intro\n');
      symlinkSync('Guides', join(root, 'Alias'));
      const valid =
        '[relative](Guides/Intro.md) [root](/Guides/Intro.md) [alias](Alias/Intro.md#intro)\n';
      const accepted = checkReadme(root, base, valid);
      assert.equal(accepted.status, 0, accepted.stderr);
      const rejected = checkReadme(root, base, `${valid}[wrong](${target})\n`);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.ok(rejected.stderr.includes(`missing local target ${target}`), rejected.stderr);
    });
  }

  const anchorDocument = [
    'Use `<Tag>`',
    '===',
    '# Use `<Tag>`',
    'Use Tag-1',
    '---',
    '',
    'Multiline',
    'heading',
    '===',
    '',
    '<section title="text > id=\'quoted\'" ID = "section"></section><A NAME=legacy></A>',
    '<span data-id="metadata" name="other"></span>',
    '``<a id="example">`</a>``',
    '',
    '`sample',
    '<a id="multiline-example"></a>',
    'example`',
    '',
    '***',
    'After break',
    '---',
    '',
    'Read [these rules](#section "<a id=inline-title>")',
    '===',
    '',
    '[reference]: #section "<a id=reference-title>"',
    '',
    '<!--',
    '<span id="hidden"></span>',
    '--> [hidden](missing.md) <!-- \u2028<a id="hidden"> --> <a id="details"></a>',
  ].join('\n');
  for (const absent of [
    null,
    'quoted',
    'metadata',
    'other',
    'example',
    'multiline-example',
    'hidden',
    'inline-title',
    'reference-title',
  ]) {
    test(`${mode} checks heading and HTML anchor targets: ${absent ?? 'valid targets'}`, (t) => {
      const { root, base } = fixture(t);
      const targets = absent
        ? [absent]
        : [
            'section',
            'details',
            'legacy',
            'use-tag',
            'use-tag-1',
            'use-tag-1-1',
            'multiline-heading',
            'after-break',
            'read-these-rules',
          ];
      const links = targets.map((id) => `[target](#${id})`).join('\n');
      writeFileSync(join(root, 'README.md'), `${anchorDocument}\n\n${links}\n`);
      if (mode !== 'docs') git(root, 'add', 'README.md');
      if (mode === 'push') git(root, 'commit', '-m', 'anchor targets');
      const result = run(root, git(root, 'rev-parse', 'HEAD'), base, args);
      assert.equal(result.status, absent ? 1 : 0, result.stderr);
      if (absent) assert.ok(result.stderr.includes(`missing heading #${absent}`), result.stderr);
    });
  }

  test(`${mode} CLI finishes checking a long unfinished inline link within the child-process limit`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'README.md'), `# Start\n\n[unfinished](${'a'.repeat(32_768)}\n`);
    if (mode !== 'docs') git(root, 'add', 'README.md');
    if (mode === 'push') git(root, 'commit', '-m', 'unfinished link');
    const result = run(root, git(root, 'rev-parse', 'HEAD'), base, args, {}, 5_000);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${mode} CLI preserves normal and parenthesized links and rejects invalid local destinations`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'guide(v1).md'), '# Details\n');
    const outside = mkdtempSync(join(tmpdir(), 'stock-scout-link-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'outside.md'), '# Outside\n');
    const valid =
      '[normal](#start)\n[parentheses](guide(v1).md#details)\n[angle](<guide(v1).md#details>)\n[title](guide(v1).md#details "Guide")\n';
    for (const [link, diagnostic] of [
      ['', null],
      ['[missing](missing(v1).md)', /missing local target/],
      ['[heading](guide(v1).md#absent)', /missing heading/],
      [
        '[outside](escape.txt)',
        mode === 'docs' ? /local target leaves snapshot/ : /Symlink outside snapshot/,
      ],
      [`[unfinished](${'a'.repeat(32_768)}\n[missing](missing.md)`, /missing local target/],
    ]) {
      if (link === '[outside](escape.txt)')
        symlinkSync(join(outside, 'outside.md'), join(root, 'escape.txt'));
      else rmSync(join(root, 'escape.txt'), { force: true });
      writeFileSync(join(root, 'README.md'), `# Start\n\n${valid}${link ? `\n${link}\n` : ''}`);
      if (mode !== 'docs') git(root, 'add', '.');
      if (mode === 'push') git(root, 'commit', '-m', 'link destination');
      const result = run(root, git(root, 'rev-parse', 'HEAD'), base, args, {}, 5_000);
      assert.ifError(result.error);
      assert.equal(result.status, diagnostic ? 1 : 0, result.stderr);
      if (diagnostic) assert.match(result.stderr, diagnostic);
    }
  });

  for (const [target, title, diagnostic] of [
    ['missing.md', '"First title"', /missing local target missing\.md/],
    ['#absent', "'First title'", /missing heading #absent/],
  ]) {
    test(`${mode} CLI checks the second titled link to ${target} on the same line`, (t) => {
      const { root, base } = fixture(t);
      writeFileSync(
        join(root, 'README.md'),
        `# Start\n\n[First](#start ${title}) [Second](${target} "Second title")\n`,
      );
      if (mode !== 'docs') git(root, 'add', 'README.md');
      if (mode === 'push') git(root, 'commit', '-m', 'two titled links');
      const result = run(root, git(root, 'rev-parse', 'HEAD'), base, args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, diagnostic);
    });
  }

  test(`${mode} checks links around quoted code blocks`, async (t) => {
    const { root, base } = fixture(t);
    git(root, 'config', 'core.whitespace', 'cr-at-eol');
    const hook = mode === 'staged' ? 'pre-commit' : 'pre-push';
    if (mode !== 'docs') {
      const installed = run(root, '', '', [
        mode === 'staged' ? '--install-pre-commit' : '--install',
      ]);
      assert.equal(installed.status, 0, installed.stderr);
    }
    for (const [name, body, missing] of [
      ['closed quoted fence', '> ```md\n> [Example](example.md)\n> ```\n> [Valid](#start)\n'],
      ['quoted fence with CRLF line endings', '> ~~~\r\n> [Example](example.md)\r\n> ~~~\r\n'],
      [
        'broken inline link after a quoted fence',
        '> ```\n> [Example](example.md)\n> ```\n> [Broken](quoted.md)\n',
        'quoted.md',
      ],
      ['broken reference in a quote', '> [Broken]: reference.md\n', 'reference.md'],
      [
        'unclosed quoted fence ends with its quote',
        '> ```\n> [Example](example.md)\n\n[Broken](paragraph.md)\n',
        'paragraph.md',
      ],
      [
        'unclosed nested fence ends when the quote depth drops',
        '> > ~~~~md\n> > [Example](example.md)\n> [Broken](outer.md)\n',
        'outer.md',
      ],
      [
        'quoted code inside a list and list code inside a quote',
        '- > - ~~~md\n  >   [Example](example.md)\n  >   ~~~~\n  > [Valid](#start)\n',
      ],
      [
        'quoted list item starts with indented code',
        '> -     [Example](example.md)\n>       [Example](continued.md)\n',
      ],
      [
        'existing plain fenced and indented code',
        '```md\n> ```\n[Example](example.md)\n```\n\n    [Example](indented.md)\n',
      ],
    ]) {
      await t.test(name, () => {
        writeFileSync(join(root, 'README.md'), `# Start\n\n${body}`);
        if (mode !== 'docs') git(root, 'add', 'README.md');
        if (mode === 'push') git(root, 'commit', '-m', name);
        const result =
          mode === 'docs'
            ? run(root, '', '', args)
            : fixtureProcess(join(root, '.git/hooks', hook), [], {
                cwd: root,
                input: `refs/heads/main ${git(root, 'rev-parse', 'HEAD')} refs/heads/main ${base}\n`,
              });
        assert.ifError(result.error);
        assert.equal(result.status, missing ? 1 : 0, result.stderr);
        if (missing)
          assert.ok(result.stderr.includes(`missing local target ${missing}`), result.stderr);
      });
    }
  });
}

function installCommitHook(root) {
  const result = fixtureProcess(process.execPath, [cli, '--install-pre-commit'], {
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
}

function brokenModuleFixture(t) {
  const { root } = fixture(t, false);
  const compiler = fileURLToPath(new URL('../node_modules/typescript/lib/tsc.js', import.meta.url));
  writeFileSync(join(root, 'module.ts'), 'export const value = 1;\n');
  writeFileSync(
    join(root, 'caller.ts'),
    "import { value } from './module.js';\nconsole.log(value);\n",
  );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.typecheck = 'node typecheck.mjs';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'typecheck.mjs'),
    `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ${JSON.stringify([compiler, '--noEmit', '--target', 'esnext', '--module', 'nodenext', 'caller.ts'])}, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
  );
  const typecheck = () => fixtureProcess(process.execPath, ['typecheck.mjs'], { cwd: root });
  const valid = typecheck();
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'valid module');
  const base = git(root, 'rev-parse', 'HEAD');
  renameSync(join(root, 'module.ts'), join(root, 'module.md'));
  const broken = typecheck();
  assert.notEqual(broken.status, 0, broken.stdout + broken.stderr);
  assert.match(broken.stdout + broken.stderr, /Cannot find module ['"]\.\/module\.js['"]/);
  t.diagnostic(broken.stdout + broken.stderr);
  return { root, base };
}

test('pre-commit blocks a module renamed to Markdown with a broken staged import', (t) => {
  const { root, base } = brokenModuleFixture(t);
  installCommitHook(root);
  git(root, 'config', 'diff.renames', 'true');
  git(root, 'add', 'module.ts', 'module.md');
  writeFileSync(join(root, 'module.ts'), 'export const value = 1;\n');
  const staged = git(root, 'diff', '--cached', '--binary');
  const hook = readFileSync(join(root, '.git/hooks/pre-commit'));
  const result = fixtureProcess('git', ['commit', '-m', 'broken module rename'], {
    cwd: root,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /Cannot find module ['"]\.\/module\.js['"]/);
  assert.match(result.stderr, /pnpm run typecheck failed/);
  assert.doesNotMatch(result.stderr, /fixture test/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
  assert.equal(readFileSync(join(root, 'module.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(readFileSync(join(root, 'module.md'), 'utf8'), 'export const value = 1;\n');
  assert.deepEqual(readFileSync(join(root, '.git/hooks/pre-commit')), hook);
});

for (const renames of ['true', 'false']) {
  test(`pre-push blocks a module renamed to Markdown with diff.renames=${renames}`, (t) => {
    const { root, base } = brokenModuleFixture(t);
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    git(root, 'push', remote, 'HEAD:refs/heads/main');
    git(root, 'config', 'diff.renames', renames);
    git(root, 'add', 'module.ts', 'module.md');
    git(root, 'commit', '-m', 'broken module rename');
    writeFileSync(join(root, 'module.ts'), 'export const value = 1;\n');
    const installed = fixtureProcess(process.execPath, [cli, '--install'], {
      cwd: root,
    });
    assert.equal(installed.status, 0, installed.stderr);
    const index = readFileSync(join(root, '.git/index'));
    const hook = readFileSync(join(root, '.git/hooks/pre-push'));
    const result = fixtureProcess('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: root,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /Cannot find module ['"]\.\/module\.js['"]/);
    assert.match(result.stderr, /pnpm run typecheck failed/);
    assert.doesNotMatch(result.stderr, /fixture test/);
    assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'), base);
    assert.deepEqual(readFileSync(join(root, '.git/index')), index);
    assert.deepEqual(readFileSync(join(root, '.git/hooks/pre-push')), hook);
    assert.equal(readFileSync(join(root, 'module.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(readFileSync(join(root, 'module.md'), 'utf8'), 'export const value = 1;\n');
  });
}

for (const mode of ['staged', 'push']) {
  for (const [source, destination, code] of [
    ['document.md', 'renamed.md', false],
    ['module.ts', 'renamed.ts', true],
    ['document.md', 'renamed.ts', true],
  ]) {
    test(`${mode} CLI preserves check policy for ${source} renamed to ${destination}`, (t) => {
      const { root } = fixture(t);
      writeFileSync(join(root, source), 'export const value = 1;\n');
      git(root, 'add', source);
      git(root, 'commit', '-m', 'rename source');
      const base = git(root, 'rev-parse', 'HEAD');
      git(root, 'config', 'diff.renames', 'true');
      renameSync(join(root, source), join(root, destination));
      git(root, 'add', source, destination);
      if (mode === 'push') git(root, 'commit', '-m', 'rename file');
      const index = readFileSync(join(root, '.git/index'));
      const result = run(
        root,
        git(root, 'rev-parse', 'HEAD'),
        base,
        mode === 'staged' ? ['--staged'] : [],
      );
      assert.equal(result.status, 0, result.stderr);
      if (code) {
        assert.match(result.stderr, /fixture check/);
        assert.match(result.stderr, /fixture typecheck/);
        if (mode === 'push') assert.match(result.stderr, /fixture test/);
        else assert.doesNotMatch(result.stderr, /fixture test/);
      } else assert.doesNotMatch(result.stderr, /fixture check|fixture typecheck|fixture test/);
      assert.deepEqual(readFileSync(join(root, '.git/index')), index);
      assert.equal(readFileSync(join(root, destination), 'utf8'), 'export const value = 1;\n');
      assert.equal(existsSync(join(root, source)), false);
    });
  }
}

test('docs CLI checks selected working documents and untracked targets without changing the index', (t) => {
  const { root } = fixture(t);
  const document = '# Guide\n\n[Details](details.md#details)\n';
  writeFileSync(join(root, 'README.md'), document);
  writeFileSync(join(root, 'details.md'), '# Details\n');
  const index = readFileSync(join(root, '.git/index'));
  const result = fixtureProcess(process.execPath, [cli, '--docs', 'README.md', 'details.md'], {
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), document);
  assert.equal(git(root, 'diff', '--cached'), '');
  assert.equal(existsSync(join(root, '.git/hooks/pre-commit')), false);
});

test('docs CLI rejects a missing heading in an untracked working document', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'guide.md'), '# Guide\n\n[Missing](README.md#absent)\n');
  const result = fixtureProcess(process.execPath, [cli, '--docs', 'guide.md'], {
    cwd: root,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /missing heading/);
});

test('docs CLI rejects missing local files and working-copy whitespace', (t) => {
  const { root } = fixture(t);
  for (const [body, diagnostic] of [
    ['# Guide\n\n[Missing](absent.md)\n', /missing local target/],
    ['# Guide  \n', /trailing whitespace/],
  ]) {
    writeFileSync(join(root, 'guide.md'), body);
    const result = fixtureProcess(process.execPath, [cli, '--docs', 'guide.md'], {
      cwd: root,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, diagnostic);
    assert.equal(readFileSync(join(root, 'guide.md'), 'utf8'), body);
  }
});

test('docs CLI checks only selected files and resolves paths from a nested directory', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[Unselected](absent.md)\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'docs/guide.md'),
    '# 안내\n\n[설명](#설명)\n\n## 설명\n\n```md\n[Example](absent.md)\n```\n',
  );
  const result = fixtureProcess(process.execPath, [cli, '--docs', 'guide.md'], {
    cwd: join(root, 'docs'),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('docs CLI rejects outside files and symlink escapes before reading their content', (t) => {
  const { root } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'stock-scout-docs-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'outside.md'), '# PRIVATE_DOCUMENT_CONTENT  \n');
  symlinkSync(join(outside, 'outside.md'), join(root, 'escape.md'));
  mkdirSync(join(root, 'directory.md'));
  for (const path of [join(outside, 'outside.md'), 'escape.md', 'directory.md', 'package.json']) {
    const result = fixtureProcess(process.execPath, [cli, '--docs', path], {
      cwd: root,
    });
    assert.equal(result.status, 1, path);
    assert.match(result.stderr, /Markdown files inside the repository/);
    assert.doesNotMatch(result.stderr, /PRIVATE_DOCUMENT_CONTENT/);
  }
});

test('docs CLI rejects missing files and mixed operational flags without changing hooks or index', (t) => {
  const { root } = fixture(t);
  const index = readFileSync(join(root, '.git/index'));
  const hooks = readdirSync(join(root, '.git/hooks')).sort();
  for (const args of [
    ['--docs'],
    ['--docs', 'README.md', '--staged'],
    ['--docs', 'README.md', '--install'],
    ['--install', '--docs', 'README.md'],
    ['--staged', '--docs', 'README.md'],
  ]) {
    const result = fixtureProcess(process.execPath, [cli, ...args], {
      cwd: root,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: --docs/);
  }
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  assert.deepEqual(readdirSync(join(root, '.git/hooks')).sort(), hooks);
});

test('manual CLI rejects invalid arguments before changing hooks or index', async (t) => {
  for (const args of [
    ['--stage'],
    ['--install', 'extra'],
    ['--install-pre-commit', 'extra'],
    ['--staged', 'extra'],
    ['origin'],
    ['origin', 'remote.git', 'extra'],
  ]) {
    await t.test(args.join(' '), (t) => {
      const { root } = fixture(t);
      const index = readFileSync(join(root, '.git/index'));
      const hooks = readdirSync(join(root, '.git/hooks')).sort();
      const result = fixtureProcess(process.execPath, [cli, ...args], { cwd: root });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Usage:/);
      assert.deepEqual(readFileSync(join(root, '.git/index')), index);
      assert.deepEqual(readdirSync(join(root, '.git/hooks')).sort(), hooks);
    });
  }
});

test('all transmitted refs via legacy hook arguments still undergo checks and allow deletion', (t) => {
  const { root, base } = fixture(t);
  const args = ['origin', join(root, 'remote.git')];
  const checked = run(root, base, base, args);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, new RegExp(`Verified ${base}`));
  const deleted = run(root, '0'.repeat(40), base, args);
  assert.equal(deleted.status, 0, deleted.stderr);
});

for (const mode of ['staged', 'push']) {
  for (const failure of [false, true]) {
    test(`${mode} CLI removes its observed runner workspace after ${failure ? 'failed' : 'successful'} checks`, (t) => {
      const { root, base } = fixture(t);
      const temporary = join(root, 'runner-temporary');
      mkdirSync(temporary);
      const observed = join(root, 'observed.json');
      writeFileSync(
        join(root, 'observe.mjs'),
        `import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ snapshot: process.cwd(), temporary: tmpdir() }));
process.exit(${failure ? 23 : 0});
`,
      );
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      manifest.scripts.check = 'node observe.mjs';
      writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
      git(root, 'add', 'observe.mjs', 'package.json');
      if (mode === 'push') git(root, 'commit', '-m', 'observe runner workspace');
      const result = fixtureProcess(
        process.execPath,
        [cli, ...(mode === 'staged' ? ['--staged'] : [])],
        {
          cwd: root,
          input: `refs/heads/main ${git(root, 'rev-parse', 'HEAD')} refs/heads/main ${base}\n`,
          env: { TMPDIR: temporary },
        },
      );
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      if (failure) {
        assert.match(result.stderr, /pnpm run check failed/);
        assert.doesNotMatch(result.stderr, /fixture typecheck|fixture test|Verified/);
      } else {
        assert.match(result.stderr, /fixture typecheck/);
        assert.match(result.stderr, /Verified/);
        if (mode === 'staged') assert.doesNotMatch(result.stderr, /fixture test/);
        else assert.match(result.stderr, /fixture test/);
      }
      const paths = JSON.parse(readFileSync(observed, 'utf8'));
      assert.equal(dirname(paths.temporary), realpathSync(temporary));
      assert.equal(dirname(paths.snapshot), paths.temporary);
      assert.equal(existsSync(paths.temporary), false, 'runner workspace must be removed');
      assert.deepEqual(readdirSync(temporary), []);
    });
  }
}

test('installed pre-commit requires the pinned checker in the active staged tree', (t) => {
  const { root, base } = fixture(t);
  const checker = 'scripts/pre-push.ts';
  installCommitHook(root);
  const different = 'process.exit(0);\n';
  writeFileSync(join(root, checker), different);
  git(root, 'add', checker);
  copyFileSync(cli, join(root, checker));
  const commit = () => fixtureProcess('git', ['commit', '-m', 'staged update'], { cwd: root });
  const mismatch = commit();
  assert.notEqual(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stderr, /Checker differs/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  git(root, 'rm', '--cached', '-f', checker);
  const missing = commit();
  assert.notEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /Checker missing/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  rmSync(join(root, checker));
  symlinkSync('../README.md', join(root, checker));
  git(root, 'add', checker);
  const linked = commit();
  assert.notEqual(linked.status, 0, linked.stderr);
  assert.match(linked.stderr, /not a regular file/);
  rmSync(join(root, checker));
  copyFileSync(cli, join(root, checker));
  git(root, 'add', checker);
  writeFileSync(join(root, checker), 'process.exit(29);\n');
  writeFileSync(join(root, 'README.md'), '# Valid staged update\n');
  git(root, 'add', 'README.md');
  const matching = commit();
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stderr, /Verified staged tree/);
});

test('installed hook preserves the checker source bytes', (t) => {
  const { root } = fixture(t);
  const checker = join(root, 'scripts/pre-push.ts');
  const exactBytes = Buffer.concat([readFileSync(cli), Buffer.from([47, 47, 32, 255, 10])]);
  writeFileSync(checker, exactBytes);
  const installed = fixtureProcess(process.execPath, [checker, '--install-pre-commit'], {
    cwd: root,
  });
  assert.equal(installed.status, 0, installed.stderr);
  git(root, 'add', 'scripts/pre-push.ts');
  assert.match(git(root, 'commit', '-m', 'exact checker bytes'), /exact checker bytes/);
});

test('pre-commit checks the staged document and preserves an unstaged repair', (t) => {
  const { root, base } = fixture(t);
  installCommitHook(root);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[missing](missing.md)\n');
  git(root, 'add', 'README.md');
  writeFileSync(join(root, 'README.md'), '# Unstaged repair\n');
  const before = git(root, 'diff', '--cached', '--binary');
  const result = fixtureProcess('git', ['commit', '-m', 'broken staged document'], {
    cwd: root,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /missing\.md/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'diff', '--cached', '--binary'), before);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# Unstaged repair\n');
});

test('pre-commit refuses a changed active index after quality checks', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.check = `${gitForFixturePackageScript} -C "${root}" add README.md`;
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', 'package.json');
  writeFileSync(join(root, 'README.md'), '# Added during checks\n');
  installCommitHook(root);
  const result = fixtureProcess('git', ['commit', '-m', 'index changes during check'], {
    cwd: root,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /[Ii]ndex changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'show', ':README.md'), '# Added during checks');
});

test('staged CLI preserves the active index bytes', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'README.md'), '# Staged document\n');
  git(root, 'add', 'README.md');
  const index = join(root, '.git/index');
  const before = readFileSync(index);
  const result = fixtureProcess(process.execPath, [cli, '--staged'], {
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(index), before);
});

const initialCommitTest =
  'pre-commit supports the initial code commit without running the full test command';

test(initialCommitTest, (t) => {
  const { root } = fixture(t, false);
  git(root, 'add', 'README.md', 'package.json', 'scripts/pre-push.ts');
  installCommitHook(root);
  const result = fixtureProcess('git', ['commit', '-m', 'initial commit'], {
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /fixture check/);
  assert.match(result.stderr, /fixture typecheck/);
  assert.doesNotMatch(result.stderr, /fixture test/);
  assert.equal(git(root, 'show', 'HEAD:README.md'), '# Start');
});

test('hook tests preserve the calling repository and ignore its Git configuration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'stock-scout-git-caller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const caller = join(root, 'caller');
  const gitDir = join(caller, '.git');
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1' };
  const callerGit = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  callerGit('init', '-b', 'main', caller);
  callerGit('-C', caller, 'config', 'user.name', 'Caller');
  callerGit('-C', caller, 'config', 'user.email', 'caller@example.invalid');
  writeFileSync(join(caller, 'caller.txt'), 'caller\n');
  callerGit('-C', caller, 'add', 'caller.txt');
  callerGit('-C', caller, 'commit', '-m', 'caller baseline');
  writeFileSync(join(caller, 'caller.txt'), 'staged change\n');
  callerGit('-C', caller, 'add', 'caller.txt');
  const snapshot = () => ({
    index: readFileSync(join(gitDir, 'index')),
    config: readFileSync(join(gitDir, 'config')),
    refs: callerGit('-C', caller, 'show-ref', '--head'),
  });
  const before = snapshot();

  const gitConfig = join(root, '.gitconfig');
  writeFileSync(gitConfig, '[core]\n\thooksPath = missing-hooks\n');
  for (const callerEnv of [
    { GIT_DIR: gitDir, GIT_WORK_TREE: caller, GIT_INDEX_FILE: join(gitDir, 'index') },
    { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '0' },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern',
        `^${initialCommitTest}$`,
        fileURLToPath(import.meta.url),
      ],
      { cwd: caller, encoding: 'utf8', env: { ...env, ...callerEnv }, timeout: 15_000 },
    );
    assert.deepEqual(snapshot(), before, 'hook tests changed the caller repository');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 1\b/);
  }
});

test('pre-commit checks code in the index and honors the alternate index used by commit -a', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.check = 'node -e "process.exit(23)"';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', 'package.json');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, scripts: {} }));
  installCommitHook(root);
  const staged = git(root, 'diff', '--cached', '--binary');
  const failed = fixtureProcess('git', ['commit', '-m', 'bad staged code'], {
    cwd: root,
  });
  assert.notEqual(failed.status, 0, failed.stderr);
  assert.match(failed.stderr, /pnpm run check failed/);
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
  git(root, 'reset', 'package.json');
  const fixed = JSON.parse(git(root, 'show', 'HEAD:package.json'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(fixed));
  writeFileSync(join(root, 'README.md'), '[missing](absent.md)\n');
  const automatic = fixtureProcess('git', ['commit', '-am', 'bad automatic staging'], {
    cwd: root,
  });
  assert.notEqual(automatic.status, 0, automatic.stderr);
  assert.match(automatic.stderr, /absent\.md/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  writeFileSync(join(root, 'README.md'), '# Automatic staging\n');
  const good = fixtureProcess('git', ['commit', '-am', 'good automatic staging'], {
    cwd: root,
  });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(git(root, 'show', 'HEAD:README.md'), '# Automatic staging');
  assert.doesNotMatch(good.stderr, /fixture check|fixture typecheck|fixture test/);
});

test('pre-commit rechecks an explicit alternate index after quality commands mutate it', (t) => {
  const { root, base } = fixture(t);
  const alternate = join(root, 'alternate-index');
  copyFileSync(join(root, '.git/index'), alternate);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.check = `GIT_INDEX_FILE="${alternate}" ${gitForFixturePackageScript} -C "${root}" add README.md`;
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const env = { GIT_INDEX_FILE: alternate };
  const added = fixtureProcess('git', ['add', 'package.json'], { cwd: root, env });
  assert.equal(added.status, 0, added.stderr);
  writeFileSync(join(root, 'README.md'), '# Changed alternate index\n');
  const originalIndex = readFileSync(join(root, '.git/index'));
  installCommitHook(root);
  const result = fixtureProcess('git', ['commit', '-m', 'alternate changes during checks'], {
    cwd: root,
    env,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /[Ii]ndex changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.deepEqual(readFileSync(join(root, '.git/index')), originalIndex);
  const changed = fixtureProcess('git', ['show', ':README.md'], { cwd: root, env });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stdout, '# Changed alternate index\n');
});

test('staged CLI honors an explicit alternate index and preserves both indexes', (t) => {
  const { root } = fixture(t);
  const alternate = join(root, 'alternate-index');
  copyFileSync(join(root, '.git/index'), alternate);
  writeFileSync(join(root, 'README.md'), '[missing](alternate-missing.md)\n');
  const env = { GIT_INDEX_FILE: alternate };
  const added = fixtureProcess('git', ['add', 'README.md'], { cwd: root, env });
  assert.equal(added.status, 0, added.stderr);
  const normalBefore = readFileSync(join(root, '.git/index'));
  const alternateBefore = readFileSync(alternate);
  const result = fixtureProcess(process.execPath, [cli, '--staged'], {
    cwd: root,
    env,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /alternate-missing\.md/);
  assert.deepEqual(readFileSync(join(root, '.git/index')), normalBefore);
  assert.deepEqual(readFileSync(alternate), alternateBefore);
});

test('staged CLI rejects an unmerged index without changing it', (t) => {
  const { root } = fixture(t);
  installCommitHook(root);
  const blob = git(root, 'rev-parse', 'HEAD:README.md');
  const unmerged = fixtureProcess('git', ['update-index', '--index-info'], {
    cwd: root,
    input: `0 ${'0'.repeat(40)}\tREADME.md\n100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n`,
  });
  assert.equal(unmerged.status, 0, unmerged.stderr);
  const index = join(root, '.git/index');
  const before = readFileSync(index);
  const result = fixtureProcess(process.execPath, [cli, '--staged'], { cwd: root });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(index), before);
  const commit = fixtureProcess('git', ['commit', '-m', 'unmerged commit'], {
    cwd: root,
  });
  assert.notEqual(commit.status, 0, commit.stderr);
  assert.deepEqual(readFileSync(index), before);
});

test('pre-commit blocks staged whitespace errors in documents', (t) => {
  const { root, base } = fixture(t);
  installCommitHook(root);
  writeFileSync(join(root, 'README.md'), '# Trailing whitespace  \n');
  git(root, 'add', 'README.md');
  const result = fixtureProcess('git', ['commit', '-m', 'whitespace error'], {
    cwd: root,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /trailing whitespace/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
});

test('pre-commit installation is idempotent and preserves occupied and custom hook paths', (t) => {
  const { root } = fixture(t);
  installCommitHook(root);
  const hook = join(root, '.git/hooks/pre-commit');
  const installed = readFileSync(hook);
  installCommitHook(root);
  assert.deepEqual(readFileSync(hook), installed);
  writeFileSync(hook, '#!/bin/sh\nexit 27\n');
  const occupied = readFileSync(hook);
  const refused = fixtureProcess(process.execPath, [cli, '--install-pre-commit'], {
    cwd: root,
  });
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /preserved/);
  assert.deepEqual(readFileSync(hook), occupied);
  const scanner = '#!/bin/sh\n# gstack-redact pre-push (managed)\n# hooks/pre-push.local\nexit 0\n';
  writeFileSync(hook, scanner);
  const wrongKind = fixtureProcess(process.execPath, [cli, '--install-pre-commit'], {
    cwd: root,
  });
  assert.notEqual(wrongKind.status, 0, wrongKind.stderr);
  assert.match(wrongKind.stderr, /preserved/);
  assert.equal(readFileSync(hook, 'utf8'), scanner);
  assert.equal(existsSync(join(root, '.git/hooks/pre-push.local')), false);
  const custom = join(root, 'custom-hooks');
  git(root, 'config', 'core.hooksPath', custom);
  const configured = fixtureProcess(process.execPath, [cli, '--install-pre-commit'], {
    cwd: root,
  });
  assert.notEqual(configured.status, 0, configured.stderr);
  assert.match(configured.stderr, /core\.hooksPath/);
  assert.equal(existsSync(custom), false);
  assert.equal(readFileSync(hook, 'utf8'), scanner);

  const printed = run(root, '', '', ['--print-hook', 'pre-commit']);
  assert.equal(printed.status, 0, printed.stderr);
  mkdirSync(custom);
  writeFileSync(join(custom, 'stock-scout'), printed.stdout, { mode: 0o700 });
  writeFileSync(
    join(custom, 'pre-commit'),
    '#!/bin/sh\necho "user hook ran" >&2\nexec ./custom-hooks/stock-scout "$@"\n',
    { mode: 0o700 },
  );
  writeFileSync(join(root, 'README.md'), '# Custom hook integration\n');
  const commit = fixtureProcess('git', ['commit', '-am', 'custom hook'], { cwd: root });
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stderr, /user hook ran/);
  assert.match(commit.stderr, /Verified staged tree/);
});

test('failed hook installation leaves no executable at the destination and can be retried', (t) => {
  const { root } = fixture(t);
  const incompleteWrite = join(root, 'incomplete-write.cjs');
  writeFileSync(
    incompleteWrite,
    `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  if (options?.mode !== 0o700) return write(path, data, options);
  write(path, '#!/bin/sh\\n', options);
  throw new Error('fixture disk write failed');
};
syncBuiltinESMExports();
`,
  );
  const result = fixtureProcess(process.execPath, [cli, '--install-pre-commit'], {
    cwd: root,
    env: { NODE_OPTIONS: `--require="${incompleteWrite}"` },
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /fixture disk write failed/);
  assert.equal(existsSync(join(root, '.git/hooks/pre-commit')), false);
  installCommitHook(root);
});

test('pre-commit installs locked dependencies from the store before running checks', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const actual = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  manifest.devDependencies = { ...actual.devDependencies };
  manifest.scripts.check = 'node check.cjs';
  writeFileSync(
    join(root, 'check.cjs'),
    `const { strictEqual } = require('node:assert');
const { statSync } = require('node:fs');
const manifest = require.resolve('typescript/package.json');
strictEqual(statSync(manifest).nlink, 1);
console.error('fixture check');
`,
  );
  manifest.scripts.postinstall = `node -e "throw new Error('unexpected install script')"`;
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  copyFileSync(new URL('../pnpm-lock.yaml', import.meta.url), join(root, 'pnpm-lock.yaml'));
  git(root, 'add', 'package.json', 'pnpm-lock.yaml', 'check.cjs');
  installCommitHook(root);
  const staged = git(root, 'diff', '--cached', '--binary');
  const prepared = spawnSync('pnpm', ['store', 'path'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const commit = (store) =>
    fixtureProcess('git', ['commit', '-m', 'dependencies prepared'], {
      cwd: root,
      env: { npm_config_store_dir: store },
    });
  const missing = commit(join(root, 'empty-store'));
  assert.notEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /ERR_PNPM_NO_OFFLINE_TARBALL/);
  assert.doesNotMatch(missing.stderr, /fixture check/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
  assert.equal(existsSync(join(root, 'node_modules')), false);

  manifest.devDependencies.typescript = '0.0.0';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', 'package.json');
  const mismatch = commit(prepared.stdout.trim());
  assert.notEqual(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.doesNotMatch(mismatch.stderr, /fixture check/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);

  manifest.devDependencies = {};
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', 'package.json');
  const staleLock = commit(prepared.stdout.trim());
  assert.notEqual(staleLock.status, 0, staleLock.stderr);
  assert.match(staleLock.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);

  manifest.devDependencies = actual.devDependencies;
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'original');
  writeFileSync(
    join(root, '.npmrc'),
    `modules-dir=${join(outside, 'modules')}\nvirtual-store-dir=${join(outside, 'virtual')}\n`,
  );
  git(root, 'add', 'package.json', '.npmrc');
  const good = commit(prepared.stdout.trim());
  assert.deepEqual(readdirSync(outside), ['keep'], good.stderr);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'original');
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stderr, /fixture check/);
  assert.match(good.stderr, /fixture typecheck/);
  assert.doesNotMatch(good.stderr, /fixture test|unexpected install script/);
  assert.equal(existsSync(join(root, 'node_modules')), false);

  const push = run(root, git(root, 'rev-parse', 'HEAD'), base, [], {
    npm_config_store_dir: prepared.stdout.trim(),
  });
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stderr, /fixture check/);
  assert.match(push.stderr, /fixture typecheck/);
  assert.match(push.stderr, /fixture test/);
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('pre-commit distinguishes an unavailable quality check from a failed check', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  delete manifest.scripts.typecheck;
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', 'package.json');
  installCommitHook(root);
  const result = fixtureProcess('git', ['commit', '-m', 'unavailable check'], {
    cwd: root,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /Quality check unavailable: pnpm run typecheck is not configured/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
});

test('pre-push rejects a broken committed link even when the working copy fixes it', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[missing](missing.md)\n');
  git(root, 'commit', '-am', 'broken link');
  const tip = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), '# Working copy fixes the link\n');
  const before = git(root, 'status', '--porcelain');
  const result = run(root, tip, base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /missing\.md/);
  assert.equal(git(root, 'status', '--porcelain'), before);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# Working copy fixes the link\n');
});

test('pre-push gives quality checks a temporary directory outside the source snapshot', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(
    join(root, 'temporary.mjs'),
    `
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'credentials-'));
try {
  const path = relative(realpathSync(process.cwd()), realpathSync(directory));
  assert.ok(path === '..' || path.startsWith('../') || isAbsolute(path), 'credentials must be outside source');
} finally { rmSync(directory, { recursive: true, force: true }); }
`,
  );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.test = 'node temporary.mjs';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'temporary directory boundary');
  const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(result.status, 0, result.stderr);
});

test('pre-push blocks code changes on a failing quality command', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts.check = 'node -e "console.error(\'fixture check failure\');process.exit(1)"';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'commit', '-am', 'failing check');
  const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fixture check failure/);
  assert.doesNotMatch(result.stderr, /fixture typecheck|fixture test/);
});

test('documentation pushes check fragments and reference links without running code checks', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[self](#absent)\n');
  git(root, 'commit', '-am', 'broken fragment');
  const broken = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /missing heading.*absent/);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[self](#start)\n\n[reference]: nowhere.md\n');
  git(root, 'commit', '-am', 'broken reference');
  const reference = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(reference.status, 1, reference.stderr);
  assert.match(reference.stderr, /nowhere\.md/);
  writeFileSync(join(root, 'README.md'), '# Start\n\n[self](#start)\n');
  git(root, 'commit', '-am', 'valid docs');
  const good = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(good.status, 0, good.stderr);
  assert.doesNotMatch(good.stderr, /fixture check|fixture typecheck|fixture test/);
});

for (const mode of ['staged', 'push'])
  test(`${mode} link checks preserve per-target headings across repeated references (characterization)`, (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'first.md'), '# First\n\n## Details\n');
    writeFileSync(join(root, 'second.md'), '# Second\n');
    const links =
      '# Start\n\n[First](first.md#first)\n[Details](first.md#details)\n[Second](second.md#second)\n';
    for (const fragment of ['first', 'second']) {
      writeFileSync(join(root, 'README.md'), `${links}[Again](first.md#${fragment})\n`);
      git(root, 'add', '.');
      if (mode === 'push') git(root, 'commit', '-m', `reference ${fragment}`);
      const result = run(
        root,
        git(root, 'rev-parse', 'HEAD'),
        base,
        mode === 'staged' ? ['--staged'] : [],
      );
      assert.equal(result.status, fragment === 'first' ? 0 : 1, result.stderr);
      if (fragment === 'second') assert.match(result.stderr, /missing heading.*first\.md#second/);
      assert.doesNotMatch(result.stderr, /fixture check|fixture typecheck|fixture test/);
    }
  });

test('installed pre-push requires one pinned checker across every non-deletion ref', (t) => {
  const { root, base } = fixture(t);
  const checker = 'scripts/pre-push.ts';
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  assert.equal(run(root, '', '', ['--install']).status, 0);
  const push = (...refs) => fixtureProcess('git', ['push', remote, ...refs], { cwd: root });
  const main = 'refs/heads/main';
  const peer = 'refs/heads/peer';
  const refs = () =>
    git(root, '--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)');

  writeFileSync(join(root, checker), 'process.exit(0);\n');
  git(root, 'commit', '-am', 'checker differs');
  git(root, 'branch', 'different');
  copyFileSync(cli, join(root, checker));
  git(
    root,
    'replace',
    git(root, 'rev-parse', `different:${checker}`),
    git(root, 'rev-parse', `${base}:${checker}`),
  );
  const mismatch = push(`${base}:${main}`, `different:${peer}`);
  assert.notEqual(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stderr, /Checker differs/);
  assert.doesNotMatch(mismatch.stderr, /fixture check|Verified /);
  assert.equal(refs(), '');
  git(root, 'replace', '-d', git(root, 'rev-parse', `different:${checker}`));

  git(root, 'rm', '--cached', '-f', checker);
  git(root, 'commit', '-m', 'checker missing');
  const missing = push(`HEAD:${main}`);
  assert.notEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /Checker missing/);
  assert.equal(refs(), '');

  rmSync(join(root, checker));
  const matching = push(`${base}:${main}`, `${base}:${peer}`);
  assert.equal(matching.status, 0, matching.stderr);
  assert.equal(refs(), `${main} ${base}\n${peer} ${base}`);
  const mixed = push(`:${peer}`, 'HEAD:refs/heads/missing');
  assert.notEqual(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stderr, /Checker missing/);
  assert.equal(refs(), `${main} ${base}\n${peer} ${base}`);
  const deletion = push(`:${peer}`);
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.equal(refs(), `${main} ${base}`);
});

test('installed hook preserves the existing scanner and blocks an actual local push', (t) => {
  const { root } = fixture(t);
  const hook = join(root, '.git/hooks/pre-push');
  const scanner = `#!/bin/sh
# gstack-redact pre-push (managed)
input="$(cat)"
local_hook="$(git rev-parse --git-path hooks/pre-push.local)"
if [ -x "$local_hook" ]; then
  printf '%s' "$input" | "$local_hook" "$@" || exit $?
fi
echo 'fixture scanner ran' >&2
`;
  writeFileSync(hook, scanner, { mode: 0o700 });
  const local = join(root, '.git/hooks/pre-push.local');
  const legacy =
    '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/scripts/pre-push.ts" "$@"\n';
  writeFileSync(local, legacy, { mode: 0o700 });
  const refused = run(root, '', '', ['--install']);
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /preserved/);
  assert.equal(readFileSync(local, 'utf8'), legacy);
  const backup = join(root, 'legacy-push-backup');
  copyFileSync(local, backup);
  const printed = run(root, '', '', ['--print-hook', 'pre-push']);
  assert.equal(printed.status, 0, printed.stderr);
  const draft = join(dirname(local), 'stock-scout-draft');
  writeFileSync(draft, printed.stdout, { mode: 0o700 });
  renameSync(draft, local);

  const installed = run(root, '', '', ['--install']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(hook, 'utf8'), scanner);
  assert.equal(readFileSync(backup, 'utf8'), legacy);
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  const first = fixtureProcess('git', ['push', remote, 'HEAD:refs/heads/main'], {
    cwd: root,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /fixture scanner ran/);
  const good = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), '[missing](absent.md)\n');
  git(root, 'commit', '-am', 'bad docs');
  const bad = fixtureProcess('git', ['push', remote, 'HEAD:refs/heads/main'], {
    cwd: root,
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /absent\.md/);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'), good);
  assert.equal(readFileSync(hook, 'utf8'), scanner);
});

test('code pushes run every quality command and refuse missing dependencies', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(join(root, 'code.js'), 'export const answer = 42;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'code change');
  const good = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(good.status, 0, good.stderr);
  for (const command of ['check', 'typecheck', 'test']) {
    assert.match(good.stderr, new RegExp(`fixture ${command}`));
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.devDependencies = { 'missing-fixture-dependency': '1.0.0' };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  git(root, 'commit', '-am', 'requires dependencies');
  const missing = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /expected a snapshot pnpm-lock.yaml file/);
  assert.doesNotMatch(missing.stderr, /fixture check/);
});

for (const name of ['pre-push', 'pre-push.local']) {
  test(`hook installation preserves and rejects user-owned 0655 ${name}`, (t) => {
    const { root } = fixture(t);
    const hooks = join(root, '.git/hooks');
    if (name === 'pre-push.local') {
      writeFileSync(
        join(hooks, 'pre-push'),
        '#!/bin/sh\n# gstack-redact pre-push (managed)\nexec "$(git rev-parse --git-path hooks/pre-push.local)" "$@"\n',
        { mode: 0o700 },
      );
    }
    const installed = run(root, '', '', ['--install']);
    assert.equal(installed.status, 0, installed.stderr);
    const path = join(hooks, name);
    const bytes = readFileSync(path);
    chmodSync(path, 0o655);
    const refused = run(root, '', '', ['--install']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mode & 0o777, 0o655);
  });
}

test('hook installation with a restrictive umask leaves the destination absent', (t) => {
  const { root } = fixture(t);
  const result = fixtureProcess(
    'sh',
    ['-c', 'umask 0111 && exec "$@"', 'install', process.execPath, cli, '--install'],
    { cwd: root },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(join(root, '.git/hooks/pre-push')), false);
});

test('hook installation rejects a draft created without execute permission', (t) => {
  const { root } = fixture(t);
  const preload = join(root, 'file-umask.cjs');
  writeFileSync(
    preload,
    `const fs = require('node:fs');
const write = fs.writeFileSync;
fs.writeFileSync = (...args) => {
  process.umask(0o111);
  return write(...args);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  const result = run(root, '', '', ['--install'], { NODE_OPTIONS: `--require="${preload}"` });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(join(root, '.git/hooks/pre-push')), false);
});

test('hook installation is idempotent and preserves an occupied hook slot', (t) => {
  const { root } = fixture(t);
  const first = run(root, '', '', ['--install']);
  assert.equal(first.status, 0, first.stderr);
  const hook = join(root, '.git/hooks/pre-push');
  const bytes = readFileSync(hook);
  const again = run(root, '', '', ['--install']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(readFileSync(hook), bytes);
  writeFileSync(hook, '#!/bin/sh\nexit 17\n');
  const occupied = readFileSync(hook);
  const refusal = run(root, '', '', ['--install']);
  assert.equal(refusal.status, 1, refusal.stderr);
  assert.match(refusal.stderr, /preserved/);
  assert.deepEqual(readFileSync(hook), occupied);
});

test('all transmitted refs are checked, deletions are skipped, malformed input fails', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(join(root, 'README.md'), '[absent](missing.md)\n');
  git(root, 'commit', '-am', 'broken tip');
  const bad = git(root, 'rev-parse', 'HEAD');
  const zero = '0'.repeat(40);
  const input = `refs/heads/good ${base} refs/heads/good ${base}\nrefs/heads/bad ${bad} refs/heads/bad ${base}\n`;
  const multiple = fixtureProcess(process.execPath, [cli], { cwd: root, input });
  assert.equal(multiple.status, 1, multiple.stderr);
  assert.match(multiple.stderr, /missing\.md/);
  const deletion = run(root, zero, base);
  assert.equal(deletion.status, 0, deletion.stderr);
  const invalid = run(root, 'invalid', zero);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /Invalid pre-push input/);
});

test('committed whitespace errors block a documentation push', (t) => {
  const { root, base } = fixture(t);
  writeFileSync(join(root, 'README.md'), '# Start  \n');
  git(root, 'commit', '-am', 'trailing whitespace');
  const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /trailing whitespace/);
});

test('code examples do not become local link requirements', (t) => {
  const { root, base } = fixture(t);
  for (const example of [
    '    [sample](missing.md)\n',
    '\t[sample](missing.md)\n',
    '```md\n[sample](missing.md)\n',
    '~~~md\n[sample](missing.md)\n~~~~\n',
    '````md\n```\n[sample](missing.md)\n````\n',
  ]) {
    writeFileSync(join(root, 'README.md'), `# Start\n\n${example}`);
    git(root, 'commit', '-am', 'code example');
    const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('nested list links remain checked while list code examples are ignored', (t) => {
  const { root, base } = fixture(t);
  for (const text of [
    '- Parent\n    - [broken](missing.md)\n',
    '- Parent\n\n    - [broken](missing.md)\n',
    '- Parent\n\n    [broken](missing.md)\n',
  ]) {
    writeFileSync(join(root, 'README.md'), text);
    git(root, 'commit', '-am', 'nested link');
    const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /missing\.md/);
  }
  writeFileSync(join(root, 'README.md'), '- Parent\n\n      [code](missing.md)\n');
  git(root, 'commit', '-am', 'list code');
  const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(result.status, 0, result.stderr);
});

function skillFixture(t, name = 'sample') {
  const { root, base } = fixture(t);
  const directory = join(root, '.agents/skills', name);
  mkdirSync(join(directory, 'agents'), { recursive: true });
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---
name: ${name}
disable-model-invocation: true
---

# Example
`,
  );
  writeFileSync(
    join(directory, 'agents/openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
  );
  writeFileSync(join(directory, 'UPSTREAM.md'), '# Provenance\n');
  writeFileSync(join(directory, 'LICENSE'), 'Synthetic fixture license\n');
  symlinkSync(`../../.agents/skills/${name}`, join(root, '.claude/skills', name));
  return { root, base, directory, link: join(root, '.claude/skills', name) };
}

for (const mode of ['staged', 'push']) {
  test(`${mode} snapshot validates tracked symlinks before quality checks`, async (t) => {
    const { root, base } = skillFixture(t);
    const staged = mode === 'staged';
    const installed = run(root, '', '', [staged ? '--install-pre-commit' : '--install']);
    assert.equal(installed.status, 0, installed.stderr);
    const link = join(root, 'alias');
    for (const [name, target, error] of [
      ['internal', '.claude/skills/sample', null],
      ['missing', 'missing', /Unresolved snapshot symlink/],
      ['loop', 'alias', /Unresolved snapshot symlink/],
      ['external', join(root, 'README.md'), /Symlink outside snapshot/],
    ]) {
      await t.test(name, () => {
        rmSync(link, { force: true });
        symlinkSync(target, link);
        git(root, 'add', '.');
        if (!staged) git(root, 'commit', '-m', 'snapshot link');
        const hook = join(root, '.git/hooks', staged ? 'pre-commit' : 'pre-push');
        const result = fixtureProcess(hook, [], {
          cwd: root,
          input: `refs/heads/main ${git(root, 'rev-parse', 'HEAD')} refs/heads/main ${base}\n`,
        });
        assert.equal(result.status, error ? 1 : 0, result.stderr);
        if (error) {
          assert.match(result.stderr, error);
          assert.doesNotMatch(result.stderr, /fixture check|fixture typecheck|fixture test/);
          assert.ok(!result.stderr.includes(root));
        } else assert.match(result.stderr, /fixture check/);
      });
    }
  });
}

test('pre-push rejects a committed skill link even when the working copy repairs it', (t) => {
  const { root, base, link } = skillFixture(t);
  rmSync(link);
  symlinkSync('../../.agents/skills/other', link);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'broken skill link');
  const tip = git(root, 'rev-parse', 'HEAD');
  rmSync(link);
  symlinkSync('../../.agents/skills/sample', link);
  const before = git(root, 'status', '--porcelain');
  const broken = run(root, tip, base);
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /Unresolved snapshot symlink/);
  assert.equal(git(root, 'status', '--porcelain'), before);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'repair skill link');
  const good = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(good.status, 0, good.stderr);
  for (const target of [null, 'regular', join(root, '.agents/skills/sample')]) {
    rmSync(link, { force: true });
    if (target === 'regular') writeFileSync(link, 'not a symlink\n');
    else if (target !== null) symlinkSync(target, link);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'invalid skill link kind');
    const invalid = run(root, git(root, 'rev-parse', 'HEAD'), base);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(
      invalid.stderr,
      target && target !== 'regular' ? /Symlink outside snapshot/ : /sample.*relative symlink/,
    );
  }
});

for (const mode of ['staged', 'push']) {
  test(`${mode} skill invocation settings require YAML separators`, async (t) => {
    const { root, base, directory } = skillFixture(t);
    for (const [manual, policy, implicit, valid] of [
      [' true', 'policy:', ' false', true],
      [' false # automatic', 'policy: # settings', ' true # allowed', true],
      ['true', 'policy:', ' false', false],
      [' true#disabled', 'policy:', ' false', false],
      [' true', 'policy:', 'false', false],
      [' true', 'policy:', ' false#disabled', false],
      [' true', 'policy:#settings', ' false', false],
    ]) {
      const frontmatter = `disable-model-invocation:${manual}`;
      const setting = `allow_implicit_invocation:${implicit}`;
      await t.test(`${frontmatter}, ${policy}, ${setting}`, () => {
        writeFileSync(join(directory, 'SKILL.md'), `---\nname: sample\n${frontmatter}\n---\n`);
        writeFileSync(join(directory, 'agents/openai.yaml'), `${policy}\n  ${setting}\n`);
        git(root, 'add', '.');
        if (mode === 'push') git(root, 'commit', '-m', 'skill invocation settings');
        const args = mode === 'staged' ? ['--staged'] : [];
        const result = run(root, git(root, 'rev-parse', 'HEAD'), base, args);
        assert.equal(result.status, valid ? 0 : 1, result.stderr);
        if (!valid) assert.match(result.stderr, /sample: invocation metadata/);
      });
    }
  });
}

test('pre-push rejects inconsistent or ambiguous skill invocation settings', (t) => {
  const { root, base, directory } = skillFixture(t);
  for (const yaml of [
    'policy:\n  allow_implicit_invocation: true\n',
    'policy:\n  allow_implicit_invocation: "false"\n',
    'policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true\n',
    'policy: {allow_implicit_invocation: false}\n',
  ]) {
    writeFileSync(join(directory, 'agents/openai.yaml'), yaml);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'invalid invocation settings');
    const result = run(root, git(root, 'rev-parse', 'HEAD'), base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /sample.*invocation/);
  }
  writeFileSync(
    join(directory, 'agents/openai.yaml'),
    '# Codex policy\npolicy: # explicit invocation\n    allow_implicit_invocation: false # disabled\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'valid invocation settings');
  const good = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(good.status, 0, good.stderr);
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: sample\ndisable-model-invocation: false\n---\n\n# Revised title\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'mismatched Claude setting');
  const mismatch = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(mismatch.status, 1, mismatch.stderr);
  assert.match(mismatch.stderr, /sample.*invocation/);
  for (const fields of [
    'disable-model-invocation: true\n"disable-model-invocation": false',
    'disable-model-invocation: true\n  false',
  ]) {
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: sample\n${fields}\n---\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'ambiguous frontmatter');
    const ambiguous = run(root, git(root, 'rev-parse', 'HEAD'), base);
    assert.equal(ambiguous.status, 1, ambiguous.stderr);
    assert.match(ambiguous.stderr, /sample.*invocation/);
  }
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: sample\ndisable-model-invocation: false\n---\n',
  );
  writeFileSync(
    join(directory, 'agents/openai.yaml'),
    'policy:\n  allow_implicit_invocation: true\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'consistent implicit invocation');
  const implicit = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(implicit.status, 0, implicit.stderr);
});

test('pre-push requires a nonempty regular license only for adapted skills', (t) => {
  const { root, base, directory } = skillFixture(t, 'another');
  const license = join(directory, 'LICENSE');
  for (const content of [null, '', '\n\n']) {
    if (content === null) rmSync(license);
    else writeFileSync(license, content);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'missing or empty license');
    const tip = git(root, 'rev-parse', 'HEAD');
    writeFileSync(license, 'Working copy license repair\n');
    const before = git(root, 'status', '--porcelain');
    const result = run(root, tip, base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /another.*LICENSE/);
    assert.equal(git(root, 'status', '--porcelain'), before);
  }
  rmSync(license);
  symlinkSync('SKILL.md', license);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'linked license');
  const linked = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(linked.status, 1, linked.stderr);
  assert.match(linked.stderr, /LICENSE.*regular file/);
  rmSync(license);
  rmSync(join(directory, 'UPSTREAM.md'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'native project skill');
  const native = run(root, git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(native.status, 0, native.stderr);
});

test('push CLI honors the pnpm test loopback preflight', (t) => {
  const { root, base } = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const actualManifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  manifest.type = 'module';
  manifest.scripts.test = actualManifest.scripts.test;
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/fixture.test.mjs'), "console.error('fixture test');\n");
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  copyFileSync(
    new URL('../scripts/test-preflight.ts', import.meta.url),
    join(root, 'scripts/test-preflight.ts'),
  );
  writeFileSync(
    join(root, 'network.cjs'),
    `
const net = require('node:net');
net.Server.prototype.listen = function () {
  process.nextTick(() => this.emit('error', Object.assign(new Error('denied'), { code: 'EPERM' })));
  return this;
};
`,
  );
  mkdirSync(join(root, 'bin'));
  const nodeWrapper = join(root, 'bin/node');
  writeFileSync(
    nodeWrapper,
    `#!/bin/sh\nNODE_OPTIONS="--require=\\"\${0%/*}/../network.cjs\\"" exec "${process.execPath}" "$@"\n`,
  );
  chmodSync(nodeWrapper, 0o755);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'add preflight');
  const tip = git(root, 'rev-parse', 'HEAD');
  const denied = run(root, tip, base, [], { PATH: `${join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(denied.status, 1, denied.stderr);
  assert.match(denied.stderr, /Environment error/);
  assert.match(denied.stderr, /tests not run/);
  assert.doesNotMatch(denied.stderr, /fixture test/);
  const success = run(root, tip, base);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stderr, /fixture test/);
});
