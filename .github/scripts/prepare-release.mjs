#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootUrl = new URL('../../', import.meta.url);
const root = fileURLToPath(rootUrl);
const files = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
];
const read = (path) => readFileSync(new URL(path, rootUrl), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

function main() {
  const tag = process.argv[2];
  if (process.argv.length !== 3 || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Usage: node .github/scripts/prepare-release.mjs vMAJOR.MINOR.PATCH');
  }
  if (git('status', '--porcelain', '--untracked-files=all').trim()) {
    throw new Error('Commit or stash your changes first; preparing a release requires a clean working tree.');
  }
  if (git('tag', '--list', tag).trim()) throw new Error(`Local tag ${tag} already exists.`);

  const version = tag.slice(1);
  // Prepare every edit before writing any file.
  const updates = new Map();
  for (const path of files.slice(0, 3)) {
    const data = JSON.parse(read(path));
    data.version = version;
    if (path === 'package-lock.json') data.packages[''].version = version;
    updates.set(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  const cargo = read('src-tauri/Cargo.toml');
  const lock = read('src-tauri/Cargo.lock');
  function updateSection(text, separator, matches) {
    const sections = text.split(separator);
    const targets = sections.filter(matches);
    if (targets.length !== 1 || !/^version\s*=\s*"[^"]+"/m.test(targets[0])) {
      throw new Error('Could not locate a unique rsedit package version in Cargo metadata.');
    }
    return sections.map((section) => matches(section)
      ? section.replace(/^(version\s*=\s*")[^"]+(".*)$/m, (_, prefix, suffix) => `${prefix}${version}${suffix}`)
      : section).join(separator);
  }
  updates.set('src-tauri/Cargo.toml', updateSection(cargo, '\n[', (section) => section.startsWith('[package]') || section.startsWith('package]')));
  updates.set('src-tauri/Cargo.lock', updateSection(lock, '[[package]]', (section) => /^name = "rsedit"$/m.test(section)));
  if ([...updates].every(([path, content]) => read(path) === content)) {
    throw new Error(`Version is already ${version}; no version commit to create.`);
  }

  for (const [path, content] of updates) writeFileSync(new URL(path, rootUrl), content);
  execFileSync(process.execPath, ['.github/scripts/check-release.mjs', tag], { cwd: root, stdio: 'inherit' });
  git('add', '--', ...files);
  execFileSync('git', ['commit', '-m', `Release ${tag}`], { cwd: root, stdio: 'inherit' });
  git('tag', '-a', tag, '-m', `Release ${tag}`);
  console.log(`Created local release commit and tag ${tag}. Nothing was pushed.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
