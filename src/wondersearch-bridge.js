/**
 * Wondersearch Bridge for @krusch/polygres-connector
 * Provides native passage search, drive management, and code chunk indexing
 * against Wondersearch Cloud API with bounded concurrency, retries, and strict air-gap guards.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { assertCloudAllowed, assertMatterNotPrivileged } from './config.js';

export class WondersearchBridge {
  constructor(config = {}) {
    this.apiKey = config.wondersearchApiKey || process.env.WONDERSEARCH_API_KEY;
    this.baseUrl = (config.wondersearchBaseUrl || process.env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai').replace(/\/+$/, '');
    this.workspaceId = config.wondersearchWorkspaceId || process.env.WONDERSEARCH_WORKSPACE_ID || null;
    this.defaultDriveId = config.wondersearchDefaultDriveId || process.env.WONDERSEARCH_DEFAULT_DRIVE_ID || null;
    this.allowCloud = config.allowCloud;
    this.timeoutMs = config.timeoutMs || 15000;
    this.concurrency = config.concurrency || 6;
    this.driveCache = new Map();
  }

  async close() {
    this.driveCache.clear();
  }

  _headers(idempotencyKey) {
    if (!this.apiKey) {
      throw new Error('WondersearchBridge requires an API key. Set WONDERSEARCH_API_KEY in environment.');
    }
    assertCloudAllowed(this.baseUrl, this.allowCloud);

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': '@krusch/polygres-connector/0.1.0'
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    } else {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
    return headers;
  }

  /**
   * Helper to execute fetch with exponential backoff on transient errors (429, 5xx)
   */
  async _fetchWithRetry(url, options, maxRetries = 3) {
    let attempt = 0;
    let delay = 300;

    while (true) {
      try {
        const res = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
          if (attempt < maxRetries) {
            attempt++;
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
            continue;
          }
        }

        return res;
      } catch (err) {
        if (attempt < maxRetries && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          attempt++;
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Resolve workspace ID and default drive ID from Wondersearch API /v1/sdk/context if not preconfigured
   */
  async getWorkspaceContext() {
    if (this.workspaceId && this.defaultDriveId) {
      return { workspaceId: this.workspaceId, defaultDriveId: this.defaultDriveId };
    }
    const res = await this._fetchWithRetry(`${this.baseUrl}/v1/sdk/context`, {
      headers: this._headers()
    });
    if (res.ok) {
      const data = await res.json();
      if (!this.workspaceId && data.workspace_id) this.workspaceId = data.workspace_id;
      if (!this.defaultDriveId && data.default_drive_id) this.defaultDriveId = data.default_drive_id;
    }
    return { workspaceId: this.workspaceId, defaultDriveId: this.defaultDriveId };
  }

  /**
   * Search a drive or default workspace drive
   */
  async search({ driveId, query, effort = 'medium', limit = 5, groupByDocument = true, folderId = null }) {
    if (!driveId && !this.workspaceId) {
      await this.getWorkspaceContext().catch(() => {});
    }
    const targetDriveId = driveId || this.defaultDriveId;
    let url;
    if (targetDriveId) {
      url = `${this.baseUrl}/v1/drives/${targetDriveId}/search`;
    } else if (this.workspaceId) {
      url = `${this.baseUrl}/v1/workspaces/${this.workspaceId}/search`;
    } else {
      throw new Error('search() requires either a driveId or a configured workspaceId.');
    }

    const payload = {
      query,
      effort,
      limit: Math.min(Math.max(1, limit), 100),
      group_by_document: groupByDocument
    };
    if (folderId) payload.folder_id = folderId;

    const res = await this._fetchWithRetry(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Wondersearch query failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return {
      requestId: data.request_id,
      driveId: data.drive_id,
      results: (data.results || []).map(r => ({
        documentId: r.document_id,
        externalId: r.external_id,
        revision: r.document_revision,
        passageId: r.passage_id,
        text: r.text,
        startByte: r.start_byte,
        endByte: r.end_byte,
        metadata: r.metadata || {},
        score: r.score
      })),
      usage: data.usage || {},
      warnings: data.warnings || []
    };
  }

  /**
   * Ingest text content into a Wondersearch drive with retry and strict air-gap guards
   */
  async ingestDocument({ driveId, externalId, text, metadata = {} }) {
    if (!driveId) throw new Error('ingestDocument() requires driveId');

    // Classification air-gap guard: strictly reject privileged litigation matters
    if (metadata.classification === 'privileged' || metadata.domain === 'matter') {
      throw new Error(
        `[AirGapSecurityError] Document '${externalId}' marked as privileged litigation matter. Cloud egress blocked under ABA Model Rule 1.6.`
      );
    }

    const url = `${this.baseUrl}/v1/drives/${driveId}/documents`;
    const payload = {
      external_id: externalId,
      text,
      metadata: {
        ...metadata,
        indexed_by: '@krusch/polygres-connector',
        indexed_at: new Date().toISOString()
      }
    };

    const res = await this._fetchWithRetry(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Wondersearch document ingestion failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  /**
   * Create or resolve a drive by name in the workspace.
   * Handles 409 conflict gracefully if two concurrent processes create the same drive.
   */
  async createOrGetDrive(driveName) {
    if (this.driveCache.has(driveName)) {
      return this.driveCache.get(driveName);
    }
    if (!this.workspaceId) {
      await this.getWorkspaceContext().catch(() => {});
    }
    if (!this.workspaceId) {
      throw new Error('createOrGetDrive() requires WONDERSEARCH_WORKSPACE_ID.');
    }

    const listUrl = `${this.baseUrl}/v1/workspaces/${this.workspaceId}/drives`;
    const listRes = await this._fetchWithRetry(listUrl, {
      headers: this._headers()
    });

    if (listRes.ok) {
      const listData = await listRes.json();
      const drives = listData.data || listData.drives || [];
      const match = drives.find(d => d.name === driveName);
      if (match) {
        this.driveCache.set(driveName, match.id);
        return match.id;
      }
    }

    // Attempt creation
    const createRes = await this._fetchWithRetry(listUrl, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ name: driveName })
    });

    if (createRes.status === 409) {
      // Conflict: another process created the drive. Re-fetch list.
      const retryListRes = await this._fetchWithRetry(listUrl, { headers: this._headers() });
      if (retryListRes.ok) {
        const retryData = await retryListRes.json();
        const drives = retryData.data || retryData.drives || [];
        const match = drives.find(d => d.name === driveName);
        if (match) {
          this.driveCache.set(driveName, match.id);
          return match.id;
        }
      }
    }

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create Wondersearch drive '${driveName}': ${errText}`);
    }

    const newDrive = await createRes.json();
    this.driveCache.set(driveName, newDrive.id);
    return newDrive.id;
  }

  /**
   * Helper to execute a pool of worker tasks with bounded concurrency
   */
  async _runConcurrent(items, fn) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
      const p = Promise.resolve().then(() => fn(item));
      results.push(p);
      executing.add(p);
      const clean = () => executing.delete(p);
      p.then(clean, clean);

      if (executing.size >= this.concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  /**
   * Synchronize Authority Packs (.yaml) into Wondersearch with realpath matter denial
   */
  async syncAuthorityPacks(packsDir, driveName = 'repo-krusch-law-statutes') {
    assertMatterNotPrivileged(packsDir);

    if (!fs.existsSync(packsDir)) {
      throw new Error(`Authority packs directory not found: ${packsDir}`);
    }

    const driveId = await this.createOrGetDrive(driveName);
    const files = fs.readdirSync(packsDir, { recursive: true })
      .filter(f => typeof f === 'string' && (f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')));

    const validFiles = [];
    for (const relFile of files) {
      const fullPath = path.join(packsDir, relFile);
      assertMatterNotPrivileged(fullPath);
      const text = fs.readFileSync(fullPath, 'utf8');

      if (/classification:\s*["']?privileged["']?/i.test(text) || /domain:\s*["']?matter["']?/i.test(text)) {
        throw new Error(`[AirGapSecurityError] File '${relFile}' marked as privileged matter. Cloud egress blocked under ABA Model Rule 1.6.`);
      }
      validFiles.push({ relFile, text });
    }

    let indexedCount = 0;
    await this._runConcurrent(validFiles, async ({ relFile, text }) => {
      await this.ingestDocument({
        driveId,
        externalId: `law://${relFile}`,
        text,
        metadata: { domain: 'law', file_path: relFile }
      });
      indexedCount++;
    });

    return { driveId, documentsIndexed: indexedCount };
  }

  /**
   * Synchronize commercial contract playbooks and templates into Wondersearch
   */
  async syncPlaybooks(playbooksDir, driveName = 'repo-krusch-biz-playbooks') {
    if (!fs.existsSync(playbooksDir)) {
      throw new Error(`Playbooks directory not found: ${playbooksDir}`);
    }

    const driveId = await this.createOrGetDrive(driveName);
    const files = fs.readdirSync(playbooksDir, { recursive: true })
      .filter(f => typeof f === 'string' && (f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json') || f.endsWith('.yaml')));

    let indexedCount = 0;
    await this._runConcurrent(files, async (relFile) => {
      const fullPath = path.join(playbooksDir, relFile);
      const text = fs.readFileSync(fullPath, 'utf8');
      await this.ingestDocument({
        driveId,
        externalId: `biz://${relFile}`,
        text,
        metadata: { domain: 'biz', file_path: relFile }
      });
      indexedCount++;
    });

    return { driveId, documentsIndexed: indexedCount };
  }

  /**
   * Search statutes across public Authority Packs on Wondersearch
   */
  async searchLaw(query, options = {}) {
    const driveId = await this.createOrGetDrive(options.driveName || 'repo-krusch-law-statutes');
    return this.search({ driveId, query, ...options });
  }

  /**
   * Search commercial clauses across the KruschBiz Wondersearch drive
   */
  async searchBiz(query, options = {}) {
    const driveId = await this.createOrGetDrive(options.driveName || 'repo-krusch-biz-playbooks');
    return this.search({ driveId, query, ...options });
  }
}
