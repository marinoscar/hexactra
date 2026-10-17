# Hexactra v1 Release Checklist

## Pre-Release Verification

### Code Quality
- [ ] All Rust code compiles without errors
- [ ] All TypeScript code compiles without errors
- [ ] No clippy warnings (or all documented)
- [ ] No unreachable code or dead functions (or all documented)
- [ ] All tests pass

### Security
- [ ] No hardcoded API keys or secrets
- [ ] No debug logging in production builds
- [ ] All sensitive data is redacted before storage
- [ ] Audit logging is enabled
- [ ] Secrets have short TTL (15 minutes default)

### Documentation
- [ ] Installation guide complete
- [ ] Operations guide complete
- [ ] API documentation complete
- [ ] Security guide complete
- [ ] Recovery guide complete

## Release Artifacts

### Rust Binaries
- [ ] `hexactra` CLI binary built
- [ ] `hexactra-agent` daemon binary built
- [ ] `hexactra-native-host` native messaging host built
- [ ] `hexactra-mcp` MCP server binary built
- [ ] SHA256 checksums generated
- [ ] MD5 checksums generated

### Chrome Extension
- [ ] MV3 extension built
- [ ] Manifest validated
- [ ] Icons included
- [ ] TypeScript compiled

### JavaScript SDK
- [ ] `@hexactra/sdk` package built
- [ ] Type definitions generated
- [ ] Tests pass
- [ ] Package manifest generated

## Functional Testing

### Core Features
- [ ] Session management works
- [ ] Goal execution works
- [ ] Browser actions work (click, type, navigate)
- [ ] HITL flow works
- [ ] Viewer functionality works

### Integration
- [ ] Control plane API responds correctly
- [ ] MCP tools work
- [ ] Native messaging host connects
- [ ] Chrome extension loads

### Performance
- [ ] Binary size acceptable (< 5MB)
- [ ] Startup time < 1 second
- [ ] Memory usage < 2GB under load
- [ ] No memory leaks detected

## Release Process

### Version Bump
- [ ] Update Cargo.toml version
- [ ] Update package.json version
- [ ] Update manifest.json version
- [ ] Update CHANGELOG.md

### Build
- [ ] Clean build (`cargo clean && cargo build --release`)
- [ ] Build all artifacts
- [ ] Generate checksums

### Testing
- [ ] Run smoke tests
- [ ] Run E2E tests
- [ ] Manual testing complete

### Documentation
- [ ] Update README
- [ ] Update API docs
- [ ] Update installation guide
- [ ] Update operations guide

### Release
- [ ] Tag release in git
- [ ] Create GitHub release
- [ ] Upload release artifacts
- [ ] Publish npm package

## Post-Release

### Monitoring
- [ ] Health endpoint responds
- [ ] Logs are being collected
- [ ] Metrics are being scraped

### Communication
- [ ] Release notes published
- [ ] Announce to users
- [ ] Update documentation site

### Follow-ups
- [ ] Document known limitations
- [ ] Plan next release features
- [ ] Schedule security audit

## Known Limitations (v1)

### Not Implemented
- [ ] Windows support (planned for post-v1)
- [ ] macOS support (planned for post-v1)
- [ ] AEF integration (planned for post-v1)
- [ ] Vault provider (planned for post-v1)

### Experimental
- [ ] Fleet orchestration (experimental)
- [ ] Advanced HITL workflows (experimental)

## Sign-off

### Release Manager
- [ ] All checklist items complete
- [ ] Release artifacts verified
- [ ] Documentation complete
- [ ] Security review passed

### Technical Lead
- [ ] Code quality acceptable
- [ ] Architecture sound
- [ ] Performance acceptable

### Product Owner
- [ ] Feature set complete
- [ ] User documentation complete
- [ ] Release ready for public

## Release Checklist Template

```markdown
# Release v1.0.0 Checklist

## Pre-Release
- [ ] Code quality checks passed
- [ ] Security review completed
- [ ] Documentation complete

## Build & Test
- [ ] Rust binaries built
- [ ] Chrome extension built
- [ ] JS SDK built
- [ ] Smoke tests pass
- [ ] E2E tests pass

## Release
- [ ] Version bumped
- [ ] Release tagged
- [ ] Artifacts uploaded
- [ ] npm package published

## Post-Release
- [ ] Monitoring verified
- [ ] Documentation updated
- [ ] Announcement sent
```
