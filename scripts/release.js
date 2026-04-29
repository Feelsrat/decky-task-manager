#!/usr/bin/env node

/**
 * Release Script
 * 
 * Single command to build, package, and release to GitHub using GitHub CLI.
 * Requires: gh CLI installed and authenticated (gh auth login)
 * 
 * Usage: pnpm run release
 */

import { readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const ZIP_FILENAME = 'decky-task-manager.zip';

function cleanup() {
  console.log('🧹 Cleaning build artifacts...');
  const distPath = join(rootDir, 'dist');
  const zipPath = join(rootDir, ZIP_FILENAME);
  
  if (existsSync(distPath)) {
    rmSync(distPath, { recursive: true, force: true });
  }
  if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true });
  }
}

function build() {
  console.log('🔨 Building plugin...');
  try {
    execSync('pnpm run build', { cwd: rootDir, stdio: 'inherit' });
    console.log('✓ Build complete');
  } catch (error) {
    console.error('❌ Build failed');
    process.exit(1);
  }
}

function createPackage() {
  console.log('📦 Creating release package...');
  
  const zipPath = join(rootDir, ZIP_FILENAME);
  const zip = new AdmZip();
  
  // Add required files
  const files = ['plugin.json', 'main.py', 'package.json', 'README.md'];
  for (const file of files) {
    const filePath = join(rootDir, file);
    if (existsSync(filePath)) {
      zip.addLocalFile(filePath);
    } else {
      console.warn(`⚠ Warning: ${file} not found`);
    }
  }
  
  // Add dist folder
  const distPath = join(rootDir, 'dist');
  if (existsSync(distPath)) {
    zip.addLocalFolder(distPath, 'dist');
  } else {
    console.error('❌ Error: dist folder not found');
    process.exit(1);
  }
  
  zip.writeZip(zipPath);
  console.log(`✓ Created ${ZIP_FILENAME}`);
  
  return zipPath;
}

function checkGitHubCLI() {
  try {
    execSync('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function publishToGitHub(zipPath) {
  // Check if gh CLI is installed
  if (!checkGitHubCLI()) {
    console.error('❌ Error: GitHub CLI (gh) is not installed');
    console.error('   Install it from: https://cli.github.com/');
    console.error('   Or with: winget install GitHub.cli');
    process.exit(1);
  }

  // Read package.json for version
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  const version = packageJson.version;
  const tagName = `v${version}`;

  console.log(`\n🚀 Publishing ${tagName} to GitHub...`);

  try {
    // Check if user is authenticated
    try {
      execSync('gh auth status', { stdio: 'ignore' });
    } catch {
      console.error('❌ Error: Not authenticated with GitHub CLI');
      console.error('   Run: gh auth login');
      process.exit(1);
    }

    // Build the release command
    const releaseArgs = [
      'release',
      'create',
      tagName,
      zipPath,
      '--title', `Decky Task Manager ${tagName}`,
      '--notes', `Release ${tagName}`
    ];

    // Add prerelease flag if needed
    if (version.includes('test') || version.includes('alpha') || version.includes('beta')) {
      releaseArgs.push('--prerelease');
    }

    console.log('Creating GitHub release...');
    execSync(`gh ${releaseArgs.join(' ')}`, {
      cwd: rootDir,
      stdio: 'inherit'
    });

    console.log('\n✅ Release complete!');
    console.log(`   View at: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${tagName}`);

  } catch (error) {
    console.error('❌ Error publishing to GitHub:', error.message);
    process.exit(1);
  }
}

async function main() {
  console.log('🎯 Starting release process...\n');
  
  cleanup();
  build();
  const zipPath = createPackage();
  await publishToGitHub(zipPath);
  
  console.log('\n🎉 Done!');
}

main();
function main() {
  console.log('🎯 Starting release process...\n');
  
  cleanup();
  build();
  const zipPath = createPackage();
 