const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Persistent incremental sync manager.
 *
 * Stores only the latest processed run ID (lastRunId). Since GitHub Actions
 * run IDs are monotonically increasing, any run with id > lastRunId is new.
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

    for (const wf of workflows) {
      if (newCount >= batchSize) break;

      let scan = this.state.scanState[wf] || { page: 1, createdBefore: null, exhausted: false };
      const lastSync = this.state.updatedAt ? Date.now() - new Date(this.state.updatedAt).getTime() : Infinity;
      const RESET_THRESHOLD = 30 * 60 * 1000; // 30 min — match CI schedule

      // Reset exhausted workflows so new runs are discovered. Already-processed
      // runs are still skipped via lastRunId, so this is cheap (at most a few
      // empty pages before emptyStreak stops the scan).
      if (scan.exhausted) {
        console.log(`[sync] ${wf} was exhausted — resetting to check for new runs`);
        scan = { page: 1, createdBefore: null, exhausted: false };
      } else if (lastSync > RESET_THRESHOLD) {
        // If the last sync was long ago, fresh scan is more efficient than
        // resuming a stale page/date-window position.
        console.log(`[sync] ${wf} last sync was ${Math.round(lastSync / 60000)}min ago — fresh scan`);
        scan = { page: 1, createdBefore: null, exhausted: false };
      }

      console.log(`[sync] Scanning ${wf} from page ${scan.page}`);

      let emptyStreak = 0;
      while (newCount < batchSize) {
        const result = await this._fetchRunsPage(wf, scan.page, scan.createdBefore);
        const runs = result.runs;

        if (runs.length === 0) {
          scan.exhausted = true;
          break;
        }

        const oldestDate = runs[runs.length - 1].created_at;
        const newRuns = runs.filter(r => r.id > this.lastRunId);
        const hasNew = newRuns.length > 0;

        if (hasNew) {
          const needed = batchSize - newCount;
          const toProcess = newRuns.slice(0, needed);
          const concurrency = 5;
          for (let i = 0; i < toProcess.length; i += concurrency) {
            const batch = toProcess.slice(i, i + concurrency);
            const results = await Promise.all(
              batch.map(run => this._processAndAdd(run, wf))
            );
            newCount += results.filter(Boolean).length;
          }
        }

        if (newCount < batchSize) scan.page++;
        if (!hasNew) emptyStreak++;
        else emptyStreak = 0;
        if (emptyStreak >= maxExtraPages) break;

        if (scan.page > 10 && oldestDate) {
          console.log(`[sync]   sliding window to before ${oldestDate.slice(0,10)}`);
          scan.createdBefore = oldestDate;
          scan.page = 1;
          emptyStreak = 0;
        }
      }

      this.state.scanState[wf] = scan;
    }

    this._finalize();
    const done = newCount === 0;
    console.log(`[sync] Batch: +${newCount} new, ${this.state.items.length} total${done ? ' (done)' : ''}`);
    return { newCount, totalItems: this.state.items.length, done };
  }

  // ── Sync: all remaining ─────────────────────────────────────────────────

  /**
   * Always starts from page 1 (newest first). Stops when hitting a run with
   * id <= lastRunId, since all subsequent runs are older and already processed.
   */
  async syncAll(workflows, batchSize = 50) {
    let grandTotal = 0;
    let saveEvery = 50;

    for (const wf of workflows) {
      let page = 1;
      let sinceSave = 0;
      let seenStreak = 0;

      console.log(`[sync] Full scan ${wf} from page 1 (lastRunId=${this.lastRunId})`);

      while (seenStreak < 3) {
        const result = await this._fetchRunsPage(wf, page);
        const runs = result.runs;

        if (runs.length === 0) {
          seenStreak++;
          page++;
          continue;
        }

        const newRuns = runs.filter(r => r.id > this.lastRunId);

        if (newRuns.length === 0) {
          seenStreak++;
          console.log(`[sync]   page ${page}: all ${runs.length} runs <= lastRunId, caught up`);
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
          const added = results.filter(Boolean).length;
          grandTotal += added;
          sinceSave += added;

          if (sinceSave >= saveEvery) {
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

    this._finalize();
    console.log(`[sync] All done: ${grandTotal} new, ${this.state.items.length} total, lastRunId=${this.lastRunId}`);
    return { newCount: grandTotal, totalItems: this.state.items.length };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  async _processAndAdd(run, workflowFile) {
    try {
      const record = await this.githubService.processRun(run, workflowFile);
      if (!record) return false;
      if (!this.searchService.validateRecord(record)) return false;

      const item = this.searchService.transformRecord(record);
      this.state.items.push(item);
      this.lastRunId = Math.max(this.lastRunId, run.id);
      return true;
    } catch (err) {
      console.error(`[sync] Error processing run ${run.id}: ${err.message}`);
      return false;
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
