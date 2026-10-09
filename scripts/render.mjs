#!/usr/bin/env node
// render.mjs — рендер Mermaid- или SVG-исходника в аккуратный PNG через headless Chrome.
// Без внешних npm-зависимостей: использует установленный Chrome и локальный mermaid.min.js.
//
// Особенность: в некоторых сборках Chrome headless-процесс не завершается сам
// (висит апдейтер), поэтому здесь мы НЕ ждём выхода процесса, а ждём появления
// результата (файла PNG или DOM с отрисованным SVG) и затем гасим группу процессов.
//
// Использование:
//   node scripts/render.mjs mermaid <input.mmd> <output.png> [--width N] [--scale S] [--theme default|dark|neutral|forest]
//   node scripts/render.mjs svg     <input.svg> <output.png> [--width N] [--scale S]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor', 'mermaid.min.js');
const PAD = 16; // внутренние поля вокруг картинки, px
const HARD_TIMEOUT_MS = 60000;

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-render-'));
const profileDir = path.join(tmpDir, 'profile');

function fail(msg) {
  throw new Error(msg);
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeArgs(extra) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    `--user-data-dir=${profileDir}`,
    ...extra,
  ];
}

// Запускает Chrome, ждёт, пока predicate() не вернёт значение, затем гасит процесс.
async function runChromeUntil(args, predicate) {
  const child = spawn(CHROME, chromeArgs(args), { detached: true, stdio: 'ignore' });
  const started = Date.now();
  try {
    while (Date.now() - started < HARD_TIMEOUT_MS) {
      const value = predicate();
      if (value !== undefined && value !== false) return value;
      await sleep(120);
    }
    fail('Chrome не выдал результат за отведённое время');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

async function dumpDom(html) {
  const page = path.join(tmpDir, 'page.html');
  const outFile = path.join(tmpDir, 'dom.txt');
  fs.writeFileSync(page, html, 'utf8');
  const fd = fs.openSync(outFile, 'w');
  const child = spawn(
    CHROME,
    chromeArgs(['--dump-dom', '--virtual-time-budget=15000', `file://${page}`]),
    { detached: true, stdio: ['ignore', fd, 'ignore'] },
  );
  const started = Date.now();
  try {
    while (Date.now() - started < HARD_TIMEOUT_MS) {
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* not yet */ }
      if (text.includes('<title>RENDER_ERROR</title>')) {
        const m = /<div id="out">([\s\S]*?)<\/div>/.exec(text);
        fail(`Mermaid не смог отрисовать диаграмму: ${m ? m[1].trim() : 'неизвестная ошибка'}`);
      }
      if (text.includes('<title>RENDER_OK</title>') && text.includes('</svg>')) return text;
      await sleep(120);
    }
    fail('Mermaid не вернул SVG (проверьте синтаксис или сложность диаграммы)');
  } finally {
    fs.closeSync(fd);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

async function screenshot(html, output, scale) {
  const page = path.join(tmpDir, 'shot.html');
  fs.writeFileSync(page, html, 'utf8');
  const abs = path.resolve(output);
  try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
  await runChromeUntil(
    [
      `--screenshot=${abs}`,
      `--window-size=${shotW},${shotH}`,
      `--force-device-scale-factor=${scale}`,
      '--default-background-color=FFFFFFFF',
      `file://${page}`,
    ],
    () => {
      if (!fs.existsSync(abs)) return false;
      const size = fs.statSync(abs).size;
      return size > 0 ? size : false;
    },
  );
  if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) fail('PNG не создан');
}

let shotW = 800;
let shotH = 600;

function esc(str) {
  return String(str).replace(/</g, '\\u003c');
}

function mermaidHtml(source, theme) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#ffffff}#out{display:inline-block}</style>
</head><body>
<div id="out"></div>
<script src="file://${VENDOR}"></script>
<script>
const SRC = ${JSON.stringify(esc(source))};
(async () => {
  try {
    mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme)}, securityLevel: 'loose' });
    const { svg } = await mermaid.render('diagram', SRC);
    document.getElementById('out').innerHTML = svg;
    document.title = 'RENDER_OK';
  } catch (e) {
    document.title = 'RENDER_ERROR';
    document.getElementById('out').textContent = String(e && e.message ? e.message : e);
  }
})();
</script></body></html>`;
}

function dimensionsFromSvg(svg) {
  const vb = /viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*"/i.exec(svg);
  if (vb) return { w: Math.ceil(Number(vb[1])), h: Math.ceil(Number(vb[2])) };
  const w = /\bwidth="([\d.]+)(?:px)?"/i.exec(svg);
  const h = /\bheight="([\d.]+)(?:px)?"/i.exec(svg);
  if (w && h) return { w: Math.ceil(Number(w[1])), h: Math.ceil(Number(h[1])) };
  return null;
}

function extractSvg(markup) {
  const start = markup.indexOf('<svg');
  const end = markup.lastIndexOf('</svg>');
  if (start === -1 || end === -1) return null;
  return markup.slice(start, end + '</svg>'.length);
}

function svgPage(svgMarkup, w, h) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#ffffff}
#out{display:block;padding:${PAD}px}
#out svg{display:block;width:${w}px !important;height:${h}px !important;max-width:none !important}</style>
</head><body><div id="out">${svgMarkup}</div></body></html>`;
}

