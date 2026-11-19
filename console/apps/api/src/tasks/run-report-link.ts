// The signed link to a run's masked PDF report (E39.6, #603): what a webhook delivery carries as `reportUrl` and an email offers when
// its attachment was too large. `GET /api/reports/{token}` (run-report-link.controller.ts) streams the PDF with no session.
//
// The token names ONE run of ONE user and expires after 7 days. It grants the masked PDF of that run and nothing else: no list, no
// other file, no other run. A deleted run makes the link answer 404.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { REPORT_LINK_TTL_S } from '../deliveries/deliveries.constants';
import { signToken, verifyToken } from './signed-token';

export const REPORT_LINK_KIND = 'report';

export interface ReportLinkClaims {
  userId: string;
  runId: string;
  exp: number;
}

@Injectable()
export class RunReportLinks {
  constructor(private readonly config: ConfigService) {}

  issue(userId: string, runId: string, ttlS = REPORT_LINK_TTL_S, now = Date.now()): string {
    return signToken(REPORT_LINK_KIND, { u: userId, r: runId }, ttlS, now);
  }

  verify(token: string, now = Date.now()): ReportLinkClaims | null {
    const c = verifyToken(REPORT_LINK_KIND, token, now);
    if (!c || typeof c.u !== 'string' || typeof c.r !== 'string') return null;
    return { userId: c.u, runId: c.r, exp: c.exp };
  }

  /** The absolute link a recipient opens. */
  url(userId: string, runId: string, ttlS?: number): string {
    return `${(this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '')}/api/reports/${this.issue(userId, runId, ttlS)}`;
  }

  /** An absolute link to a page of the console. */
  pageUrl(path: string): string {
    return `${(this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '')}${path}`;
  }
}
