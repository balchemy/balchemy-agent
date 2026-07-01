const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const binEntries = packageJson.bin && typeof packageJson.bin === 'object'
  ? Object.values(packageJson.bin)
  : [];

for (const relativeBinPath of new Set(binEntries)) {
  if (typeof relativeBinPath !== 'string') {
    continue;
  }

  const absoluteBinPath = path.join(packageRoot, relativeBinPath);
  fs.chmodSync(absoluteBinPath, 0o755);
}
