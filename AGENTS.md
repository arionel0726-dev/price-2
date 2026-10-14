# AGENTS.md

## Project Overview

This project is an engineering-first competitor price monitoring SaaS.

The long-term goal is to let an e-commerce business enter its own website and
competitor websites. The system should automatically discover products, extract
product data, match identical products across stores, track prices, and detect
new products.

The first pilot uses Vizaje-Nica and one competitor, with approximately 100–200
reference products.

The supplied CSV is only a temporary validation fixture. The final product must
NOT depend on CSV uploads, 1C, or manual product URL entry.

## Development Priorities

Build the data engine before the SaaS interface.

Priority order:

1. Product discovery
2. Product data extraction
3. Data normalization
4. Product matching
5. Catalog synchronization
6. Price monitoring
7. Background job processing
8. Internal diagnostics and API
9. Dashboard
10. Authentication, billing, landing page

Do not implement lower-priority features unless explicitly requested.

## Tech Stack

- Next.js 16, App Router
- TypeScript, strict mode
- Bun
- PostgreSQL 17
- Drizzle ORM and Drizzle Kit
- Zod
- Cheerio
- fast-xml-parser
- p-limit
- tsx for background workers
- Docker Compose for local infrastructure
- Bun test for testing

Use the existing project configuration where possible.

Do not introduce Redis, Kafka, microservices, paid AI APIs, or additional
infrastructure without a demonstrated need.

## Architecture

Use a modular monolith.

Next.js handles HTTP APIs, orchestration, and eventually the dashboard.

A separate background worker process handles long-running discovery, scraping,
matching, and monitoring jobs.

Both processes share the same database and business logic.

Never perform large catalog scans inside an HTTP request.

Keep modules separated by responsibility:

- catalog: product storage and synchronization
- discovery: finding product URLs
- scraping: fetching and extracting product data
- matching: identifying equivalent products
- monitoring: tracking prices and availability
- jobs: durable background processing

Site-specific extraction logic belongs in adapters.

Core matching and monitoring logic must remain site-independent.

## Data Model Principles

Design for multiple customers and multiple stores, even if the pilot uses only
one customer.

A store has a role within a monitoring configuration: owned store or competitor.

Keep separate concepts for:

- Stores
- Categories and brands
- Store-specific product listings
- Normalized product identities
- Product match candidates
- Confirmed product matches
- Price observations
- Discovery and monitoring jobs
- Scan runs and errors

Do not assume that a product title is unique.

Preserve original extracted values alongside normalized values.

Use stable IDs, unique constraints, indexes, and idempotent upserts.

Do not delete price history when a product changes or disappears.

Do not assume that a missing product is out of stock.

## Product Discovery

Use the following approaches when supported:

1. XML sitemaps
2. Structured product data
3. Category pagination
4. Product links extracted from HTML
5. Site-specific adapters

Use browser automation only when necessary.

Do not claim that every website can be scanned automatically.

Track discovery coverage and failures.

Support full discovery and incremental discovery.

Newly discovered listings must not create duplicates.

## Scraping Rules

Use bounded concurrency, request timeouts, retries with backoff, and per-domain
rate limits.

Respect applicable access restrictions and website terms.

Do not bypass authentication, CAPTCHAs, or anti-bot protections.

Never treat failed requests as proof that a product disappeared.

Validate extracted data using Zod.

Record extraction failures with useful diagnostic information.

Avoid collecting personal data.

## Product Matching

Matching must prioritize precision over coverage.

Prefer:

1. Exact GTIN/EAN/UPC when available
2. Reliable manufacturer identifiers
3. Brand and product attributes
4. Normalized title similarity

Consider size, volume, concentration, variant, packaging, and bundle
differences.

Use candidate generation before expensive comparisons.

Store match confidence and supporting evidence.

Low-confidence matches must require review.

Do not automatically confirm ambiguous matches.

Matching logic must be testable without network access.

## Price Monitoring

Keep price observations separate from product listings.

Store price, currency, availability, source URL, and observation time.

Never silently compare prices in different currencies.

Support targeted scans by store, brand, category, and selected products.

Support rechecking unmatched products and detecting newly discovered listings.

Avoid duplicate observations where appropriate, but preserve meaningful history.

## Jobs and Reliability

Use durable PostgreSQL-backed jobs for the MVP.

Workers must support:

- Atomic job claiming
- Retries and backoff
- Lease expiration and recovery
- Idempotent processing
- Progress tracking
- Failure reporting
- Graceful shutdown

A worker crash must not permanently lose a job.

## Testing

Write tests for critical business logic.

Prioritize:

- Product normalization
- Product matching
- Variant mismatch detection
- Duplicate prevention
- Catalog synchronization
- Price comparison
- Job retry and recovery

Use deterministic HTML and CSV fixtures.

Do not depend on live websites in unit tests.

Live integration tests must be separate and explicitly invoked.

## Security

Treat external URLs and HTML as untrusted input.

Protect against SSRF, including redirects and DNS resolution to private or
internal networks.

Restrict supported URL schemes to HTTP and HTTPS.

Set request limits and maximum response sizes.

Never log secrets or credentials.

Never commit .env files.

Do not execute code extracted from external pages.

## Agent Workflow

Before implementation:

1. Inspect existing code and configuration.
2. Explain the intended changes briefly.
3. Reuse existing dependencies and conventions.
4. Avoid unrelated refactoring.

During implementation:

1. Keep modules small and focused.
2. Use strict TypeScript.
3. Validate external inputs.
4. Handle errors explicitly.
5. Add tests for nontrivial logic.
6. Avoid speculative abstractions.

After implementation:

1. Run relevant tests.
2. Run TypeScript checks.
3. Run linting.
4. Report changed files.
5. Report test results and limitations.
6. Explain how to verify the feature.

Never claim successful testing unless tests actually ran.

Do not create authentication, billing, marketing pages, or elaborate UI unless
requested.

## MVP Success Criteria

The pilot should demonstrate that the system can:

1. Discover selected products on the owned store.
2. Extract product data.
3. Find corresponding competitor listings.
4. Distinguish exact matches from different variants.
5. Compare prices accurately.
6. Repeat scans without duplicating records.
7. Detect new listings.
8. Report unmatched and failed products.

The CSV fixture is used to measure discovery and matching quality, not as a
permanent production data source.
