import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));
const config = json('src-tauri/tauri.conf.json');
const version = config.version;
const tag = process.argv[2] || process.env.RELEASE_TAG;
const assetsPath = process.argv[3];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(
  typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
  'Release version must be a numeric major.minor.patch version.',
);

const cargoPackage = read('src-tauri/Cargo.toml')
  .split(/^\[/m)
  .find((section) => section.startsWith('package]'));
const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockPackage = read('src-tauri/Cargo.lock')
  .split('[[package]]')
  .find((section) => /^name = "rsedit"$/m.test(section));
const cargoLockVersion = cargoLockPackage?.match(/^version = "([^"]+)"/m)?.[1];
const npmLock = json('package-lock.json');
for (const [name, actual] of Object.entries({
  'package.json': json('package.json').version,
  'package-lock.json': npmLock.version,
  'package-lock.json root package': npmLock.packages?.['']?.version,
  'src-tauri/Cargo.toml': cargoVersion,
  'src-tauri/Cargo.lock': cargoLockVersion,
})) {
  requireCondition(actual === version, `${name} version must match Tauri ${version}.`);
}
if (tag !== undefined) {
  requireCondition(tag === `v${version}`, `Release tag must be v${version}.`);
}

// Per-bundle architecture names follow tauri-action.
const suffixes = [
  'darwin-aarch64-dmg.dmg',
  'darwin-x64-dmg.dmg',
  'windows-x64-nsis-setup.exe',
  'windows-x64-msi.msi',
  'windows-arm64-nsis-setup.exe',
  'windows-arm64-msi.msi',
  'linux-amd64-appimage.AppImage',
  'linux-amd64-deb.deb',
  'linux-x86_64-rpm.rpm',
  'linux-aarch64-appimage.AppImage',
  'linux-arm64-deb.deb',
  'linux-aarch64-rpm.rpm',
];
const expectedNames = suffixes.map((suffix) => `rsedit-v${version}-${suffix}`);

if (assetsPath) {
  // gh api --paginate --slurp produces an array of pages.
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8')).flat();
  for (const name of expectedNames) {
    const matches = assets.filter((asset) => asset.name === name);
    requireCondition(
      matches.length === 1 && matches[0].size > 0 && matches[0].state === 'uploaded',
      `Release is missing a complete installer: ${name}`,
    );
  }
  console.log('All twelve release installers are uploaded and nonempty.');
}

console.log(`Release metadata and installer naming match v${version}.`);
