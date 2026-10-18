import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cli = new URL('../scripts/pre-push.ts', import.meta.url).pathname;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stock-scout-push-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
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
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  return { root, base };
}

function run(root, tip, base, args = []) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: `refs/heads/main ${tip} refs/heads/main ${base}\n`,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir() },
  });
}

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

test('installed hook preserves the existing scanner and blocks an actual local push', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(cli, join(root, 'scripts/pre-push.ts'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'add runner');
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
  const installed = run(root, '', '', ['--install']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(hook, 'utf8'), scanner);
  assert.ok(readFileSync(join(root, '.git/hooks/pre-push.local'), 'utf8').includes('pre-push.ts'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  const first = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /fixture scanner ran/);
  const good = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), '[missing](absent.md)\n');
  git(root, 'commit', '-am', 'bad docs');
  const bad = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
    cwd: root,
    encoding: 'utf8',
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
  assert.match(missing.stderr, /Prepare installed dependencies/);
  assert.doesNotMatch(missing.stderr, /fixture check/);
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
  const multiple = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8', input });
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
  assert.match(broken.stderr, /sample.*relative symlink/);
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
    assert.match(invalid.stderr, /sample.*relative symlink/);
  }
});

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
