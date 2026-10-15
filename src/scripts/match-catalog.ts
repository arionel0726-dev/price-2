#!/usr/bin/env bun
/**
 * CLI for exercising and evaluating the product matching engine.
 *
 * Offline (default): loads a labeled synthetic fixture, runs the matching
 * engine, and prints precision/recall-style evaluation metrics plus
 * example auto_match / needs_review / reject decisions. No network or
 * database access.
 *
 * Database-backed (opt-in only): `--db --own-store-id <id> --competitor-store-id <id>`
 * runs matching against real persisted store_listings for two explicit
 * stores and persists the results via the matching service. Both store ids
 * are required — there is no "match everything" mode.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { closeDb, getDb } from '../db'
import { evaluateFixture, type MatchingFixture } from '../lib/matching/evaluate'
import { evaluateStorePair } from '../lib/matching/service'
import { DEFAULT_MATCHING_OPTIONS, type MatchResult } from '../lib/matching/types'

const DEFAULT_FIXTURE_PATH = 'tests/fixtures/matching/perfume-cosmetics.json'

interface CliArgs {
	mode: 'offline' | 'db'
	fixturePath: string
	outPath?: string
	json: boolean
	ownStoreId?: string
	competitorStoreId?: string
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { mode: 'offline', fixturePath: DEFAULT_FIXTURE_PATH, json: false }

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case '--db':
				args.mode = 'db'
				break
			case '--fixture':
				args.fixturePath = argv[++i]
				break
			case '--out':
				args.outPath = argv[++i]
				break
			case '--json':
				args.json = true
				break
			case '--own-store-id':
				args.ownStoreId = argv[++i]
				break
			case '--competitor-store-id':
				args.competitorStoreId = argv[++i]
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	if (args.mode === 'db' && (!args.ownStoreId || !args.competitorStoreId)) {
		throw new Error('--db requires both --own-store-id and --competitor-store-id')
	}

	return args
}

function printExamples(label: string, results: MatchResult[], decision: MatchResult['decision'], limit = 3): void {
	const examples = results.filter((r) => r.decision === decision).slice(0, limit)
	console.log(`\n${label} (showing up to ${limit} of ${results.filter((r) => r.decision === decision).length}):`)
	if (examples.length === 0) {
		console.log('  (none)')
		return
	}
	for (const r of examples) {
		console.log(
			`  ${r.sourceListingId} <-> ${r.candidateListingId}  score=${r.score}  ` +
				`positives=[${r.positiveSignals.map((s) => s.code).join(', ')}]  ` +
				`conflicts=[${r.conflictingSignals.map((s) => s.code).join(', ')}]  ` +
				`missing=[${r.missingAttributes.join(', ')}]`
		)
	}
}

async function runOffline(args: CliArgs): Promise<void> {
	const fixture = JSON.parse(readFileSync(resolve(args.fixturePath), 'utf-8')) as MatchingFixture
	const report = evaluateFixture(fixture, DEFAULT_MATCHING_OPTIONS)

	if (args.json) {
		const json = JSON.stringify(report, null, 2)
		if (args.outPath) writeFileSync(resolve(args.outPath), json, 'utf-8')
		else console.log(json)
		return
	}

	console.log(`Fixture: ${args.fixturePath}`)
	console.log(fixture.description)
	console.log(`\nDataset size: ${fixture.ownListings.length} own listings, ${fixture.competitorListings.length} competitor listings, ${fixture.groundTruth.length} labeled ground-truth pairs`)
	console.log('\n=== Evaluation metrics (synthetic data only — see delivery notes for limitations) ===')
	console.log(report.metrics)

	printExamples('Auto-match examples', report.allResults, 'auto_match')
	printExamples('Needs-review examples', report.allResults, 'needs_review')
	printExamples('Rejected examples', report.allResults, 'reject')

	if (args.outPath) {
		writeFileSync(resolve(args.outPath), JSON.stringify(report, null, 2), 'utf-8')
		console.log(`\nFull report written to ${args.outPath}`)
	}
}

async function runDb(args: CliArgs): Promise<void> {
	const db = getDb()
	const summary = await evaluateStorePair(db, args.ownStoreId!, args.competitorStoreId!)
	console.log(JSON.stringify({ ownStoreId: args.ownStoreId, competitorStoreId: args.competitorStoreId, summary }, null, 2))
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv)
	if (args.mode === 'db') await runDb(args)
	else await runOffline(args)
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : err)
			process.exitCode = 1
		})
		.finally(() => closeDb())
}
