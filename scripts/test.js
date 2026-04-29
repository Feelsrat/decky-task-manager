#!/usr/bin/env node

/**
 * Test & Validation Script
 *
 * Validates the plugin package before release:
 * - Checks plugin.json structure
 * - Checks package.json version
 * - Checks Python syntax
 * - Runs lightweight backend mock tests
 * - Verifies TypeScript build
 * - Verifies TypeScript project types
 * - Validates required files exist
 *
 * Usage:
 *   pnpm run test
 *   pnpm run test:backend
 *   pnpm run test:types
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

let hasErrors = false;
const isWindows = process.platform === 'win32';

function localBin(name) {
  return join(rootDir, 'node_modules', '.bin', isWindows ? `${name}.CMD` : name);
}

function localNodeScript(...parts) {
  return join(rootDir, 'node_modules', ...parts);
}

function commandExists(command) {
  try {
    execSync(isWindows ? `where ${command}` : `command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: options.stdio || 'pipe',
  });
}

function runBuildCommand() {
  const rollupScript = localNodeScript('rollup', 'dist', 'bin', 'rollup');
  if (existsSync(rollupScript)) {
    runCommand(process.execPath, [rollupScript, '-c']);
    return;
  }

  if (commandExists('pnpm')) {
    runCommand('pnpm', ['run', 'build']);
    return;
  }

  runCommand(localBin('rollup'), ['-c']);
}

function checkFile(path, description) {
  if (existsSync(path)) {
    console.log(`OK: ${description}`);
    return true;
  }

  console.error(`FAIL: ${description} - NOT FOUND`);
  hasErrors = true;
  return false;
}

function testPluginManifest() {
  console.log('\nChecking plugin.json...');
  try {
    const pluginJsonPath = join(rootDir, 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));

    const requiredFields = ['name', 'author', 'api_version'];
    for (const field of requiredFields) {
      if (pluginJson[field] !== undefined) {
        console.log(`OK: ${field}: ${pluginJson[field]}`);
      } else {
        console.error(`FAIL: Missing required field: ${field}`);
        hasErrors = true;
      }
    }

    if (pluginJson.flags?.includes('root')) {
      console.log('INFO: Plugin requires root permissions');
    }
  } catch (error) {
    console.error('FAIL: Invalid plugin.json:', error.message);
    hasErrors = true;
  }
}

function testPackageVersion() {
  console.log('\nChecking package version...');
  try {
    const packageJsonPath = join(rootDir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    console.log(`OK: Version: ${packageJson.version}`);

    if (
      packageJson.version.includes('test') ||
      packageJson.version.includes('alpha') ||
      packageJson.version.includes('beta')
    ) {
      console.log('INFO: Pre-release version detected');
    }
  } catch (error) {
    console.error('FAIL: Invalid package.json:', error.message);
    hasErrors = true;
  }
}

function testPythonSyntax() {
  console.log('\nChecking Python syntax...');
  try {
    const mainPy = join(rootDir, 'main.py');
    if (!checkFile(mainPy, 'main.py exists')) return;

    runCommand('python', ['-m', 'py_compile', mainPy]);
    console.log('OK: Python syntax is valid');
  } catch (error) {
    console.error('FAIL: Python syntax error:');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testBackendMocks() {
  console.log('\nChecking backend mocks...');
  try {
    runCommand('python', ['-m', 'unittest', 'tests.test_backend_mocks']);
    console.log('OK: Backend mock tests passed');
  } catch (error) {
    console.error('FAIL: Backend mock tests failed:');
    console.error(error.stdout?.toString() || '');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testTypeScriptBuild() {
  console.log('\nChecking TypeScript build...');
  try {
    runBuildCommand();
    console.log('OK: TypeScript build successful');

    const distIndex = join(rootDir, 'dist', 'index.js');
    if (checkFile(distIndex, 'dist/index.js created')) {
      const size = readFileSync(distIndex).length;
      console.log(`INFO: Size: ${(size / 1024).toFixed(1)} KB`);
    }
  } catch (error) {
    console.error('FAIL: TypeScript build failed:');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testTypeScriptTypes() {
  console.log('\nChecking TypeScript project types...');
  try {
    const tscScript = localNodeScript('typescript', 'bin', 'tsc');
    if (existsSync(tscScript)) {
      runCommand(process.execPath, [tscScript, '--noEmit', '--skipLibCheck']);
    } else {
      runCommand(localBin('tsc'), ['--noEmit', '--skipLibCheck']);
    }
    console.log('OK: TypeScript project code type-checks');
  } catch (error) {
    console.error('FAIL: TypeScript type check failed:');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testRequiredFiles() {
  console.log('\nChecking required files...');

  const requiredFiles = [
    { path: 'plugin.json', desc: 'Plugin manifest' },
    { path: 'package.json', desc: 'NPM package manifest' },
    { path: 'main.py', desc: 'Python backend' },
    { path: 'defaults.py', desc: 'Default settings' },
    { path: 'README.md', desc: 'Documentation' },
    { path: 'dist/index.js', desc: 'Built frontend' },
  ];

  for (const { path, desc } of requiredFiles) {
    checkFile(join(rootDir, path), desc);
  }
}

function runAllTests() {
  console.log('Decky Task Manager - Basic Plugin Validation\n');
  console.log('='.repeat(50));

  testPluginManifest();
  testPackageVersion();
  testPythonSyntax();
  testBackendMocks();
  testTypeScriptBuild();
  testTypeScriptTypes();
  testRequiredFiles();

  console.log('\n' + '='.repeat(50));

  if (hasErrors) {
    console.error('\nTests failed. Fix errors before releasing.');
    process.exit(1);
  } else {
    console.log('\nAll basic tests passed.');
    process.exit(0);
  }
}

runAllTests();
