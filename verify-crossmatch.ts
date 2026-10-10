/**
 * Cross match reports.
 *
 * Exercised through the service rather than over HTTP: what matters here is
 * that the conclusion follows the two phases, that a report without a donor
 * is refused, and that the PDF actually renders — none of which needs a
 * network round trip to check.
 */
import { db } from './src/server/db/client'
import { sql } from 'drizzle-orm'
import {
  createCrossMatch, crossMatch, crossMatches, conclusionFor, CrossMatchError
} from './src/server/services/cross-match'
import { crossMatchPdf } from './src/server/services/cross-match-pdf'
import { writeFile } from 'node:fs/promises'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x = '') => {
  c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : '')))
}

console.log('\n— the conclusion follows the phases —')
ok('both compatible says compatible',
  conclusionFor('COMPATIBLE', 'COMPATIBLE') === 'CROSS MATCH IS COMPATIBLE WITH PATIENT BLOOD GROUP')
ok('either incompatible says NOT compatible',
  conclusionFor('INCOMPATIBLE', 'COMPATIBLE')
    === 'CROSS MATCH IS NOT COMPATIBLE WITH PATIENT BLOOD GROUP')
ok('and the other way round too',
  conclusionFor('COMPATIBLE', 'INCOMPATIBLE').includes('NOT COMPATIBLE'))
/*
 * A phase left blank gives no conclusion at all rather than a reassuring one.
 * "Compatible" printed under a test nobody ran is how somebody hangs the
 * wrong bag.
 */
ok('an unanswered phase gives no conclusion', conclusionFor('COMPATIBLE', '') === '')
ok('neither answered gives no conclusion', conclusionFor(null, null) === '')

console.log('\n— writing one —')
const patient = ((await db.execute<any>(sql`
  SELECT id, name FROM patients ORDER BY id DESC LIMIT 1`)).rows as any[])[0]
ok('there is a patient to report on', !!patient, JSON.stringify(patient))

const made = await createCrossMatch({
  patientId: patient.id,
  patientGroup: 'O', patientRh: 'POSITIVE',
  donorName: 'Uzair', donorAge: 26, donorSex: 'MALE',
  donorGroup: 'O', donorRh: 'POSITIVE', donorHb: '14.5', bloodBagNo: 'X97398Z1',
  directPhase: 'COMPATIBLE', albuminPhase: 'COMPATIBLE'
}, 'Lab Tech')

ok('it gets a report number', /^XM-\d{6}$/.test(made.report_no), made.report_no)
ok('the conclusion was worked out, not typed',
  made.conclusion === 'CROSS MATCH IS COMPATIBLE WITH PATIENT BLOOD GROUP', made.conclusion)
ok('the screening defaults to negative',
  [made.hbsag, made.anti_hcv, made.hiv, made.vdrl, made.mp].every((v) => v === 'NEGATIVE'))
ok('the blood bag number is kept', made.blood_bag_no === 'X97398Z1')
ok('and who wrote it', made.created_by === 'Lab Tech')

const second = await createCrossMatch({
  patientId: patient.id, donorName: 'Second Donor',
  directPhase: 'INCOMPATIBLE', albuminPhase: 'COMPATIBLE'
})
ok('an incompatible phase makes an incompatible report',
  second.conclusion.includes('NOT COMPATIBLE'), second.conclusion)
ok('report numbers do not repeat', second.report_no !== made.report_no)

console.log('\n— a report with no donor is refused —')
let refused = false
try { await createCrossMatch({ patientId: patient.id, donorName: '  ' }) }
catch (e) { refused = e instanceof CrossMatchError && e.code === 'NO_DONOR' }
ok('because a bag with no name against it cannot be traced', refused)

console.log('\n— reading it back —')
const read = await crossMatch(made.id)
ok('the patient is named', read.patient_name === patient.name, read.patient_name)
ok('the MRN comes with it', !!read.mrn)
ok('it appears in the list', (await crossMatches()).some((r: any) => r.id === made.id))
ok('and is findable by blood bag number',
  (await crossMatches({ q: 'X97398Z1' })).some((r: any) => r.id === made.id))
ok('and by donor name',
  (await crossMatches({ q: 'Uzair' })).some((r: any) => r.id === made.id))

console.log('\n— the printed report —')
const pdf = await crossMatchPdf(made.id)
ok('a PDF is produced', pdf.length > 1000, `${pdf.length} bytes`)
ok('it is a PDF', pdf.subarray(0, 4).toString() === '%PDF')
await writeFile('/mnt/user-data/outputs/sample-cross-match.pdf', pdf)

const badPdf = await crossMatchPdf(second.id)
ok('an incompatible one also prints', badPdf.length > 1000)
await writeFile('/mnt/user-data/outputs/sample-cross-match-incompatible.pdf', badPdf)

console.log('\n— the printed page carries the signatures —')
{
  /*
   * The signature row was drawn at a fixed height from the foot with no check
   * that the content had not already reached it, so a report with a long note
   * ran into it. Checked here on a deliberately long one, because that is the
   * report where it goes wrong and nobody writes short notes on the hard
   * cases.
   */
  const { execSync } = await import('node:child_process')
  const signers = await (await import('./src/server/services/lab')).signatories()

  const wordy = await createCrossMatch({
    patientId: patient.id, donorName: 'Long Note Donor',
    directPhase: 'COMPATIBLE', albuminPhase: 'COMPATIBLE',
    notes: 'Sample received haemolysed and redrawn at 09:10. '.repeat(14)
  })
  const long = await crossMatchPdf(wordy.id)
  await writeFile('/mnt/user-data/outputs/sample-cross-match-long.pdf', long)
  const text = execSync(
    'pdftotext -layout /mnt/user-data/outputs/sample-cross-match-long.pdf -',
    { encoding: 'utf8' })

  if (signers.length === 0) {
    console.log('  skip  no signatories configured in this database')
  } else {
    ok('every configured signatory is named on a long report',
      signers.every((s: any) => text.toUpperCase().includes(String(s.name).toUpperCase())),
      signers.map((s: any) => s.name).join(', '))
    ok('and their registration numbers come with them',
      signers.filter((s: any) => s.registration)
        .every((s: any) => text.includes(s.registration)))
  }
  ok('the no-signature-required line is there',
    /ELECTRONICALLY VERIFIED/.test(text))

  /*
   * The conclusion is the one sentence a ward sister reads. Centred, because
   * on a page whose every other line starts at the margin, a left-aligned one
   * reads as another label.
   */
  const line = text.split('\n').find((l) => l.includes('CROSS MATCH IS')) ?? ''
  ok('the conclusion is centred, not against the margin',
    (line.length - line.trimStart().length) > 10,
    `${line.length - line.trimStart().length} spaces in`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
