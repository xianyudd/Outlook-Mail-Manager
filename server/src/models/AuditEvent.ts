import db from '../database';

export interface AuditEventRecord {
  id: number;
  ts: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  mailbox: string | null;
  status: string;
  reason: string | null;
  request_id: string | null;
  job_id: string | null;
  extra_json: string;
}

export interface CreateAuditEventInput {
  actor_type: string;
  actor_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  mailbox?: string | null;
  status: string;
  reason?: string | null;
  request_id?: string | null;
  job_id?: string | null;
  extra_json?: string | null;
}

export class AuditEventModel {
  create(input: CreateAuditEventInput): AuditEventRecord {
    const result = db.prepare(`
      INSERT INTO audit_events (
        actor_type,
        actor_id,
        action,
        target_type,
        target_id,
        mailbox,
        status,
        reason,
        request_id,
        job_id,
        extra_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.actor_type,
      input.actor_id ?? null,
      input.action,
      input.target_type ?? null,
      input.target_id ?? null,
      input.mailbox ?? null,
      input.status,
      input.reason ?? null,
      input.request_id ?? null,
      input.job_id ?? null,
      input.extra_json ?? '{}',
    );

    return db.prepare('SELECT * FROM audit_events WHERE id = ?').get(result.lastInsertRowid) as AuditEventRecord;
  }

  listByJobId(jobId: string, limit = 200): AuditEventRecord[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;

    return db.prepare(`
      SELECT *
      FROM audit_events
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(jobId, safeLimit) as AuditEventRecord[];
  }
}
