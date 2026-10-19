import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const rgPath = path.join(rootDir, 'node_modules/@vscode/ripgrep/bin/rg');

console.log('Running undo-telemetry (VSCodium style)...');

let matchingFiles = [];
try {
  const output = execFileSync(
    rgPath,
    ['--no-ignore', '-l', '\\.data\\.microsoft\\.com', 'src/', 'build/', 'extensions/'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }
  );
  matchingFiles = output.trim().split('\n').filter(Boolean);
} catch (e) {
  if (e.stdout) {
    matchingFiles = e.stdout.trim().split('\n').filter(Boolean);
  } else {
    matchingFiles = [];
  }
}

let modifiedCount = 0;
for (const relPath of matchingFiles) {
  const fullPath = path.join(rootDir, relPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const replaced = content.replace(/\/\/[^/]+\.data\.microsoft\.com/g, '//0.0.0.0');
    if (replaced !== content) {
      fs.writeFileSync(fullPath, replaced, 'utf8');
      modifiedCount++;
    }
  } catch (err) {
    // Ignore unreadable binary or locked files
  }
}

console.log(`undo-telemetry completed: neutralized ${modifiedCount} files to 0.0.0.0.`);
