/**
 * Wondersearch Bridge for @krusch/polygres-connector
 * Provides native passage search, drive management, and code chunk indexing
 * against Evokoa / Wondersearch Cloud API.
 */

import crypto from 'crypto';

export class WondersearchBridge {
  constructor(config = {}) {
    this.apiKey = config.wondersearchApiKey || process.env.WONDERSEARCH_API_KEY || process.env.POLYGRES_API_KEY;
    this.baseUrl = (config.wondersearchBaseUrl || process.env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai').replace(/\/+$/, '');
    this.workspaceId = config.wondersearchWorkspaceId || process.env.WONDERSEARCH_WORKSPACE_ID || null;
    this.driveCache = new Map();
  }

  _headers(idempotencyKey) {
    if (!this.apiKey) {
      throw new Error('WondersearchBridge requires an API key. Set WONDERSEARCH_API_KEY or POLYGRES_API_KEY.');
    }
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
      body: JSON.stringify(payload)
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
    const listRes = await fetch(listUrl, { headers: this._headers() });
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
      body: JSON.stringify({ name: driveName })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create Wondersearch drive '${driveName}': ${errText}`);
    }

    const newDrive = await createRes.json();
    this.driveCache.set(driveName, newDrive.id);
    return newDrive.id;
  }
}
