#!/usr/bin/env node

/**
 * QAM preview: renders the plugin in a browser with mocked @decky/ui, @decky/api and backend.
 *
 * Usage:
 *   pnpm run preview         Serve at http://localhost:5173 and rebuild on change
 *   pnpm run preview:shots   Save screenshots of every scenario to preview/screenshots/
 *
 * Preview URL options: ?scenario=issues|healthy|busy|empty  &monitoring=0|1  &tall=1  &latency=ms
 * Keys: arrows = D-pad, Enter = A, Escape = B.
 */

import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const previewDir = join(rootDir, 'preview');

const buildOptions = {
  entryPoints: [join(previewDir, 'main.tsx')],
  outfile: join(previewDir, 'dist', 'app.js'),
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
  alias: {
    '@decky/ui': join(previewDir, 'mocks', 'decky-ui.tsx'),
    '@decky/api': join(previewDir, 'mocks', 'decky-api.ts'),
  },
};

// Each shot: a scenario plus D-pad steps. Steps: 'up'|'down'|'left'|'right'|'a'|'b',
// { focus: 'text' } to jump focus, { wait: ms }.
const SHOTS = [
  { name: '01-overview-issues', query: 'scenario=issues&tall=1' },
  { name: '02-overview-healthy', query: 'scenario=healthy&tall=1' },
  { name: '03-overview-busy', query: 'scenario=busy&tall=1' },
  { name: '04-plugins', query: 'scenario=issues&tall=1', steps: [{ focus: 'Plugins' }, 'a'] },
  {
    name: '05-plugin-expanded-focus-stop',
    query: 'scenario=issues&tall=1',
    steps: [{ focus: 'Plugins' }, 'a', { focus: 'Audio Loader' }, 'a', 'down'],
  },
  {
    name: '06-stop-confirm',
    query: 'scenario=issues',
    steps: [{ focus: 'Plugins' }, 'a', { focus: 'Audio Loader' }, 'a', 'down', 'a'],
  },
  { name: '07-logs', query: 'scenario=issues&tall=1', steps: [{ focus: 'Logs' }, 'a'] },
  {
    name: '08-log-expanded',
    query: 'scenario=issues&tall=1',
    steps: [{ focus: 'Logs' }, 'a', { focus: 'Audio Loader' }, 'a'],
  },
  { name: '09-logs-clean', query: 'scenario=healthy&tall=1', steps: [{ focus: 'Logs' }, 'a'] },
  { name: '10-empty', query: 'scenario=empty&tall=1', steps: [{ focus: 'Plugins' }, 'a'] },
  { name: '11-viewport-issues', query: 'scenario=issues' },
];

const KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'Enter', b: 'Escape' };

async function serve(ctx, port) {
  return ctx.serve({ servedir: previewDir, port, host: '127.0.0.1' });
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path));
}

async function takeShots() {
  const { chromium } = await import('playwright-core');
  const ctx = await esbuild.context(buildOptions);
  await ctx.rebuild();
  const { port } = await serve(ctx, 0);
  const outDir = join(previewDir, 'screenshots');
  mkdirSync(outDir, { recursive: true });

  const executablePath = chromiumPath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 356, height: 800 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));

  const only = process.argv.slice(3);
  for (const shot of SHOTS.filter((s) => only.length === 0 || only.some((o) => s.name.includes(o)))) {
    await page.goto(`http://127.0.0.1:${port}/?latency=0&${shot.query}`);
    await page.waitForSelector('#qam-content [data-nav-leaf]');
    await page.waitForTimeout(300);
    for (const step of shot.steps || []) {
      if (typeof step === 'string') {
        await page.keyboard.press(KEYS[step]);
      } else if (step.focus) {
        const found = await page.evaluate((text) => window.__nav.focusText(text), step.focus);
        if (!found) errors.push(`${shot.name}: nothing focusable contains "${step.focus}"`);
      } else if (step.wait) {
        await page.waitForTimeout(step.wait);
      }
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(250);
    const focused = await page.evaluate(() => window.__nav.currentLabel());
    await page.screenshot({ path: join(outDir, `${shot.name}.png`), fullPage: true });
    console.log(`${shot.name}.png  (focused: ${focused || '-'})`);
  }

  await browser.close();
  await ctx.dispose();

  if (errors.length) {
    console.error('\nPage errors:\n' + errors.map((e) => `  ${e}`).join('\n'));
    process.exit(1);
  }
}

async function main() {
  const mode = process.argv[2] || 'serve';
  if (mode === 'shots') {
    await takeShots();
    return;
  }
  if (mode === 'build') {
    await esbuild.build(buildOptions);
    return;
  }

  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  const { port } = await serve(ctx, Number(process.env.PORT) || 5173);
  console.log(`QAM preview: http://localhost:${port}/?scenario=issues`);
  console.log('Scenarios: issues, healthy, busy, empty. Arrows = D-pad, Enter = A, Escape = B.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
