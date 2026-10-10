import { useCallback, useEffect, useState } from 'react'
import {
  Clock, UserCheck, UserX, Plus, Trash2, Fingerprint, Search, AlertTriangle
} from 'lucide-react'
import { api, type SessionUser } from '../../lib/api'
import {
  Badge, Card, Empty, ErrorNote, Field, Modal, SkeletonRows, Stat, Tabs, Th
} from '../../components/ui'
import { t as tr } from '../../lib/prefs'
import { EnrolFinger } from './Enrol'

/**
 * Attendance.
 *
 * A punch is a fact; arrived, left, late and absent are read off those facts
 * here. Nothing on this screen is stored, so correcting a shift or a punch
 * corrects every day it touches.
 */

const today = () => new Date().toISOString().slice(0, 10)

const clock = (iso: string | null) => iso
  ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  : '—'

const hours = (minutes: number | null) => minutes == null ? '—'
  : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`

export function Attendance({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState('day')
  return (
    <div className="space-y-4">
      <Tabs id="attendance-tabs" value={tab} onChange={setTab} className="w-fit"
        tabs={[
          { value: 'day', label: tr('The day'), icon: Clock },
          { value: 'person', label: tr('One person'), icon: UserCheck },
          { value: 'fingers', label: tr('Fingerprints'), icon: UserCheck },
          { value: 'readers', label: tr('Readers'), icon: Fingerprint }
        ]} />
      {tab === 'day' ? <DayView me={me} />
        : tab === 'person' ? <PersonView />
        : tab === 'fingers' ? <Fingers />
        : <Readers />}
    </div>
  )
}

/* ------------------------------------------------------------- the day */

function DayView({ me }: { me: SessionUser }) {
  const [date, setDate] = useState(today())
  const [rows, setRows] = useState<any[] | null>(null)
  const [adding, setAdding] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.attendanceDay(date).then(setRows).catch((e: any) => setErr(e.message))
  }, [date])
  useEffect(() => { load() }, [load])

  const list = rows ?? []
  const expected = list.filter((r) => r.attendance_required)
  const inNow = list.filter((r) => r.status === 'in').length
  const left = list.filter((r) => r.status === 'left').length
  const absent = expected.filter((r) => r.status === 'absent').length
  const late = expected.filter((r) => (r.late_minutes ?? 0) > 0).length

  async function removePunch(id: number) {
    try { await api.deleteAttendancePunch(id); load() }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <Card title={tr('Attendance')}
      hint={tr('The first scan of a day is the arrival and the last is the leaving.')}
      action={
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="field num w-auto py-1.5 text-2xs" />
      }>
      <ErrorNote>{err}</ErrorNote>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label={tr('In the building')} value={String(inNow)} tone="ok" count={inNow} />
        <Stat label={tr('Left')} value={String(left)} />
        <Stat label={tr('Late')} value={String(late)} tone={late ? 'warn' : undefined} />
        <Stat label={tr('Absent')} value={String(absent)} tone={absent ? 'bad' : undefined} />
      </div>

      {!rows ? <SkeletonRows rows={8} cols={5} />
        : list.length === 0 ? <Empty title={tr('No staff yet')} /> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="thead-strip">
              <tr>
                <Th>{tr('Name')}</Th><Th w="w-28">{tr('Shift')}</Th>
                <Th w="w-20">{tr('In')}</Th><Th w="w-20">{tr('Out')}</Th>
                <Th w="w-24" right>{tr('On site')}</Th>
                <Th w="w-28">{tr('Status')}</Th><Th w="w-28" right />
              </tr>
            </thead>
            <tbody className="divide-y divide-divide rows-striped">
              {list.map((r) => (
                <tr key={r.staff_id} className={r.status === 'exempt' ? 'opacity-50' : ''}>
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{r.display_name}</span>
                    <span className="block text-2xs text-muted">{tr(r.role)}</span>
                  </td>
                  <td className="px-3 py-2 num text-2xs text-muted">
                    {r.shift_start && r.shift_end
                      ? `${String(r.shift_start).slice(0, 5)} – ${String(r.shift_end).slice(0, 5)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 num text-2xs">
                    {clock(r.first)}
                    {/*
                      Lateness only means something against a shift. Somebody
                      with no shift set is present, never late.
                    */}
                    {(r.late_minutes ?? 0) > 0 && (
                      <span className="block text-2xs text-warn">
                        +{r.late_minutes}m {tr('late')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 num text-2xs">{clock(r.last)}</td>
                  <td className="px-3 py-2 text-right num text-2xs">{hours(r.minutes)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={
                      r.status === 'in' ? 'ok' : r.status === 'left' ? 'muted'
                        : r.status === 'absent' ? 'bad' : 'muted'}>
                      {tr(r.status === 'in' ? 'In' : r.status === 'left' ? 'Left'
                        : r.status === 'absent' ? 'Absent' : 'Not required')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.attendance_required && (
                      <button onClick={() => setAdding(r)}
                        className="btn-ghost px-2 py-1 text-2xs">
                        <Plus size={12} className="mr-1 inline" />{tr('Punch')}
                      </button>
                    )}
                    {r.punches.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-2xs text-muted">
                          {r.punches.length} {tr('scans')}
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-left">
                          {r.punches.map((p: any) => (
                            <li key={p.id} className="flex items-center justify-between gap-2">
                              <span className="num text-2xs">
                                {clock(p.at)}
                                {p.source === 'manual' && (
                                  <span className="ml-1 text-warn">{tr('by hand')}</span>
                                )}
                              </span>
                              <button onClick={() => removePunch(p.id)}
                                className="rounded px-1 text-muted hover:text-bad">
                                <Trash2 size={11} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddPunch staff={adding} date={date} onClose={() => setAdding(null)}
          onDone={() => { setAdding(null); load() }} />
      )}
    </Card>
  )
}

function AddPunch({ staff, date, onClose, onDone }: {
  staff: any; date: string; onClose: () => void; onDone: () => void
}) {
  const [time, setTime] = useState(
    String(staff.shift_start ?? '09:00').slice(0, 5))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <Modal title={`${tr('Add a punch')} — ${staff.display_name}`} onClose={onClose}
      hint={tr('For the morning the reader will not read somebody\u2019s thumb.')}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !time} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              await api.addAttendancePunch(staff.staff_id, `${date}T${time}:00`,
                note.trim() || null)
              onDone()
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Add')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>

      {/*
        A punch added by hand carries a name and a reason, because it is the
        one anybody could abuse and the one that will be questioned later.
      */}
      <div className="mb-3 flex items-start gap-2 rounded-xl border-2 border-warn/40
                      bg-warn/5 p-3">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
        <p className="text-2xs text-warn">
          {tr('This is recorded as added by hand, with your name and the reason against it.')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Time')}>
          <input type="time" value={time} autoFocus
            onChange={(e) => setTime(e.target.value)} className="field num mt-1" />
        </Field>
        <Field label={tr('Why')}>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={tr('Reader would not read her thumb')} className="field mt-1" />
        </Field>
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------- one person */

function PersonView() {
  const [staff, setStaff] = useState<any[]>([])
  const [staffId, setStaffId] = useState('')
  const [when, setWhen] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.attendanceStaff().then((s: any[]) => {
      setStaff(s)
      if (!staffId && s.length) setStaffId(String(s[0].id))
    }).catch(() => {})
  }, [staffId])

  useEffect(() => {
    if (!staffId) return
    const [y, m] = when.split('-').map(Number)
    api.attendanceMonth(Number(staffId), y, m).then(setData)
      .catch((e: any) => setErr(e.message))
  }, [staffId, when])

  return (
    <Card title={tr('One person, one month')}
      action={
        <div className="flex gap-2">
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}
            className="field w-auto py-1.5 text-2xs">
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.display_name}</option>
            ))}
          </select>
          <input type="month" value={when} onChange={(e) => setWhen(e.target.value)}
            className="field num w-auto py-1.5 text-2xs" />
        </div>
      }>
      <ErrorNote>{err}</ErrorNote>
      {!data ? <SkeletonRows rows={8} cols={4} /> : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label={tr('Days present')} value={String(data.totals.present)} tone="ok" />
            <Stat label={tr('Days absent')} value={String(data.totals.absent)}
              tone={data.totals.absent ? 'bad' : undefined} />
            <Stat label={tr('Time on site')} value={hours(data.totals.minutes)} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="thead-strip">
                <tr>
                  <Th w="w-28">{tr('Date')}</Th><Th w="w-20">{tr('In')}</Th>
                  <Th w="w-20">{tr('Out')}</Th><Th w="w-24" right>{tr('On site')}</Th>
                  <Th>{tr('Status')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divide rows-striped">
                {data.days.map((d: any) => (
                  <tr key={d.date}>
                    <td className="px-3 py-1.5 num text-2xs">
                      {new Date(d.date).toLocaleDateString('en-GB',
                        { day: '2-digit', month: 'short', weekday: 'short' })}
                    </td>
                    <td className="px-3 py-1.5 num text-2xs">{clock(d.first)}</td>
                    <td className="px-3 py-1.5 num text-2xs">{clock(d.last)}</td>
                    <td className="px-3 py-1.5 text-right num text-2xs">{hours(d.minutes)}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={d.status === 'absent' ? 'bad'
                        : d.status === 'exempt' ? 'muted' : 'ok'}>
                        {tr(d.status === 'in' ? 'In' : d.status === 'left' ? 'Left'
                          : d.status === 'absent' ? 'Absent' : 'Not required')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------- readers */

function Readers() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [madeKey, setMadeKey] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.attendanceDevices().then(setRows).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <Card title={tr('Fingerprint readers')}
      hint={tr('Each reader has a key that its agent sends with every scan.')}
      action={<button onClick={() => setAdding(true)}
        className="btn-primary inline-flex items-center gap-1.5">
        <Plus size={14} /> {tr('Add a reader')}
      </button>}>
      <ErrorNote>{err}</ErrorNote>

      {!rows ? <SkeletonRows rows={3} cols={4} />
        : rows.length === 0 ? (
          <Empty title={tr('No readers yet')}
            hint={tr('Add one for each PC with a fingerprint reader plugged into it.')} />
        ) : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Reader')}</Th><Th w="w-32">{tr('Where')}</Th>
              <Th w="w-28">{tr('Key')}</Th><Th w="w-40">{tr('Last heard from')}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {rows.map((d) => (
              <tr key={d.id} className={d.is_active ? '' : 'opacity-50'}>
                <td className="px-3 py-2 text-sm text-heading">{d.name}</td>
                <td className="px-3 py-2 text-2xs text-muted">{d.location ?? '—'}</td>
                <td className="px-3 py-2 num text-2xs text-muted">{d.key_hint}</td>
                <td className="px-3 py-2 text-2xs text-muted">
                  {d.last_seen_at
                    ? new Date(d.last_seen_at).toLocaleString('en-GB')
                    : tr('never')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddReader onClose={() => setAdding(false)}
          onDone={(made: any) => { setAdding(false); setMadeKey(made); load() }} />
      )}

      {madeKey && (
        <Modal title={tr('The reader key')} onClose={() => setMadeKey(null)}
          footer={<button onClick={() => setMadeKey(null)} className="btn-primary">
            {tr('I have copied it')}
          </button>}>
          {/*
            Shown once, on purpose. It goes into the agent's configuration on
            the attendance PC and is never needed again, so leaving it on a
            screen anybody can open is a risk for no benefit.
          */}
          <p className="text-sm text-body">
            {tr('Copy this into the agent on')} <b>{madeKey.name}</b>.
            {' '}{tr('It is not shown again.')}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-xl border-2 border-line
                          bg-raised p-3 num text-2xs">{madeKey.api_key}</pre>
        </Modal>
      )}
    </Card>
  )
}

function AddReader({ onClose, onDone }: {
  onClose: () => void; onDone: (made: any) => void
}) {
  const [f, setF] = useState({ name: '', location: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <Modal title={tr('Add a reader')} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-ghost">{tr('Cancel')}</button>
        <button disabled={busy || !f.name.trim()} className="btn-primary"
          onClick={async () => {
            setBusy(true); setErr(null)
            try {
              onDone(await api.saveAttendanceDevice({
                name: f.name.trim(), location: f.location.trim() || null
              }))
            } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
          }}>
          {busy ? tr('Saving…') : tr('Add')}
        </button>
      </>}>
      <ErrorNote>{err}</ErrorNote>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Name')}>
          <input value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr('Staff entrance')} className="field mt-1" />
        </Field>
        <Field label={tr('Where it is')}>
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}
            placeholder={tr('Main door, ground floor')} className="field mt-1" />
        </Field>
      </div>
    </Modal>
  )
}


/* -------------------------------------------------------- fingerprints */

/**
 * Who has enrolled a finger, and who has not.
 *
 * Separate from the staff form on purpose: enrolment only works at the PC
 * with the reader plugged in, so it is a job somebody does once, in one
 * place, for everybody — not a field they wonder about while adding a nurse
 * at the counter.
 */
function Fingers() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [enrolling, setEnrolling] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api.attendanceStaff().then(setRows).catch((e: any) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  const list = rows ?? []
  const expected = list.filter((r) => r.attendance_required)
  const none = expected.filter((r) => Number(r.fingers) === 0).length

  return (
    <Card title={tr('Fingerprints')}
      hint={tr('Enrolling works only at the PC the reader is plugged into.')}>
      <ErrorNote>{err}</ErrorNote>

      {none > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border-2
                        border-warn/40 bg-warn/5 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-2xs text-warn">
            {none} {tr('people are expected to mark attendance but have no finger enrolled. They will show as absent every day until they do.')}
          </p>
        </div>
      )}

      {!rows ? <SkeletonRows rows={6} cols={3} /> : (
        <table className="w-full">
          <thead className="thead-strip">
            <tr>
              <Th>{tr('Name')}</Th><Th w="w-28">{tr('Role')}</Th>
              <Th w="w-28">{tr('Fingers')}</Th><Th w="w-28" right />
            </tr>
          </thead>
          <tbody className="divide-y divide-divide rows-striped">
            {list.map((s) => (
              <tr key={s.id} className={s.attendance_required ? '' : 'opacity-50'}>
                <td className="px-3 py-2 text-sm text-heading">{s.display_name}</td>
                <td className="px-3 py-2 text-2xs text-muted">{tr(s.role)}</td>
                <td className="px-3 py-2">
                  {!s.attendance_required
                    ? <Badge tone="muted">{tr('Not required')}</Badge>
                    : Number(s.fingers) > 0
                      ? <Badge tone="ok">{s.fingers}</Badge>
                      : <Badge tone="warn">{tr('none')}</Badge>}
                </td>
                <td className="px-3 py-2 text-right">
                  {s.attendance_required && (
                    <button onClick={() => setEnrolling(s)}
                      className="btn-ghost px-2 py-1 text-2xs">
                      <Fingerprint size={13} className="mr-1 inline" />
                      {tr('Fingers')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {enrolling && (
        <EnrolFinger staff={enrolling}
          onClose={() => { setEnrolling(null); load() }} />
      )}
    </Card>
  )
}
