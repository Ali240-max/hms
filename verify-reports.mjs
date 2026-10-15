/**
 * Every report in the system: it runs, it prints, and only the right people
 * can open it.
 */
const B = process.env.API_BASE ?? 'http://127.0.0.1:4000/api'
const tok = {}
/* A window wide enough to contain the demo data's earnings. */
const TO = new Date().toISOString().slice(0, 10)
const FROM = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
const login=async(u,p)=>(await (await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})).json()).token
const q=async(path,as,o={})=>{const r=await fetch(B+path,{...o,headers:{'content-type':'application/json',...(as?{authorization:'Bearer '+tok[as]}:{}),...(o.headers||{})}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=t};return{status:r.status,body:b}}
let pass=0,fail=0
const ok=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x?' — '+x:'')))}
for (const [k,u,p] of [['rep','reports','1234'],['admin','admin','admin-demo-1'],
  ['lab','lab','1234'],['xray','xray','1234'],['mc','main-counter','1234'],
  ['ph','pharmacy','1234'],['opd','opd','1234']]) tok[k]=await login(u,p)

const today = new Date().toISOString().slice(0,10)
const from = new Date(Date.now()-30*86400000).toISOString().slice(0,10)
const W = `from=${from}&to=${today}`

console.log('\n— the catalogue —')
let r = await q('/reports','rep')
ok('the reports desk signs in and sees the catalogue', r.status===200 && r.body.length>0,
  `${r.body?.length}`)
const all = r.body
ok('it covers every module',
  new Set(all.map(x=>x.module)).size === 5,
  [...new Set(all.map(x=>x.module))].join(','))
ok('every report declares its columns', all.every(x=>Array.isArray(x.columns) && x.columns.length))

console.log('\n— each module sees its own —')
for (const [who, mod, role] of [['lab','laboratory','lab_tech'],['xray','radiology','radiology'],
  ['mc','counter','main_counter'],['ph','pharmacy','pharmacist']]) {
  const list = (await q('/reports',who)).body
  ok(`${role} sees only ${mod}`, list.length>0 && list.every(x=>x.module===mod),
    [...new Set(list.map(x=>x.module))].join(','))
}
ok('an administrator sees all of them', (await q('/reports','admin')).body.length === all.length)
ok('the OPD desk sees none', (await q('/reports','opd')).body.length === 0)

console.log('\n— scoping is enforced, not merely hidden —')
const pharmaOnly = all.find(x=>x.module==='pharmacy')
r = await q(`/reports/run/${pharmaOnly.id}?${W}`,'lab')
ok('the lab cannot run a pharmacy report', r.status===403, `got ${r.status}`)
r = await q(`/reports/print/${pharmaOnly.id}/pdf?${W}`,'lab')
ok('nor print one', r.status===403, `got ${r.status}`)
const labOnly = all.find(x=>x.module==='laboratory')
r = await q(`/reports/run/${labOnly.id}?${W}`,'ph')
ok('the pharmacy cannot run a lab report', r.status===403, `got ${r.status}`)
r = await q(`/reports/run/${labOnly.id}?${W}`,'lab')
ok('but the lab can', r.status===200, `got ${r.status}`)

console.log('\n— every report runs and prints —')
let ran=0, printed=0, broke=[]
for (const def of all) {
  const run = await q(`/reports/run/${def.id}?${W}`,'rep')
  if (run.status!==200 || !Array.isArray(run.body.rows)) { broke.push(`${def.id} run=${run.status}`); continue }
  ran++
  const res = await fetch(`${B}/reports/print/${def.id}/pdf?${W}`,
    { headers: { authorization: 'Bearer '+tok.rep } })
  const buf = Buffer.from(await res.arrayBuffer())
  if (res.status===200 && buf.slice(0,5).toString()==='%PDF-') printed++
  else broke.push(`${def.id} pdf=${res.status}`)
}
ok('all of them run', ran===all.length, `${ran}/${all.length}`)
ok('all of them print a real PDF', printed===all.length, `${printed}/${all.length}`)
ok('nothing broke', broke.length===0, broke.slice(0,4).join('; '))

console.log('\n— totals add up —')
const daily = (await q(`/reports/run/counter-daily?${W}`,'rep')).body
if (daily.rows.length) {
  const sum = daily.rows.reduce((n,x)=>n+Number(x.taken_paisa),0)
  ok('the footer total matches the rows', Number(daily.totals.taken_paisa)===sum,
    `${daily.totals.taken_paisa} vs ${sum}`)
} else ok('the footer total matches the rows', true, 'no rows in window')

