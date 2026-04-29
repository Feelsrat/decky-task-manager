#!/usr/bin/env node

/**
 * Test & Validation Script
 * 
 * Validates the plugin package before release:
 * - Checks Python syntax
 * - Verifies TypeScript build
 * - Validates required files exist
 * - Checks plugin.json structure
 * - Verifies package integrity
 * 
 * Usage: pnpm run test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

let hasErrors = false;

function checkFile(path, description) {
  if (existsSync(path)) {
    console.log(`✓ ${description}`);
    return true;
  } else {
    console.error(`✗ ${description} - NOT FOUND`);
    hasErrors = true;
    return false;
  }
}

function testPythonSyntax() {
  console.log('\n📋 Testing Python syntax...');
  try {
    const mainPy = join(rootDir, 'main.py');
    if (!checkFile(mainPy, 'main.py exists')) return;

    execSync(`python -m py_compile "${mainPy}"`, { 
      cwd: rootDir,
      stdio: 'pipe'
    });
    console.log('✓ Python syntax is valid');
  } catch (error) {
    console.error('✗ Python syntax error:');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testTypeScriptBuild() {
  console.log('\n📋 Testing TypeScript build...');
  try {
    execSync('pnpm run build', {
      cwd: rootDir,
      stdio: 'pipe'
    });
    console.log('✓ TypeScript build successful');
    
    const distIndex = join(rootDir, 'dist', 'index.js');
    if (checkFile(distIndex, 'dist/index.js created')) {
      const size = readFileSync(distIndex).length;
      console.log(`  Size: ${(size / 1024).toFixed(1)} KB`);
    }
  } catch (error) {
    console.error('✗ TypeScript build failed:');
    console.error(error.stderr?.toString() || error.message);
    hasErrors = true;
  }
}

function testRequiredFiles() {
  console.log('\n📋 Checking required files...');
  
  const requiredFiles = [
    { path: 'plugin.json', desc: 'Plugin manifest' },
    { path: 'package.json', desc: 'NPM package manifest' },
    { path: 'main.py', desc: 'Python backend' },
    { path: 'defaults.py', desc: 'Default settings' },
    { path: 'README.md', desc: 'Documentation' },
    { path: 'dist/index.js', desc: 'Built frontend' }
  ];

  for (const { path, desc } of requiredFiles) {
    checkFile(join(rootDir, path), desc);
  }
}

function testPluginManifest() {
  console.log('\n📋 Validating plugin.json...');
  try {
    const pluginJsonPath = join(rootDir, 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));

    const requiredFields = ['name', 'author', 'api_version'];
    for (const field of requiredFields) {
      if (pluginJson[field] !== undefined) {
        console.log(`✓ ${field}: ${pluginJson[field]}`);
      } else {
        console.error(`✗ Missing required field: ${field}`);
        hasErrors = true;
      }
    }

    if (pluginJson.flags?.includes('root')) {
      console.log('ℹ Plugin requires root permissions');
    }
  } catch (error) {
    console.error('✗ Invalid plugin.json:', error.message);
    hasErrors = true;
  }
}

function testPackageVersion() {
  console.log('\n📋 Checking package version...');
  try {
    const packageJsonPath = join(rootDir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    
    console.log(`✓ Version: ${packageJson.version}`);
    
    if (packageJson.version.includes('test') || 
        packageJson.version.includes('alpha') || 
        packageJson.version.includes('beta')) {
      console.log('ℹ Pre-release version detected');
    }
  } catch (error) {
    console.error('✗ Invalid package.json:', error.message);
    hasErrors = true;
  }
}

function runAllTests() {
  console.log('🧪 Decky Task Manager - Plugin Validation\n');
  console.log('='.repeat(50));

  testRequiredFiles();
  testPluginManifest();
  testPackageVersion();
  testPythonSyntax();
  testTypeScriptBuild();

  console.log('\n' + '='.repeat(50));
  
  if (hasErrors) {
    console.error('\n❌ Tests failed! Fix the errors above before releasing.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed! Plugin is ready to release.');
    process.exit(0);
  }
}

runAllTests();
