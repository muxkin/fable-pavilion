import { Buffer } from 'node:buffer';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  desktopAuthorizationLifetime,
  desktopAuthorizationProof,
  type AccountDesktop,
  type AdminDesktopEnrollment,
  type DesktopAuthorization,
} from '../shared/desktop-authorization.js';
import type { MessagingDatabase } from './messaging/database.js';

type Approval = 'ok' | 'expired' | 'invalid' | 'conflict' | 'limit';
export interface DesktopAuthorizations {
  approve(account: string, request: DesktopAuthorization, origin: string): Promise<Approval>;
  list(account: string): AccountDesktop[] | Promise<AccountDesktop[]>;
  ready(account: string, hostId: string, ticket: string): boolean | Promise<boolean>;
  revoke(account: string, hostId: string): boolean | Promise<boolean>;
  rename?: (account: string, hostId: string, name: string) => boolean | Promise<boolean>;
  listAll?: () => AdminDesktopEnrollment[] | Promise<AdminDesktopEnrollment[]>;
  revokeAny?: (hostId: string) => boolean | Promise<boolean>;
  migrateAccount?: (fromAccount: string, toAccount: string) => number | Promise<number>;
}

export class DesktopEnrollmentStore {
  constructor(
    private db: Pick<MessagingDatabase, 'exec' | 'prepare'>,
    private origins: ReadonlySet<string>,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_enrollments (
        host TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL,
        ticket TEXT NOT NULL, issued INTEGER NOT NULL, revoked INTEGER
      );
      CREATE INDEX IF NOT EXISTS desktop_enrollments_owner ON desktop_enrollments(account);
    `);
  }

  status(hostId: string): boolean | undefined {
    const row = this.db.prepare('SELECT revoked FROM desktop_enrollments WHERE host=?').get(hostId);
    return row && row.revoked === null;
  }

  async approve(account: string, request: DesktopAuthorization, origin: string): Promise<Approval> {
    if (!this.origins.has(origin)) return 'invalid';
    const expires = request.issuedAt + desktopAuthorizationLifetime;
    if (expires <= Date.now() || request.issuedAt > Date.now() + 30_000) return 'expired';
    try {
      const key = peerIdFromString(request.hostId).publicKey;
      if (
        !key ||
        !(await key.verify(
          desktopAuthorizationProof(origin, request),
          Buffer.from(request.signature, 'base64'),
        ))
      )
        return 'invalid';
    } catch {
      return 'invalid';
    }
    if (expires <= Date.now()) return 'expired';

    // Everything below is synchronous. An active host can only be claimed by one account,
    // while a previously revoked host can be freshly claimed with a newer signed request.
    const current = this.db.prepare('SELECT * FROM desktop_enrollments WHERE host=?').get(request.hostId);
    if (current && current.revoked === null && current.account !== account) return 'conflict';
    if (current?.revoked === null && current.ticket === request.ticket) return 'ok';
    if (current && request.issuedAt <= Math.max(Number(current.issued), Number(current.revoked ?? 0)))
      return 'expired';
    if ((!current || current.revoked !== null) && this.list(account).length >= 100) return 'limit';
    this.db
      .prepare(
        `
      INSERT INTO desktop_enrollments VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(host) DO UPDATE SET account=excluded.account, name=excluded.name, ticket=excluded.ticket,
        issued=excluded.issued, revoked=NULL
    `,
      )
      .run(request.hostId, account, request.name, request.ticket, request.issuedAt);
    return 'ok';
  }

  list(account: string): AccountDesktop[] {
    return this.db
      .prepare(
        `
      SELECT host, name FROM desktop_enrollments WHERE account=? AND revoked IS NULL ORDER BY issued DESC
    `,
      )
      .all(account)
      .map(({ host, name }) => ({ hostId: String(host), name: String(name) }));
  }

  ownsRequest(account: string, hostId: string, ticket: string): boolean {
    return !!this.db
      .prepare(
        `
      SELECT 1 FROM desktop_enrollments WHERE account=? AND host=? AND ticket=? AND revoked IS NULL
    `,
      )
      .get(account, hostId, ticket);
  }

  revoke(account: string, hostId: string): boolean {
    return !!this.db
      .prepare(
        `
      UPDATE desktop_enrollments SET revoked=MAX(COALESCE(revoked, 0), issued, ?)
      WHERE account=? AND host=?
    `,
      )
      .run(Date.now(), account, hostId).changes;
  }

  rename(account: string, hostId: string, name: string): boolean {
    return !!this.db
      .prepare('UPDATE desktop_enrollments SET name=? WHERE account=? AND host=? AND revoked IS NULL')
      .run(name, account, hostId).changes;
  }

  listAll(): AdminDesktopEnrollment[] {
    return this.db
      .prepare(
        `
      SELECT host, account, name, issued, revoked FROM desktop_enrollments
      ORDER BY (revoked IS NOT NULL) ASC, issued DESC LIMIT 500
    `,
      )
      .all()
      .map((row) => ({
        hostId: String(row.host),
        accountId: String(row.account),
        name: String(row.name),
        issuedAt: Number(row.issued),
        revokedAt: row.revoked == null ? null : Number(row.revoked),
      }));
  }

  revokeAny(hostId: string): boolean {
    return !!this.db
      .prepare(
        `
      UPDATE desktop_enrollments SET revoked=MAX(COALESCE(revoked, 0), issued, ?)
      WHERE host=? AND revoked IS NULL
    `,
      )
      .run(Date.now(), hostId).changes;
  }

  migrateAccount(fromAccount: string, toAccount: string): number {
    return Number(
      this.db
        .prepare('UPDATE desktop_enrollments SET account=? WHERE account=?')
        .run(toAccount, fromAccount).changes ?? 0,
    );
  }
}