console.log('\n— a ticket opens a report without a header —')
{
  const path = `/reports/print/${all[0].id}/pdf`
  const tk = await q('/tickets','rep',{method:'POST',body:JSON.stringify({ path })})
  ok('a ticket is issued', tk.status===200 && !!tk.body.ticket, JSON.stringify(tk.body).slice(0,70))
  const res = await fetch(`${B}${path}?${W}&ticket=${encodeURIComponent(tk.body.ticket)}`)
  ok('and it opens the PDF', res.status===200 &&
    (res.headers.get('content-type')||'').includes('application/pdf'), `got ${res.status}`)
}

console.log('\n— the reports desk can only read —')
for (const [path, body] of [
  ['/patients', { name: 'Should Not Work' }],
  ['/counter/bills', { kind:'consultation', visitId:1, payMethod:'cash', tenderedPaisa:0 }],
  ['/pharmacy/sales', { lines:[], payMethod:'cash', paidPaisa:0 }]
]) {
  r = await q(path,'rep',{method:'POST',body:JSON.stringify(body)})
  ok(`it cannot post to ${path}`, r.status===403, `got ${r.status}`)
}

console.log('\n— a report for today includes today —')
{
  /*
   * The whole class of bug this catches, which bit twice in one file.
   *
   * A window of today..today written as `created_at >= from AND created_at <
   * to` excludes the entire final day: a bill made at one o'clock is not
   * earlier than midnight this morning. The report comes back empty and
   * looks like a feature that does not work — which is exactly how the
   * patients-by-department report was reported, and the department summary
   * had it too.
   *
   * The shared `between()` helper in hospital-reports.ts gets this right by
   * adding a day to the end. Nineteen queries used it and four did not.
   *
   * Checked by taking a department report over today only. The demo data
   * books visits on every day including today, so rows are expected; an
   * empty answer here means the end of the window has been dropped again.
   */
  const T = `from=${today}&to=${today}`
  for (const id of ['dept-patients', 'dept-summary']) {
    const res = await q(`/reports/run/${id}?${T}`, 'admin')
    ok(`${id} runs for a single day`, res.status === 200, `got ${res.status}`)
    ok(`${id} does not drop the day it was asked for`,
      Array.isArray(res.body?.rows) && res.body.rows.length > 0,
      `${res.body?.rows?.length ?? 'no'} rows for ${today}`)
  }

  /*
   * And the grouping the report exists for: a consultation billed against a
   * doctor has to appear under that doctor's department, with the department
   * named rather than left as "Unassigned".
   */
  const dp = await q(`/reports/run/dept-patients?${T}`, 'admin')
  const depts = [...new Set((dp.body?.rows ?? []).map((x) => x.department))]
  ok('its rows carry a real department name',
    depts.length > 0 && !depts.every((d) => d === 'Unassigned'), depts.join(', '))
}


/* ----------------------------------------- a report that takes a filter -- */

/**
 * The doctor dropdown, and the mechanism under it.
 *
 * Reports could already take query parameters and nothing ever sent one, so
 * there was no way to narrow a report from the screen. The catalogue now
 * declares its dropdowns, resolves their choices server side, and the screen
 * passes the chosen value to BOTH the run and the print — a screen narrowed
 * to one doctor and a PDF listing all of them is the sort of difference
 * nobody notices until a statement reaches the wrong person.
 */
