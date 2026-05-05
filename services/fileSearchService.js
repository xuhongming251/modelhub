/**
 * Service for caching, normalizing, deduplicating, and searching file records.
 *
 * Caching strategy:
 * - Data is cached in memory with a configurable TTL.
 * - When cache is fresh, searches run against in-memory data (zero GitHub API calls).
 * - When cache expires, the next request triggers a background refresh.
 * - If a refresh fails and we have stale cached data, we serve it with stale: true.
 */
class FileSearchService {
  constructor(githubService, cacheTTLSeconds = 30) {
    this.githubService = githubService;
    this.cacheTTL = cacheTTLSeconds * 1000;
    this.cache = {
      updatedAt: 0,
      items: [],
      stale: false,
      message: ''
    };
    this.refreshing = false;
    this.refreshPromise = null;
  }

  /**
   * Normalize a filename by removing trailing parenthesized numbers.
   *
   * Examples:
   *   "电影.mp4"      → "电影.mp4"
   *   "电影(1).mp4"   → "电影.mp4"
   *   "电影（2）.mp4" → "电影.mp4"
   *   "资料(3).zip"   → "资料.zip"
   *
   * Both half-width () and full-width （）parentheses are handled.
   */
  normalizeFilename(filename) {
    if (!filename) return '';
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf('.');
    const hasExt = dotIndex > 0;
    const base = hasExt ? trimmed.slice(0, dotIndex) : trimmed;
    const ext = hasExt ? trimmed.slice(dotIndex) : '';

    // Remove trailing parenthesized numbers: (1), (23), （1）, （456）
    const normalizedBase = base.replace(/\s*[\(（]\d+[\)）]\s*$/, '').trim();

    return `${normalizedBase}${ext}`.toLowerCase();
  }

  /**
   * Check whether a raw record from result.json has the minimum required fields.
   * filename is optional — we can derive it from the URL or run metadata.
   */
  validateRecord(record) {
    return !!(record && record.share_url);
  }

  /**
   * Transform a raw record (from GitHub Actions artifact) into a unified file record.
   *
   * result.json fields: local_file, share_url, channel, status, share_info, ...
   */
  transformRecord(raw) {
    const channelMap = { '0': 'Quark', '1': 'Baidu', '2': 'Mobile', 'quark': 'Quark', 'baidu': 'Baidu', 'mobile': 'Mobile' };

    // local_file is the clean original filename passed to the workflow
    let filename = raw.local_file || raw.filename || '';
    if (!filename) {
      filename = raw._run_display_title || raw._run_name || '';
    }

    const channel = raw.channel || '0';
    const channelName = raw.channel_name || channelMap[channel] || channel || 'Unknown';

    return {
      id: raw.trace_id || `run_${raw._run_id}`,
      run_id: raw._run_id,
      artifact_id: raw._artifact_id,
      filename: filename.trim(),
      normalized_name: this.normalizeFilename(filename),
      original_url: raw.original_url || '',
      share_url: raw.share_url || '',
      channel: channel,
      channel_name: channelName,
      completed_at: raw.completed_at || raw._run_updated_at || '',
      workflow: raw._workflow || ''
    };
  }

