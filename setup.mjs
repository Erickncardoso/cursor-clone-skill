#!/usr/bin/env node
// setup.mjs
//
// Runs automatically as this package's `postinstall` script — i.e. the whole
// point is that `npm install cursor-clone-skill-<version>.tgz` (or
// `npm install github:you/cursor-clone-skill`, if you push this to a repo)
// is the only command you need to run. It copies the Cursor rule + capture
// script into the project you ran `npm install` from, then tries to fetch
// the Chromium binary Playwright needs.
//
// Never throws past its own boundary: if anything here fails (offline
// Chromium download, read-only fs, whatever), it prints a warning and still
// exits 0, so it never makes `npm install` itself look like it failed.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(__dirname, 'files');
// npm sets INIT_CWD to the directory the user actually ran `npm install`
// from — postinstall itself runs with cwd inside node_modules/<pkg>, so this
// is the only reliable way to find "the project", same trick husky uses.
const targetRoot = process.env.INIT_CWD || process.cwd();

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(await walk(full));
    else files.push(full);
  }
  return files;
}

async function copyFile(src, destRoot) {
  const rel = path.relative(sourceRoot, src);
  const dest = path.join(destRoot, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  const srcContent = await readFile(src);
  if (existsSync(dest)) {
    const destContent = await readFile(dest);
    if (Buffer.compare(srcContent, destContent) === 0) {
      console.log(`  = ${rel} (já igual, mantido)`);
      return;
    }
    const altDest = dest + '.new';
    await writeFile(altDest, srcContent);
    console.log(`  ! ${rel} já existe e é diferente — escrevi em ${path.relative(destRoot, altDest)} pra você comparar/mesclar`);
    return;
  }
  await writeFile(dest, srcContent);
  console.log(`  + ${rel}`);
}

async function ensureGitignore(destRoot) {
  const gitignorePath = path.join(destRoot, '.gitignore');
  const entries = ['clone-capture/'];
  if (!existsSync(gitignorePath)) return; // don't create one out of nowhere
  let content = await readFile(gitignorePath, 'utf8');
  let changed = false;
  for (const entry of entries) {
    if (!content.split('\n').some(line => line.trim() === entry)) {
      content += (content.endsWith('\n') || content === '' ? '' : '\n') + entry + '\n';
      changed = true;
    }
  }
  if (changed) {
    await writeFile(gitignorePath, content);
    console.log('  + adicionado clone-capture/ ao .gitignore');
  }
}

async function main() {
  if (!existsSync(sourceRoot)) {
    console.warn('[cursor-clone-skill] pasta "files" não encontrada dentro do pacote — instalação incompleta.');
    return;
  }
  console.log(`[cursor-clone-skill] instalando a skill clone-page em: ${targetRoot}`);
  const files = await walk(sourceRoot);
  for (const file of files) await copyFile(file, targetRoot);
  await ensureGitignore(targetRoot);

  console.log('[cursor-clone-skill] baixando o Chromium do Playwright (só na primeira vez, pode demorar um pouco)...');
  try {
    execSync('npx --yes playwright install chromium', { cwd: targetRoot, stdio: 'inherit' });
    console.log('[cursor-clone-skill] Chromium pronto.');
  } catch (err) {
    console.warn('[cursor-clone-skill] não deu pra baixar o Chromium automaticamente agora (sem internet? sandbox?).');
    console.warn('[cursor-clone-skill] rode manualmente quando puder:  npx playwright install chromium');
  }

  console.log('');
  console.log('[cursor-clone-skill] pronto! No chat do Cursor, dentro deste projeto, peça algo como:');
  console.log('  "clona o design de https://exemplo.com nessa página"');
}

main().catch(err => {
  console.warn('[cursor-clone-skill] setup terminou com um aviso (não vai travar seu npm install):', err.message);
});