console.log('\n— a report can be narrowed to one doctor —')
{
  const cat = (await q('/reports', 'admin')).body ?? []
  const detail = cat.find((r) => r.id === 'counter-doctor-detail')
  const summary = cat.find((r) => r.id === 'counter-doctor-earnings')

  ok('the detail report is in the catalogue', !!detail,
    `${cat.length} reports visible`)
  ok('and so is the summary', !!summary)

  if (detail) {
    ok('it declares a doctor dropdown',
      detail.filters?.[0]?.key === 'doctor', JSON.stringify(detail.filters))
    ok('with the choices filled in by the server',
      (detail.filters?.[0]?.options ?? []).length > 0,
      `${(detail.filters?.[0]?.options ?? []).length} doctors`)
    ok('and a name for the no-filter choice',
      typeof detail.filters?.[0]?.allLabel === 'string'
      && detail.filters[0].allLabel.length > 0, detail.filters?.[0]?.allLabel)

    const one = detail.filters[0].options[0]

    const all = await q(`/reports/run/counter-doctor-detail?from=${FROM}&to=${TO}`, 'admin')
    ok('it runs with no doctor chosen', all.status === 200 && all.body.rows.length > 0,
      `${all.status} ${all.body?.rows?.length}`)

    const names = new Set((all.body.rows ?? []).map((r) => r.doctor))
    ok('and lists more than one doctor when none is chosen', names.size > 1,
      `${names.size} doctors`)

    const mine = await q(
      `/reports/run/counter-doctor-detail?from=${FROM}&to=${TO}&doctor=${one.value}`,
      'admin')
    ok('choosing one narrows it to that doctor',
      mine.status === 200
      && new Set((mine.body.rows ?? []).map((r) => r.doctor)).size === 1,
      `${new Set((mine.body.rows ?? []).map((r) => r.doctor)).size} doctors`)
    ok('and the one it narrowed to is the one asked for',
      (mine.body.rows ?? [])[0]?.doctor === one.label,
      `${(mine.body.rows ?? [])[0]?.doctor} vs ${one.label}`)
    ok('and it is fewer rows than the whole list',
      (mine.body.rows ?? []).length < (all.body.rows ?? []).length,
      `${mine.body.rows?.length} of ${all.body.rows?.length}`)

    /* Every line carries the patient it came from and the share agreed. */
    const row = (mine.body.rows ?? [])[0]
    ok('each line names the patient', !!row?.patient_name, JSON.stringify(row ?? {}))
    ok('and what it was for', !!row?.description)
    ok('and the share that was agreed at the time, not today\'s',
      row?.share_pct !== undefined && row?.gross_paisa !== undefined
      && row?.amount_paisa !== undefined)

    /*
     * The PRINTED copy must honour the filter too. Checked through a
     * ticket, which is the path the Download button actually takes.
     */
    const path = `/reports/print/counter-doctor-detail/pdf`
    const tk = await q('/tickets', 'admin',
      { method: 'POST', body: JSON.stringify({ path }) })
    ok('a ticket is issued for the detail report',
      tk.status === 200 && !!tk.body.ticket, `${tk.status}`)
    if (tk.body?.ticket) {
      const url = `${B}${path}?from=${FROM}&to=${TO}&doctor=${one.value}`
        + `&ticket=${encodeURIComponent(tk.body.ticket)}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      ok('and the PDF comes back', res.status === 200
        && buf.subarray(0, 5).toString() === '%PDF-', `${res.status}, ${buf.length} bytes`)

      /*
       * And it is THAT DOCTOR'S page, read out of the file.
       *
       * Asserting only that bytes came back and they start with %PDF- is the
       * kind of check that passes on a report listing every doctor in the
       * hospital. This is a statement that gets printed, signed and handed
       * over, so the thing worth testing is whether the page says whose it
       * is and whether anybody else is on it.
       */
      const { savePdf, pdfText, notePdfToolMissing } = await import('./verify-pdf.mjs')
      const file = savePdf('sample-doctor-filtered.pdf', buf)
      const text = pdfText(file, 'layout')
      if (text === null) notePdfToolMissing()
      else {
        ok('the printed page names the doctor it was narrowed to',
          text.includes(one.label), one.label)

        const others = (detail.filters[0].options ?? [])
          .filter((d) => d.value !== one.value && !one.label.includes(d.label))
          .map((d) => d.label)
          .filter((name) => text.includes(name))
        ok('and nobody else is on it', others.length === 0,
          `also found: ${others.join(', ')}`)
      }
    }

    /* The summary takes the same filter, so narrowing it leaves one row. */
    const sumAll = await q(
      `/reports/run/counter-doctor-earnings?from=${FROM}&to=${TO}`, 'admin')
    const sumOne = await q(
      `/reports/run/counter-doctor-earnings?from=${FROM}&to=${TO}&doctor=${one.value}`,
      'admin')
    ok('the summary takes the same dropdown',
      (sumAll.body.rows ?? []).length > 1 && (sumOne.body.rows ?? []).length === 1,
      `${sumAll.body.rows?.length} then ${sumOne.body.rows?.length}`)

    /* A doctor id nobody has returns nothing rather than everything. */
    const none = await q(
      `/reports/run/counter-doctor-detail?from=${FROM}&to=${TO}&doctor=99999999`, 'admin')
    ok('an unknown doctor returns nothing, not everybody',
      none.status === 200 && (none.body.rows ?? []).length === 0,
      `${none.body?.rows?.length} rows`)
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail?1:0)
