/**
 * Publish the packages whose current version is not on the registry yet.
 *
 * `npm publish` refuses a version that already exists, so a repository that publishes several
 * packages needs to answer "which of these actually changed?" before it starts. The registry is the
 * authority on that question, and the version in `package.json` is the answer's unit: a package
 * earns a publish by being bumped, and an untouched one is skipped rather than failing the run
 * half-way through.
 *
 * The collection package is the repository root and the individual extensions live under
 * `packages/`, mirroring how pi discovers them. Publishing runs the full `make check` gate first,
 * because a package that is on npm cannot be quietly replaced.
 *
 * Usage:
 *
 *     bun tools/publish-changed/src/index.ts [--only <name>] [--dry-run] [--skip-check]
 */

import { dirname } from 'node:path'

import { Glob } from 'bun'

interface Candidate {
  dir: string
  name: string
  version: string
}

interface Judgement {
  candidate: Candidate
  published: boolean
}

/** Narrows parsed JSON without asserting a shape onto it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `--flag value` and `--flag=value` alike. */
function optionValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * Every directory this repository publishes from.
 *
 * The extensions come first so that by the time the collection is published the versions it ships
 * are already on the registry. `.` is the collection itself.
 */
async function discover(): Promise<string[]> {
  const extensions: string[] = []
  for await (const path of new Glob('packages/*/package.json').scan('.')) {
    extensions.push(dirname(path))
  }
  return [...extensions.toSorted(), '.']
}

async function readCandidate(dir: string): Promise<Candidate | null> {
  const manifest: unknown = await Bun.file(`${dir}/package.json`).json()
  if (!isRecord(manifest)) return null
  // `private: true` is how the repository says "this exists only in the working tree".
  if (manifest.private === true) return null
  const { name, version } = manifest
  if (typeof name !== 'string' || typeof version !== 'string') return null
  return { dir, name, version }
}

/**
 * Whether the registry already holds this exact version.
 *
 * A missing package and a missing version are the same answer, and they are both "publish it": the
 * first release of a new package looks exactly like a bump of an existing one from here.
 */
async function isPublished(name: string, version: string): Promise<boolean> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}`)
  const document: unknown = await response.json()
  if (!isRecord(document) || !isRecord(document.versions)) return false
  return version in document.versions
}

async function publish(candidate: Candidate, dryRun: boolean): Promise<void> {
  const args = ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])]
  const child = Bun.spawn(['npm', ...args], {
    cwd: candidate.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`npm publish exited ${exitCode} for ${candidate.name}@${candidate.version}`)
  }
}

const argv = Bun.argv.slice(2)
const only = optionValue(argv, '--only')
const dryRun = argv.includes('--dry-run')
const skipCheck = argv.includes('--skip-check')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'usage: bun tools/publish-changed/src/index.ts [--only <name>] [--dry-run] [--skip-check]',
  )
  process.exit(0)
}

const discovered = await discover()
const read = await Promise.all(discovered.map((dir) => readCandidate(dir)))
const candidates = read.filter((candidate): candidate is Candidate => candidate !== null)

const selected =
  only === undefined ? candidates : candidates.filter((candidate) => candidate.name === only)
if (selected.length === 0) {
  const known = candidates.map((candidate) => candidate.name).join(', ')
  console.error(`publish: no package matched --only ${String(only)}. Known packages: ${known}`)
  process.exit(1)
}

if (!skipCheck) {
  console.log('publish: running the full check gate first\n')
  const gate = Bun.spawn(['bun', 'run', 'check'], { stdout: 'inherit', stderr: 'inherit' })
  if ((await gate.exited) !== 0) {
    console.error('\npublish: `bun run check` failed, nothing was published')
    process.exit(1)
  }
  console.log('')
}

const judgements: Judgement[] = await Promise.all(
  selected.map(async (candidate) => ({
    candidate,
    published: await isPublished(candidate.name, candidate.version),
  })),
)

for (const { candidate, published } of judgements) {
  const verdict = published ? 'up to date, skipped' : dryRun ? 'would publish' : 'publishing'
  console.log(`  ${`${candidate.name}@${candidate.version}`.padEnd(38)} ${verdict}`)
}
console.log('')

const pending = judgements.filter((judgement) => !judgement.published)
if (pending.length === 0) {
  console.log('publish: nothing to do, every version is already on the registry')
  process.exit(0)
}

// Chained rather than awaited per iteration: the registry is a serial conversation, and a failure
// should stop the ones behind it instead of racing them.
let chain = Promise.resolve()
for (const { candidate } of pending) {
  chain = chain.then(() => publish(candidate, dryRun))
}
await chain

const indexNote = dryRun ? '' : '\nhttps://pi.dev/packages indexes them within minutes'
console.log(
  `\npublish: ${dryRun ? 'checked' : 'published'} ${pending.length} package(s)${indexNote}`,
)
