#!/usr/bin/env node
// log.mjs — ведение markdown-журнала учебных сессий (аналог md-log из pi-системы).
//
// Активный файл журнала хранится в .qwen/learn-active-log (путь относительно корня проекта).
//
// Использование:
//   node scripts/log.mjs current                 # напечатать активный файл (пусто, если не задан)
//   node scripts/log.mjs set <путь>              # задать активный файл (создаст директории)
//   node scripts/log.mjs init <слаг>             # создать lessons/<слаг>.md и сделать активным
//   node scripts/log.mjs append                  # дописать в активный журнал текст из stdin
//
// Пример дописывания (heredoc, без раскрытия подстановок):
//   node scripts/log.mjs append <<'MD'
//   ## Тема
//   текст урока...
//   MD

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const QWEN_DIR = path.join(ROOT, '.qwen');
const STATE_FILE = path.join(QWEN_DIR, 'learn-active-log');

function fail(msg) {
  process.stderr.write(`log: ${msg}\n`);
  process.exit(1);
}

function readActive() {
  try {
    const p = fs.readFileSync(STATE_FILE, 'utf8').trim();
    return p || null;
  } catch {
    return null;
  }
}

function writeActive(rel) {
  fs.mkdirSync(QWEN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, rel + '\n', 'utf8');
}

function resolve(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function slugify(s) {
  const latin = String(s)
    .toLowerCase()
    .split('')
    .map((c) => (TRANSLIT[c] !== undefined ? TRANSLIT[c] : c))
    .join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lesson';
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'current') {
    const active = readActive();
    if (active) process.stdout.write(active + '\n');
    return;
  }

  if (cmd === 'set') {
    if (!arg) fail('нужен путь: log.mjs set <путь>');
    const rel = path.isAbsolute(arg) ? arg : path.relative(ROOT, resolve(arg));
    fs.mkdirSync(path.dirname(resolve(rel)), { recursive: true });
    if (!fs.existsSync(resolve(rel))) fs.writeFileSync(resolve(rel), '', 'utf8');
    writeActive(rel);
    process.stdout.write(`активный журнал: ${rel}\n`);
    return;
  }

  if (cmd === 'init') {
    const slug = slugify(arg || 'lesson');
    const rel = path.join('lessons', `${slug}.md`);
    const abs = resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, `# ${arg || 'Урок'}\n`, 'utf8');
    }
    writeActive(rel);
    process.stdout.write(`активный журнал: ${rel}\n`);
    return;
  }

  if (cmd === 'append') {
    const active = readActive();
    if (!active) fail('активный журнал не задан (сначала log.mjs set <путь> или init <слаг>)');
    const abs = resolve(active);
    const text = readStdin();
    if (!text.trim()) fail('пустой ввод (передай текст через stdin)');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const sep = prev.trim().length > 0 ? '\n\n' : '';
    fs.appendFileSync(abs, sep + text.replace(/\s+$/, '') + '\n', 'utf8');
    process.stdout.write(`дописано в ${active}\n`);
    return;
  }

  fail('команды: current | set <путь> | init <слаг> | append (stdin)');
}

main();