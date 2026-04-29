#!/usr/bin/env node

/**
 * Release Script
 * 
 * Single command to build, package, and release to GitHub using GitHub CLI.
 * Requires: gh CLI installed and authenticated (gh auth login)
 * 
 * Usage:
 *   pnpm run release
 *   pnpm run release -- --private
 *   pnpm run release -- --draft
 */

import { readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const ZIP_FILENAME = 'decky-task-manager.zip';

function printUsage() {
  console.log(`Usage:
  pnpm run release              Create a public GitHub release
  pnpm run release -- --private Create a draft release for private review
  pnpm run release -- --draft   Alias for --private
`);
}

function parseArgs(argv) {
  const options = {
    draft: false,
  };

  for (const arg of argv) {
    if (arg === '--private' || arg === '--draft') {
      options.draft = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown release option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return options;
}

function bumpVersion() {
  console.log('📝 Bumping version...');
  
  const packageJsonPath = join(rootDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const currentVersion = packageJson.version;
  
  // Parse version (supports semver and test versions like 0.0.1-test.9)
  const versionMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+)\.(\d+))?$/);
  
  if (!versionMatch) {
    console.error(`❌ Invalid version format: ${currentVersion}`);
    process.exit(1);
  }
  
  let [, major, minor, patch, preRelease, preReleaseNum] = versionMatch;
  
  // If it's a pre-release (test, alpha, beta), increment the pre-release number
  if (preRelease && preReleaseNum) {
    preReleaseNum = parseInt(preReleaseNum) + 1;
    packageJson.version = `${major}.${minor}.${patch}-${preRelease}.${preReleaseNum}`;
  } else {
    // Otherwise, increment patch version
    patch = parseInt(patch) + 1;
    packageJson.version = `${major}.${minor}.${patch}`;
  }
  
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  
  console.log(`✓ Version bumped: ${currentVersion} → ${packageJson.version}`);
  return packageJson.version;
}

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
  
  // Use Python to create cross-platform ZIP with forward slashes
  const pythonScript = join(rootDir, 'scripts', 'create_zip.py');
  
  try {
    execSync(`python "${pythonScript}"`, { 
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('❌ Error creating ZIP:', error.message);
    process.exit(1);
  }
  
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

function publishToGitHub(zipPath, options) {
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
  if (options.draft) {
    console.log('Creating a draft release. It will stay private until you publish it in GitHub.');
  }

  try {
    // Check if user is authenticated
    try {
      execSync('gh auth status', { stdio: 'ignore' });
    } catch {
      console.error('❌ Error: Not authenticated with GitHub CLI');
      console.error('   Run: gh auth login');
      process.exit(1);
    }

    // Build the release command arguments
    const releaseArgs = [
      'release',
      'create',
      tagName,
      zipPath,
      '--title',
      `Decky Task Manager ${tagName}`,
      '--notes',
      `Release ${tagName}`
    ];

    if (options.draft) {
      releaseArgs.push('--draft');
    }

    // Add prerelease flag if needed
    if (version.includes('test') || version.includes('alpha') || version.includes('beta')) {
      releaseArgs.push('--prerelease');
    }

    console.log('Creating GitHub release...');
    const result = spawnSync('gh', releaseArgs, {
      cwd: rootDir,
      stdio: 'inherit'
    });

    if (result.status !== 0) {
      throw new Error(`gh command failed with exit code ${result.status}`);
    }

    let repo = '';
    try {
      repo = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
        cwd: rootDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      repo = '';
    }

    console.log(options.draft ? '\n✅ Draft release created!' : '\n✅ Release complete!');
    if (repo) {
      console.log(`   View at: https://github.com/${repo}/releases/tag/${tagName}`);
    }

  } catch (error) {
    console.error('❌ Error publishing to GitHub:', error.message);
    process.exit(1);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.draft) {
    console.log('Draft/private review mode is enabled.');
  }
  console.log('🎯 Starting release process...\n');
  
  // Bump version first
  const newVersion = bumpVersion();
  console.log('');
  
  // Run tests
  console.log('Running validation tests...');
  try {
    execSync('pnpm run test', { cwd: rootDir, stdio: 'inherit' });
  } catch (error) {
    console.error('\n❌ Tests failed! Fix errors before releasing.');
    process.exit(1);
  }
  
  cleanup();
  build();
  const zipPath = createPackage();
  publishToGitHub(zipPath, options);
  
  console.log('\n🎉 Done!');
  console.log(`Released version ${newVersion}`);
}

main();
