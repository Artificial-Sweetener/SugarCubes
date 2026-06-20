//    SugarCubes - composable workflow units for ComfyUI
//    Copyright (C) 2026  Artificial Sweetener and contributors
//
//    This program is free software: you can redistribute it and/or modify
//    it under the terms of the GNU Affero General Public License as published by
//    the Free Software Foundation, either version 3 of the License, or
//    (at your option) any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU Affero General Public License for more details.
//
//    You should have received a copy of the GNU Affero General Public License
//    along with this program.  If not, see <https://www.gnu.org/licenses/>.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function repoRoot(rootDir = process.cwd()) {
  return path.resolve(rootDir);
}

function walkFiles(rootDir, predicate) {
  const results = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const fullPath = path.join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function previousNonEmptyLine(lines, startIdx) {
  let idx = startIdx - 1;
  while (idx >= 0 && !lines[idx].trim()) {
    idx -= 1;
  }
  return idx;
}

function hasLeadingJsdoc(content) {
  const contentAfterLicense = content.replace(
    /^(?:\/\/    SugarCubes - composable workflow units for ComfyUI\r?\n\/\/    Copyright \(C\) .+?\r?\n\/\/\r?\n\/\/    This program is free software:[\s\S]+?\/\/    along with this program\.  If not, see <https:\/\/www\.gnu\.org\/licenses\/>\.\r?\n)/,
    ''
  );
  return contentAfterLicense.trimStart().startsWith('/**');
}

function hasExportJsdoc(lines, exportIdx) {
  const previousIdx = previousNonEmptyLine(lines, exportIdx);
  return previousIdx >= 0 && lines[previousIdx].trim().endsWith('*/');
}

export function auditStandards(rootDir = process.cwd()) {
  const root = repoRoot(rootDir);
  const failures = [];
  const webFiles = walkFiles(path.join(root, 'web'), (fullPath) => fullPath.endsWith('.js'));
  for (const fullPath of webFiles) {
    const relativePath = path.relative(root, fullPath).replaceAll('\\', '/');
    const content = readFileSync(fullPath, 'utf8');
    if (!hasLeadingJsdoc(content)) {
      failures.push(`${relativePath} is missing a top-level JSDoc module comment`);
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (/^\s*export\s+(class|function|const)\s+[A-Za-z0-9_]+/.test(line) && !hasExportJsdoc(lines, idx)) {
        failures.push(`${relativePath}:${idx + 1} is missing JSDoc for an exported API`);
      }
    });
  }

  const scriptFiles = walkFiles(path.join(root, 'scripts'), (fullPath) => /\.(js|mjs)$/.test(fullPath));
  for (const fullPath of scriptFiles) {
    const relativePath = path.relative(root, fullPath).replaceAll('\\', '/');
    if (relativePath === 'scripts/standards-audit.mjs') {
      continue;
    }
    const content = readFileSync(fullPath, 'utf8');
    if (content.includes('shell: true')) {
      failures.push(`${relativePath} uses shell: true`);
    }
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = auditStandards();
  if (failures.length) {
    console.error('Web/tooling standards audit failed:');
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    process.exit(1);
  }
  console.log('Web/tooling standards audit passed.');
}
