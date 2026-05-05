const axios = require('axios');
const AdmZip = require('adm-zip');

/**
 * Service for interacting with GitHub Actions API.
 * Handles fetching workflow runs, artifacts, and parsing result.json from artifact zips.
 */
class GitHubActionsService {
  constructor(token, owner, repo, options = {}) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    this.workflowEvent = options.workflowEvent || 'workflow_dispatch';
    this.headers = {
      'Authorization': token ? `Bearer ${token}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /**
   * Fetch completed + successful workflow runs for a given workflow file.
   * Supports pagination up to `limit` total runs.
   */
  async fetchWorkflowRuns(workflowFile, limit = 50) {
    const url = `${this.baseUrl}/actions/workflows/${workflowFile}/runs`;
    const allRuns = [];
    let page = 1;

    while (allRuns.length < limit) {
      try {
        const perPage = Math.min(100, limit - allRuns.length);
        const resp = await axios.get(url, {
          headers: this.headers,
          params: {
            event: this.workflowEvent,
            status: 'completed',
            branch: 'main',
            per_page: perPage,
            page
          }
        });

        const runs = (resp.data.workflow_runs || []).filter(
          r => r.status === 'completed' && r.conclusion === 'success'
        );

        allRuns.push(...runs);

        if (runs.length === 0 || allRuns.length >= limit) break;
        page++;
      } catch (err) {
        console.error(`Failed to fetch workflow runs for ${workflowFile} (page ${page}):`, err.message);
        if (err.response?.status === 401) {
          console.error('GitHub API authentication failed. Your GITHUB_TOKEN is invalid or expired. Please generate a new token at https://github.com/settings/tokens');
        } else if (err.response?.status === 403) {
          console.error('GitHub API rate limit may have been exceeded, or the token lacks required permissions (needs actions:read scope).');
        }
        break;
      }
    }

    return allRuns.slice(0, limit);
  }

  /**
   * Fetch all artifacts for a given workflow run.
   */
  async fetchArtifacts(runId) {
    const url = `${this.baseUrl}/actions/runs/${runId}/artifacts`;
    try {
      const resp = await axios.get(url, { headers: this.headers });
      return resp.data.artifacts || [];
    } catch (err) {
      console.error(`Failed to fetch artifacts for run ${runId}:`, err.message);
      return [];
    }
  }

  /**
   * Download an artifact zip by ID and parse the result.json inside it.
   * Returns the parsed JSON object, or null if download/parse fails.
   */
  async downloadAndParseArtifact(artifactId, retries = 3) {
    const url = `${this.baseUrl}/actions/artifacts/${artifactId}/zip`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) console.log(`  Artifact ${artifactId}: retry ${attempt}/${retries}...`);
        const resp = await axios.get(url, {
          headers: this.headers,
          responseType: 'arraybuffer',
          timeout: 15000
        });

        const zip = new AdmZip(Buffer.from(resp.data));
        const entry = zip.getEntry('result.json');
        if (!entry) {
          console.warn(`Artifact ${artifactId}: no result.json entry found in zip`);
          return null;
        }

        const content = entry.getData().toString('utf8');
        const parsed = JSON.parse(content);

        if (!parsed || typeof parsed !== 'object') {
          console.warn(`Artifact ${artifactId}: result.json is not a valid object`);
          return null;
        }

        return parsed;
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.error(`Artifact ${artifactId}: result.json is not valid JSON`);
          return null; // no point retrying a parse error
        }
        if (err.code === 'ECONNABORTED' && attempt < retries) {
          const wait = Math.pow(2, attempt) * 2000;
          console.error(`Artifact ${artifactId}: download timed out, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (err.response?.status === 403 && attempt < retries) {
          const wait = Math.pow(2, attempt) * 2000;
          console.error(`Artifact ${artifactId}: 403 rate limit, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (attempt < retries) {
          const wait = Math.pow(2, attempt) * 2000;
          console.error(`Artifact ${artifactId}: download/parse failed — ${err.message}, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.error(`Artifact ${artifactId}: download/parse failed after ${retries} retries — ${err.message}`);
        return null;
      }
    }
    return null;
  }

  /**
   * Process a single run: fetch its artifacts, find the 'result' artifact,
   * download and parse it. Returns the augmented result or null.
   */
  async processRun(run, workflowFile, logDetail = false) {
    try {
      const artifacts = await this.fetchArtifacts(run.id);
      const resultArtifact = artifacts.find(a => a.name === 'result');
      if (!resultArtifact) {
        console.log(`  Run ${run.id}: no 'result' artifact found among ${artifacts.length} artifacts`);
        return null;
      }

      const data = await this.downloadAndParseArtifact(resultArtifact.id);
      if (!data) {
        console.log(`  Run ${run.id}: failed to download/parse result.json`);
        return null;
      }

      if (logDetail) {
        console.log(`  --- Run ${run.id} result.json keys:`, Object.keys(data));
        console.log(`  --- Run ${run.id} result.json:`, JSON.stringify(data));
      }

      return {
        ...data,
        _run_id: run.id,
        _artifact_id: resultArtifact.id,
        _workflow: workflowFile,
        _run_updated_at: run.updated_at,
        _run_name: run.name || '',
        _run_display_title: run.display_title || ''
      };
    } catch (err) {
      console.error(`Error processing run ${run.id} (${workflowFile}):`, err.message);
      return null;
    }
  }

  /**
   * Fetch all results across all configured workflows.
   * Processes runs in parallel with a concurrency limit.
   */
  async fetchAllResults(workflows, limit) {
    // Phase 1: collect all runs from all workflows
    const allRuns = [];
    for (const workflowFile of workflows) {
      console.log(`Fetching runs for workflow: ${workflowFile}`);
      const runs = await this.fetchWorkflowRuns(workflowFile, limit);
      console.log(`Found ${runs.length} completed/successful runs for ${workflowFile}`);
      if (runs.length > 0) {
        console.log('First 3 run samples:');
        runs.slice(0, 3).forEach((r, i) => {
          console.log(`  run[${i}] id:${r.id} name:"${r.name}" display:"${r.display_title}"`);
        });
      }
      allRuns.push(...runs.map(r => ({ run: r, workflowFile })));
    }

    // Phase 2: process runs in parallel with concurrency limit
    const concurrency = 5;
    const results = [];
    let processedCount = 0;
    for (let i = 0; i < allRuns.length; i += concurrency) {
      const batch = allRuns.slice(i, i + concurrency);
      const isFirstBatch = processedCount === 0;
      const batchResults = await Promise.all(
        batch.map(({ run, workflowFile }) => this.processRun(run, workflowFile, isFirstBatch))
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }
      processedCount += batch.length;
    }

    console.log(`Total results collected: ${results.length}`);
    if (results.length > 0) {
      console.log('=== result.json first 3 augmented records ===');
      results.slice(0, 3).forEach((r, i) => {
        console.log(`  [${i}] keys:`, Object.keys(r));
        console.log(`  [${i}] data:`, JSON.stringify(r).slice(0, 600));
        console.log('  ---');
      });
    }
    return results;
  }
}

module.exports = GitHubActionsService;
