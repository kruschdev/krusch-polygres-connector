/**
 * Wondersearch Bridge for @krusch/polygres-connector
 * Provides native passage search, drive management, and code chunk indexing
 * against Evokoa / Wondersearch Cloud API with timeout resilience and air-gap guards.
 */

import crypto from 'crypto';
import { assertCloudAllowed } from './config.js';

export class WondersearchBridge {
  constructor(config = {}) {
    this.apiKey = config.wondersearchApiKey || process.env.WONDERSEARCH_API_KEY || process.env.POLYGRES_API_KEY;
    this.baseUrl = (config.wondersearchBaseUrl || process.env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai').replace(/\/+$/, '');
    this.workspaceId = config.wondersearchWorkspaceId || process.env.WONDERSEARCH_WORKSPACE_ID || null;
    this.allowCloud = config.allowCloud;
    this.timeoutMs = config.timeoutMs || 15000;
    this.driveCache = new Map();
  }

  _headers(idempotencyKey) {
    if (!this.apiKey) {
      throw new Error('WondersearchBridge requires an API key. Set WONDERSEARCH_API_KEY or POLYGRES_API_KEY.');
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
      headers['Idempotency-Key'] = `krusch-${crypto.randomBytes(8).toString('hex')}`;
    }
    return headers;
  }

  /**
   * Search a drive or default workspace drive
   */
  async search({ driveId, query, effort = 'medium', limit = 5, groupByDocument = true, folderId = null }) {
    let url;
    if (driveId) {
      url = `${this.baseUrl}/v1/drives/${driveId}/search`;
    } else if (this.workspaceId) {
      url = `${this.baseUrl}/v1/workspaces/${this.workspaceId}/search`;
    } else {
      throw new Error('search() requires either a driveId or a configured workspaceId.');
    }

    const payload = {
      query,
      effort,
      limit,
      group_by_document: groupByDocument
    };
    if (folderId) payload.folder_id = folderId;

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
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
   * Ingest text content into a Wondersearch drive
   */
  async ingestDocument({ driveId, externalId, text, metadata = {} }) {
    if (!driveId) throw new Error('ingestDocument() requires driveId');

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

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Wondersearch document ingestion failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  /**
   * Create or resolve a drive by name in the workspace
   */
  async createOrGetDrive(driveName) {
    if (this.driveCache.has(driveName)) {
      return this.driveCache.get(driveName);
    }
    if (!this.workspaceId) {
      throw new Error('createOrGetDrive() requires WONDERSEARCH_WORKSPACE_ID.');
    }

    const listUrl = `${this.baseUrl}/v1/workspaces/${this.workspaceId}/drives`;
    const listRes = await fetch(listUrl, {
      headers: this._headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const match = (listData.drives || []).find(d => d.name === driveName);
      if (match) {
        this.driveCache.set(driveName, match.id);
        return match.id;
      }
    }

    // Create new drive
    const createRes = await fetch(listUrl, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ name: driveName }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create Wondersearch drive '${driveName}': ${errText}`);
    }

    const newDrive = await createRes.json();
    this.driveCache.set(driveName, newDrive.id);
    return newDrive.id;
  }

  /**
   * Synchronize Authority Packs (.yaml) into Wondersearch with fail-closed KruschLaw air-gap guard
   */
  async syncAuthorityPacks(packsDir, driveName = 'repo-krusch-law-statutes') {
    // Air-gap guard: KruschLaw matter stores must never egress to cloud
    if (packsDir.includes('krusch-law/data/matters') || packsDir.includes('evidence')) {
      throw new Error(
        `[AirGapSecurityError] KruschLaw privileged matter data is 100% air-gapped on-premises. Egress of '${packsDir}' to cloud Wondersearch is blocked by sovereign policy (ABA Model Rule 1.6).`
      );
    }

    const fs = await import('fs');
    const path = await import('path');
    const driveId = await this.createOrGetDrive(driveName);

    if (!fs.existsSync(packsDir)) {
      throw new Error(`Authority packs directory not found: ${packsDir}`);
    }

    const files = fs.readdirSync(packsDir, { recursive: true })
      .filter(f => typeof f === 'string' && (f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')));

    let count = 0;
    for (const relFile of files) {
      const fullPath = path.join(packsDir, relFile);
      const text = fs.readFileSync(fullPath, 'utf8');
      await this.ingestDocument({
        driveId,
        externalId: `law://${relFile}`,
        text,
        metadata: { domain: 'law', file_path: relFile }
      });
      count++;
    }
    return { driveId, documentsIndexed: count };
  }

  /**
   * Synchronize commercial contract playbooks and templates into Wondersearch
   */
  async syncPlaybooks(playbooksDir, driveName = 'repo-krusch-biz-playbooks') {
    const fs = await import('fs');
    const path = await import('path');
    const driveId = await this.createOrGetDrive(driveName);

    if (!fs.existsSync(playbooksDir)) {
      throw new Error(`Playbooks directory not found: ${playbooksDir}`);
    }

    const files = fs.readdirSync(playbooksDir, { recursive: true })
      .filter(f => typeof f === 'string' && (f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json') || f.endsWith('.yaml')));

    let count = 0;
    for (const relFile of files) {
      const fullPath = path.join(playbooksDir, relFile);
      const text = fs.readFileSync(fullPath, 'utf8');
      await this.ingestDocument({
        driveId,
        externalId: `biz://${relFile}`,
        text,
        metadata: { domain: 'biz', file_path: relFile }
      });
      count++;
    }
    return { driveId, documentsIndexed: count };
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