  /**
   * Deduplicate items by normalized filename.
   * When multiple records share the same normalized name, only the most recent
   * (by completed_at) is kept.
   */
  deduplicate(items) {
    const groups = new Map();

    for (const item of items) {
      const key = item.normalized_name;
      if (!key) continue;

      const existing = groups.get(key);
      if (!existing || (item.completed_at > existing.completed_at)) {
        groups.set(key, item);
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Refresh the cache by fetching all results from GitHub Actions.
   * If a refresh is already in progress, returns the existing promise (dedup).
   *
   * On success: cache is updated with fresh deduplicated + sorted items.
   * On failure: if we have stale cached data, mark it as stale; otherwise set error message.
   */
  async refresh(workflows, limit) {
    if (this.refreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshing = true;
    this.refreshPromise = this._doRefresh(workflows, limit);
    return this.refreshPromise;
  }

  /**
   * If cache is empty, do a blocking refresh. Otherwise return immediately
   * and trigger a background refresh if cache is expired. This prevents
   * the UI from hanging on every request.
   */
  async ensureFresh(workflows, limit) {
    if (this.cache.items.length === 0) {
      // First load — must wait for data
      return this.refresh(workflows, limit);
    }

    if (this.isExpired() && !this.refreshing) {
      // Stale but has data — refresh in background, don't block
      this.refreshInBackground(workflows, limit);
    }
  }

  refreshInBackground(workflows, limit) {
    // Fire-and-forget refresh that doesn't return a promise to the caller
    this.refresh(workflows, limit).catch(err => {
      console.error('Background refresh failed:', err.message);
    });
  }

  async _doRefresh(workflows, limit) {
    try {
      const rawResults = await this.githubService.fetchAllResults(workflows, limit);

      console.log(`=== Raw results count: ${rawResults.length} ===`);
      if (rawResults.length > 0) {
        console.log('--- First raw record ALL keys:');
        console.log(Object.keys(rawResults[0]));
        console.log('--- First raw record FULL JSON:');
        console.log(JSON.stringify(rawResults[0], null, 2));
        console.log('--- All raw records key fields:');
        rawResults.slice(0, 10).forEach((r, i) => {
          console.log(`  [${i}] original_url: ${r.original_url || '(empty)'}`);
          console.log(`  [${i}] filename:     ${r.filename || '(empty)'}`);
          console.log(`  [${i}] share_url:    ${(r.share_url || '').slice(0, 80)}`);
          console.log(`  [${i}] trace_id:     ${r.trace_id || '(empty)'}`);
          console.log(`  [${i}] _run_name:    ${r._run_name || '(empty)'}`);
          console.log(`  [${i}] _run_display: ${r._run_display_title || '(empty)'}`);
          console.log('  ---');
        });
      }

      const transformed = rawResults
        .filter(r => this.validateRecord(r))
        .map(r => this.transformRecord(r));

      console.log(`=== After validation + transform: ${transformed.length} records ===`);
      if (transformed.length > 0) {
        console.log('--- First 5 transformed filenames:');
        transformed.slice(0, 5).forEach((r, i) => {
          console.log(`  [${i}] filename:  "${r.filename}"`);
          console.log(`  [${i}] norm_name: "${r.normalized_name}"`);
          console.log(`  [${i}] channel:   ${r.channel_name}`);
          console.log(`  [${i}] time:      ${r.completed_at}`);
          console.log('  ---');
        });
      }

      const deduped = this.deduplicate(transformed);

      deduped.sort((a, b) => {
        const da = a.completed_at || '';
        const db = b.completed_at || '';
        return db.localeCompare(da);
      });

      this.cache = {
        updatedAt: Date.now(),
        items: deduped,
        stale: false,
        message: ''
      };

      console.log(`Cache refreshed: ${deduped.length} unique records`);
    } catch (err) {
      console.error('Cache refresh failed:', err.message);

      if (this.cache.items.length > 0) {
        this.cache.stale = true;
        this.cache.message = 'GitHub API 暂时不可用，当前展示缓存数据';
        console.log('Serving stale cache data');
      } else {
        this.cache.message = '同步失败，请稍后重试';
      }
    } finally {
      this.refreshing = false;
      this.refreshPromise = null;
    }
  }

  /**
   * Check whether the cache has expired.
   */
  isExpired() {
    return Date.now() - this.cache.updatedAt > this.cacheTTL;
  }

  /**
   * Search cached items by keyword.
   * If query is empty, returns the most recent items up to `limit`.
   * Search matches against both filename and normalized_name.
   * Case-insensitive. Trims whitespace from query.
   */
  search(query, limit = 50) {
    if (!query || !query.trim()) {
      return this.cache.items.slice(0, limit);
    }

    const q = query.trim().toLowerCase();
    const results = this.cache.items.filter(item => {
      return item.filename.toLowerCase().includes(q) ||
             item.normalized_name.includes(q);
    });

    return results.slice(0, limit);
  }

  /**
   * Return cache summary metadata (for the API response header / status display).
   */
  getSummary() {
    return {
      updatedAt: this.cache.updatedAt,
      total: this.cache.items.length,
      stale: this.cache.stale,
      message: this.cache.message
    };
  }
}

module.exports = FileSearchService;
