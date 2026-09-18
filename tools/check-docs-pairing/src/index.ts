/**
 * Verify that every document has its Chinese counterpart.
 *
 * The repository keeps English documents canonical and one `README_CN.md` beside each `README.md`.
 * A missing counterpart is silent by nature — a reader of the Chinese file sees stale text, and a
 * reader of the English one never notices the gap — so this check fails loudly in the pre-commit
 * hook and in `make check`.
 *
 * Structure is compared as well as presence: a counterpart that lost a section in translation is a
 * translation error a hash could not catch. The comparison is the heading _level sequence_, not a
 * count: two documents with the same number of `#` lines can still have lost a section and gained a
 * sub-heading, and a count cannot tell those apart.
 *
 * Headings are read outside fenced code blocks only. A shell sample is full of lines that start
 * with `#`, and counting them let a document pass on comments it happened to have rather than on
 * the sections it actually declared.
 */

import { Glob } from 'bun'

const SKIP_DIRECTORIES = ['node_modules/', 'tools/']

/** Drop fenced code blocks from a document: a `#` line inside one is sample text, not a heading. */
function withoutFences(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null) {
      if (marker !== undefined) {
        fence = marker.charAt(0)
        continue
      }
      kept.push(line)
      continue
    }
    if (marker !== undefined && marker.charAt(0) === fence) fence = null
  }
  return kept.join('\n')
}

/**
 * Heading levels of a document, in order.
 *
 * @param text - Raw Markdown.
 * @returns One number per heading, its `#` count.
 */
function headingLevels(text: string): number[] {
  return withoutFences(text)
    .split('\n')
    .map((line) => /^(#{1,6}) /.exec(line)?.[1]?.length)
    .filter((level): level is number => level !== undefined)
}

/** Whether a document links to its counterpart. */
function linksTo(text: string, counterpart: string): boolean {
  return text.includes(`](${counterpart})`)
}

const problems: string[] = []
let checked = 0

for await (const path of new Glob('**/README.md').scan('.')) {
  const normalized = path.replaceAll('\\', '/')
  if (SKIP_DIRECTORIES.some((prefix) => normalized.startsWith(prefix))) continue
  checked += 1
  const counterpartPath = normalized.replace(/README\.md$/, 'README_CN.md')
  const english = Bun.file(normalized)
  const chinese = Bun.file(counterpartPath)
  if (!(await chinese.exists())) {
    problems.push(`${normalized}: missing ${counterpartPath}`)
    continue
  }
  const englishText = await english.text()
  const chineseText = await chinese.text()
  const englishHeadings = headingLevels(englishText)
  const chineseHeadings = headingLevels(chineseText)
  // Both directions, because the switcher is the only path between the two files
  // and a lost one is invisible to whoever reads the other language.
  if (!linksTo(englishText, counterpartPath.split('/').pop() ?? 'README_CN.md')) {
    problems.push(`${normalized}: missing the "[中文](README_CN.md)" link`)
  }
  if (!linksTo(chineseText, 'README.md')) {
    problems.push(`${counterpartPath}: missing the "[English](README.md)" backlink`)
  }
  if (englishHeadings.join(',') !== chineseHeadings.join(',')) {
    problems.push(
      `${counterpartPath}: headings [${chineseHeadings.join(', ')}] against [${englishHeadings.join(', ')}] in ${normalized}`,
    )
  }
}

if (problems.length > 0) {
  console.error('docs pairing failed:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`docs pairing: ${checked} document(s) paired`)