function parseArgs(argv) {
  const [, , kind, input, output, ...rest] = argv;
  if (!kind || !input || !output) {
    fail('использование: render.mjs <mermaid|svg> <input> <output.png> [--width N] [--scale S] [--theme T]');
  }
  const opts = { width: null, scale: 2, theme: 'default' };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--width') opts.width = Number(rest[++i]);
    else if (rest[i] === '--scale') opts.scale = Number(rest[++i]);
    else if (rest[i] === '--theme') opts.theme = rest[++i];
  }
  return { kind, input, output, opts };
}

async function main() {
  if (!CHROME) fail('не найден Chrome. Установите Google Chrome или задайте переменную CHROME_PATH');
  const { kind, input, output, opts } = parseArgs(process.argv);
  if (!fs.existsSync(input)) fail(`нет входного файла: ${input}`);
  const source = fs.readFileSync(input, 'utf8');
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });

  let svgMarkup;
  if (kind === 'mermaid') {
    svgMarkup = extractSvg(await dumpDom(mermaidHtml(source, opts.theme)));
    if (!svgMarkup) fail('не удалось извлечь SVG из результата Mermaid');
  } else if (kind === 'svg') {
    svgMarkup = extractSvg(source);
    if (!svgMarkup) fail('в файле нет корректного <svg>...</svg>');
  } else {
    fail(`неизвестный тип: ${kind} (ожидается mermaid или svg)`);
  }

  let dims = dimensionsFromSvg(svgMarkup);
  if (!dims) fail('не удалось определить размер SVG (нет width/height/viewBox)');

  if (opts.width && opts.width > 0) {
    dims = { w: Math.ceil(opts.width), h: Math.ceil((opts.width * dims.h) / dims.w) };
  } else {
    let k = 1;
    if (dims.w < 240) k = 240 / dims.w;
    else if (dims.w > 2000) k = 2000 / dims.w;
    dims = { w: Math.ceil(dims.w * k), h: Math.ceil(dims.h * k) };
  }

  shotW = Math.min(Math.max(dims.w + PAD * 2, 120), 6000);
  shotH = Math.min(Math.max(dims.h + PAD * 2, 80), 6000);

  await screenshot(svgPage(svgMarkup, dims.w, dims.h), output, opts.scale);
  process.stdout.write(`OK ${output} ${dims.w}x${dims.h}@${opts.scale}x\n`);
}

main()
  .then(() => cleanup())
  .catch((e) => {
    process.stderr.write(`render: ${e && e.message ? e.message : String(e)}\n`);
    cleanup();
    process.exit(1);
  });