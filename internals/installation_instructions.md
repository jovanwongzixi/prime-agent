Use the current standalone release pipeline: TypeScript → JavaScript → Bun standalone executable → tar.gz with runtime assets.

The release workflow (.github/workflows/standalone-binaries.yml) uses Node 22 and Bun exactly 1.4.0. The offline installer’s “Rust-based” comments are misleading.

Run these commands from your checkout:

cd /home/jovan/prime-agent

# Requires Node >=22.8 and Bun exactly 1.4.0.
npm ci

# Generate the real bundled model and MCP catalogs.
npm run catalog:assets -- --catalog-dir /path/to/prime-agent-catalog

# Compile your current sources, including uncommitted modifications.
npm run build:binary --workspace packages/coding-agent -- --platform linux-x64

# Run repository checks.
npm run check

# Package into a separate directory, preserving your original archive.
version=$(node -p "require('./package.json').version")
node scripts/assemble-release-archives.mjs \
  packages/coding-agent/binaries \
  internals/rebuilt \
  "$version"

If you have no catalog checkout, replace the catalog command with npm run catalog:assets, using GITHUB_TOKEN or PRIME_CATALOG_REPO_TOKEN if access requires authentication.

The resulting archive will be:

internals/rebuilt/prime-agent-0.9.8-linux-x64.tar.gz

The assembler also writes SHA256SUMS and binaries.json. It packages every platform directory currently present under packages/coding-agent/binaries.

Install it using your existing script:

bash internals/install-prime-agent-offline.sh \
  internals/rebuilt/prime-agent-0.9.8-linux-x64.tar.gz

Compatibility comes from the archive layout: prime-agent, prime-agent-runtime/pyproject.toml, skills/, and support assets sit directly at the archive root. The build script (packages/coding-agent/scripts/build-binary.mjs) copies those assets, and the archive assembler (scripts/assemble-release-archives.mjs) preserves the required layout. The current CLI also supports the installer’s --prime-agent-bootstrap check.

Two constraints apply:

- linux-x64 targets glibc Linux with AVX2. Your offline installer only accepts the linux-x64 and linux-arm64 filename suffixes.
- The installer still installs Python dependencies through uv/pip. An offline machine needs an accessible internal Python mirror or a prepared local package source.

Avoid scripts/build-binaries.sh: it is an older pipeline producing pi archives with a different layout.
