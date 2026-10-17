# Hexactra Security Guide

## Overview

This guide covers security considerations, best practices, and threat modeling for Hexactra.

## Security Principles

Hexactra follows these security principles:

1. **Defense in Depth**: Multiple layers of security controls
2. **Least Privilege**: Components run with minimum necessary permissions
3. **Fail Securely**: Default deny for all operations
4. **Audit Trail**: All sensitive operations are logged
5. **Data Minimization**: Only collect what's necessary

## Authentication and Authorization

### Token-Based Authentication

All API endpoints (except `/health`) require authentication:

```
Authorization: Bearer <token>
```

Tokens are issued by the identity provider and include scopes for granular access control.

### Scopes

- `sessions:read` - List and view sessions
- `sessions:write` - Create and manage sessions
- `goals:read` - View goals and status
- `goals:write` - Create and manage goals
- `interaction:read` - View HITL requests
- `interaction:write` - Approve/reject HITL requests

## Sensitive Data Handling

### Secrets Management

Secrets (passwords, API keys, OTPs) are handled with special care:

1. **Never logged**: Secrets are never included in logs or error messages
2. **In-memory only**: Secrets are stored in memory, never persisted
3. **Short TTL**: Secrets have short time-to-live (default: 15 minutes)
4. **One-time use**: Retrieved secrets are consumed and removed

### Data Redaction

All user data is redacted before storage:

```json
{
  "original": "password123",
  "redacted": "********"
}
```

## Threat Model

### Attack Vectors

| Attack Vector | Mitigation |
|--------------|------------|
| API key theft | Token rotation, short TTL |
| Man-in-the-middle | TLS 1.3 only |
| Privilege escalation | Non-root service user |
| Cross-site scripting | Content Security Policy |
| Native host abuse | Permission boundaries |

### Trusted Components

- **Control Plane**: Full trust, handles authentication
- **Agent**: Partial trust, executes browser actions
- **Chrome Extension**: Partial trust, user-facing interface
- **Worker**: Partial trust, manages sessions

## Security Best Practices

### Network Security

1. **Use TLS**: Always use HTTPS for API communication
2. **Firewall rules**: Restrict access to required ports only
3. **Network segmentation**: Isolate Hexactra from other services

### Configuration Security

1. **Environment variables**: Use for sensitive configuration
2. **File permissions**: Restrict config file access
3. **Secrets management**: Use external secrets manager in production

### Operational Security

1. **Regular updates**: Keep all components updated
2. **Audit logging**: Enable and monitor audit logs
3. **Access control**: Implement least privilege access

## Compliance

### Data Protection

Hexactra is designed to help with:

- **GDPR**: Data minimization, right to erasure
- **SOC 2**: Audit trails, access controls
- **HIPAA**: Encryption, access logging (with proper configuration)

### Audit Logging

All sensitive operations are logged:

```json
{
  "event": "session.created",
  "timestamp": "2024-10-17T10:30:00Z",
  "user_id": "user_123",
  "session_id": "sess_abc",
  "ip_address": "192.168.1.100"
}
```

## Security Checklist

### Pre-Deployment

- [ ] TLS configured for all endpoints
- [ ] API keys rotated and stored securely
- [ ] Firewall rules in place
- [ ] Audit logging enabled
- [ ] Access controls configured

### Post-Deployment

- [ ] Monitor logs for anomalies
- [ ] Regular security audits
- [ ] Key rotation schedule
- [ ] Incident response plan

## Agent Experience Framework Security

### Optional Integration

The AEF is **optional** and disabled by default:

- No AEF dependency for core functionality
- AEF failure does not impact Hexactra operation
- No credentials sent to AEF providers

### Data Protection

AEF-specific security controls:

1. **Consent required**: Opt-in before any export
2. **Sanitization**: All data sanitized before export
3. **Separate stores**: Experience and audit data isolated
4. **Time-limited retention**: Experience data auto-deleted

### Provider Conformance

AEF providers must:

- Support health check endpoints
- Handle authentication separately
- Not override Hexactra authorization rules
- Fail gracefully without breaking sessions

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue
2. Email security@hexactra.io with details
3. Wait for response before disclosure
4. Credit researchers appropriately

## Next Steps

- Review the [Operations Guide](./operations.md) for operational security
- Set up monitoring and alerting
- Implement regular security audits
- Train team on security best practices
