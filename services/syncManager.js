const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Persistent incremental sync manager.
 *
 * Tracks processed run IDs via a Set built from the items list. Each sync
 * call starts from page 1 (newest runs first) and processes only runs that
 * aren't already in the local DB. lastRunId is updated after all new runs
 * are processed so it reflects the actual max ID in the items.
 */
class SyncManager {
  constructor(githubService, searchService, options = {}) {
    this.githubService = githubService;
    this.searchService = searchService;
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.cachePath = path.join(this.dataDir, 'sync_cache.json');

    this.state = {
      version: 1,
      updatedAt: '',
      lastRunId: 0,
      items: [],
      scanState: {}
    };
    this.lastRunId = 0;
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  load() {
    try {
      const statePath = path.join(this.dataDir, 'sync_state.json');
      if (!fs.existsSync(statePath)) {
        console.log(`[sync] No state file, starting fresh`);
        return;
      }
      const raw = fs.readFileSync(statePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.version === 1) {
        this.state = data;
        this.state.scanState = data.scanState || {};
        this.lastRunId = data.lastRunId || 0;
        console.log(`[sync] Loaded: lastRunId=${this.lastRunId}, ${(data.items || []).length} items`);
      }
    } catch (err) {
      console.error(`[sync] Failed to load state: ${err.message}`);
    }
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      this.state.lastRunId = this.lastRunId;
      this.state.updatedAt = new Date().toISOString();

      // Write trimmed version for frontend (only fields the UI actually uses)
      const frontendItems = this.state.items.map(i => ({
        filename: i.filename,
        normalized_name: i.normalized_name,
        share_url: i.share_url,
        completed_at: i.completed_at
      }));
      fs.writeFileSync(this.cachePath, JSON.stringify({
        updatedAt: this.state.updatedAt,
        items: frontendItems
      }), 'utf8');

      // Write full state for sync resumption
      const statePath = path.join(this.dataDir, 'sync_state.json');
      fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2), 'utf8');
      console.log(`[sync] Saved: lastRunId=${this.lastRunId}, ${this.state.items.length} items → ${statePath}`);
    } catch (err) {
      console.error(`[sync] Failed to save cache: ${err.message}`);
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────

  getItems()          { return this.state.items; }
  getItemCount()      { return this.state.items.length; }
  getUpdatedAt()      { return this.state.updatedAt; }
  getLastRunId()      { return this.lastRunId; }

  // ── Sync: single batch (resumes from last page in current date window) ──

  async syncNewBatch(workflows, batchSize = 10, maxExtraPages = 5) {
    let newCount = 0;
    let maxProcessedId = this.lastRunId;
    const existingRunIds = new Set(this.state.items.map(item => item.run_id));

    for (const wf of workflows) {
      if (newCount >= batchSize) break;

      // Always start from page 1 — the newest runs are there, and the Set-based
      // filter correctly skips already-processed runs regardless of page position.
      console.log(`[sync] Scanning ${wf} from page 1`);

      let page = 1;
      let createdBefore = null;
      let emptyStreak = 0;

      while (newCount < batchSize) {
        const result = await this._fetchRunsPage(wf, page, createdBefore);
        const runs = result.runs;

        if (runs.length === 0) break;

        // Use Set-based filtering instead of r.id > lastRunId. The ID filter
        // breaks when runs span multiple pages because newer pages have higher
        // IDs — once lastRunId is updated with a high ID, all remaining runs
        // on subsequent pages (with lower IDs) would be permanently invisible.
        const newRuns = runs.filter(r => !existingRunIds.has(r.id));

        if (newRuns.length === 0 && page === 1 && createdBefore === null) {
          // The very first (newest) page has no new runs — we're fully caught up.
          break;
        }

        if (newRuns.length > 0) {
          const needed = batchSize - newCount;
          const toProcess = newRuns.slice(0, needed);
          const concurrency = 5;
          for (let i = 0; i < toProcess.length; i += concurrency) {
            const batch = toProcess.slice(i, i + concurrency);
            const results = await Promise.all(
              batch.map(run => this._processAndAdd(run, wf))
            );
            const addedIds = results.filter(Boolean);
            newCount += addedIds.length;
            for (const id of addedIds) {
              existingRunIds.add(id);
              maxProcessedId = Math.max(maxProcessedId, id);
            }
          }
        }

        if (newCount < batchSize) page++;

        if (newRuns.length === 0) emptyStreak++;
        else emptyStreak = 0;
        if (emptyStreak >= maxExtraPages) break;

        if (page > 10 && runs.length > 0) {
          const oldestDate = runs[runs.length - 1].created_at;
          console.log(`[sync]   sliding window to before ${oldestDate.slice(0,10)}`);
          createdBefore = oldestDate;
          page = 1;
          emptyStreak = 0;
        }
      }

      this.state.scanState[wf] = { page, createdBefore, exhausted: false };
    }

    if (newCount > 0) {
      this.lastRunId = maxProcessedId;
      this._finalize();
    }
    const done = newCount === 0;
    console.log(`[sync] Batch: +${newCount} new, ${this.state.items.length} total${done ? ' (done)' : ''}`);
    return { newCount, totalItems: this.state.items.length, done };
  }

  // ── Sync: all remaining ─────────────────────────────────────────────────

  /**
   * Full sync — starts from page 1 and processes all un-synced runs.
   * Uses Set-based dedup to avoid re-processing runs that are already in the DB.
   */
  async syncAll(workflows, batchSize = 50) {
    let grandTotal = 0;
    let saveEvery = 50;
    let maxProcessedId = this.lastRunId;
    const existingRunIds = new Set(this.state.items.map(item => item.run_id));

    for (const wf of workflows) {
      let page = 1;
      let sinceSave = 0;
      let seenStreak = 0;

      console.log(`[sync] Full scan ${wf} from page 1 (${this.state.items.length} items)`);

      while (seenStreak < 3) {
        const result = await this._fetchRunsPage(wf, page);
        const runs = result.runs;

        if (runs.length === 0) {
          seenStreak++;
          page++;
          continue;
        }

        const newRuns = runs.filter(r => !existingRunIds.has(r.id));

        if (newRuns.length === 0) {
          seenStreak++;
          console.log(`[sync]   page ${page}: all ${runs.length} runs already synced, caught up`);
          page++;
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        seenStreak = 0;
        console.log(`[sync]   page ${page}: ${newRuns.length} new / ${runs.length} total, processing...`);

        const concurrency = 5;
        for (let i = 0; i < newRuns.length; i += concurrency) {
          const batch = newRuns.slice(i, i + concurrency);
          const results = await Promise.all(
            batch.map(run => this._processAndAdd(run, wf))
          );
          const addedIds = results.filter(Boolean);
          const added = addedIds.length;
          grandTotal += added;
          sinceSave += added;
          for (const id of addedIds) {
            existingRunIds.add(id);
            maxProcessedId = Math.max(maxProcessedId, id);
          }

          if (sinceSave >= saveEvery) {
            this.lastRunId = maxProcessedId;
            this._finalize();
            sinceSave = 0;
            console.log(`[sync]   progress: ${this.state.items.length} items, lastRunId=${this.lastRunId}`);
          }
        }

        page++;
        await new Promise(r => setTimeout(r, 200));
      }

      this.state.scanState[wf] = { page };
    }

    this.lastRunId = maxProcessedId;
    this._finalize();
    console.log(`[sync] All done: ${grandTotal} new, ${this.state.items.length} total, lastRunId=${this.lastRunId}`);
    return { newCount: grandTotal, totalItems: this.state.items.length };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  async _processAndAdd(run, workflowFile) {
    try {
      const record = await this.githubService.processRun(run, workflowFile);
      if (!record) return null;
      if (!this.searchService.validateRecord(record)) return null;

      const item = this.searchService.transformRecord(record);
      this.state.items.push(item);
      return run.id;
    } catch (err) {
      console.error(`[sync] Error processing run ${run.id}: ${err.message}`);
      return null;
    }
  }

  _finalize() {
    this.state.items = this.searchService.deduplicate(this.state.items);
    this.state.items.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
    this.save();
    this.searchService.cache = {
      updatedAt: Date.now(),
      items: this.state.items,
      stale: false,
      message: ''
    };
  }

  async _fetchRunsPage(workflowFile, page, createdBefore, retries = 3) {
    const url = `${this.githubService.baseUrl}/actions/workflows/${workflowFile}/runs`;
    const params = {
      event: this.githubService.workflowEvent,
      status: 'completed',
      branch: 'main',
      per_page: 100,
      page
    };
    if (createdBefore) params.created = `<${createdBefore}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) console.log(`[sync]   retry ${attempt}/${retries}...`);
        const resp = await axios.get(url, { headers: this.githubService.headers, params });
        const runs = (resp.data.workflow_runs || []).filter(
          r => r.status === 'completed' && r.conclusion === 'success'
        );
        return { runs, totalCount: resp.data.total_count || 0 };
      } catch (err) {
        if (err.response?.status === 403 && attempt < retries) {
          const wait = Math.pow(2, attempt) * 2000;
          console.error(`[sync] page ${page} 403, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.error(`[sync] page ${page} failed: ${err.message}`);
        return { runs: [], totalCount: 0 };
      }
    }
    return { runs: [], totalCount: 0 };
  }
}

module.exports = SyncManager;
