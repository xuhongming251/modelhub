#!/usr/bin/env node
/**
 * Full sync — fetches ALL workflow runs efficiently.
 *
 * Scan position is tracked per-workflow so pages are never re-scanned.
 * Cache file is updated continuously so the H5 page shows live progress.
 *
 * Usage:
 *   npm run sync:all
 *   node scripts/syncAll.js [batchSize]
 */

require('dotenv').config();

const GitHubActionsService = require('../services/githubActionsService');
const FileSearchService   = require('../services/fileSearchService');
const SyncManager          = require('../services/syncManager');

const TOKEN     = process.env.GITHUB_TOKEN || '';
const OWNER     = process.env.GITHUB_OWNER || 'xuhongming251';
const REPO      = process.env.GITHUB_REPO || 'upload_cloud_storage';
const WORKFLOWS = (process.env.GITHUB_WORKFLOWS || 'upload.yml')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const WORKFLOW_EVENT = process.env.GITHUB_WORKFLOW_EVENT || 'workflow_dispatch';
const BATCH_SIZE = parseInt(process.argv[2], 10) ||
                   parseInt(process.env.SYNC_BATCH_SIZE, 10) ||
                   50;
const DATA_DIR = process.env.SYNC_DATA_DIR || './data';

if (!TOKEN) {
  console.error('ERROR: GITHUB_TOKEN is not set in .env');
  process.exit(1);
}

(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  ModelHub — Full Sync');
  console.log('═══════════════════════════════════════════');
  console.log(`  Repo:      ${OWNER}/${REPO}`);
  console.log(`  Workflows: ${WORKFLOWS.join(', ')}`);
  console.log(`  Batch:     ${BATCH_SIZE} items per round`);
  console.log('═══════════════════════════════════════════\n');

  const githubService = new GitHubActionsService(TOKEN, OWNER, REPO, { workflowEvent: WORKFLOW_EVENT });
  const searchService = new FileSearchService(githubService);
  const syncManager   = new SyncManager(githubService, searchService, { dataDir: DATA_DIR });

  syncManager.load();
  console.log(`Cache file: ${syncManager.cachePath}`);
  console.log(`Starting: ${syncManager.getItemCount()} items, lastRunId=${syncManager.getLastRunId()}\n`);

  const result = await syncManager.syncAll(WORKFLOWS, BATCH_SIZE);

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Done! ${result.newCount} new, ${result.totalItems} total`);
  console.log('═══════════════════════════════════════════');
})();
