import { useEffect, useRef, useState } from 'react'
import { api, setToken, type SessionUser } from '../lib/api'
import { ErrorNote, Field } from '../components/ui'
import { t as tr } from '../lib/prefs'

const DEPTS = [
  { role: 'main_counter', label: 'Main counter', desc: 'Register patients, take fees and settle chits' },
  { role: 'receptionist', label: 'OPD counter', desc: 'Hold the queue and record vitals' },
  { role: 'ipd_counter', label: 'Emergency', desc: 'Admit arrivals and record bedside medicines' },
  { role: 'doctor', label: 'Doctor', desc: 'See your patients and prescribe' },
  { role: 'pharmacist', label: 'Pharmacy', desc: 'Counter, stock, reports and ledgers' },
  { role: 'store_keeper', label: 'Stores', desc: 'Hospital consumables and supplies' },
  { role: 'lab_tech', label: 'Laboratory', desc: 'Samples, results and reports' },
  { role: 'radiology', label: 'Radiology', desc: 'X-ray, ultrasound and imaging reports' },
  { role: 'reports', label: 'Reports', desc: 'Every report in the hospital, read only' },
  { role: 'admin', label: 'Administration', desc: 'Staff, services, prices and reports' }
] as const

/**
 * Which module a cell belongs to, so a hospital that is not using one does not
 * have to look at its button. Administration and the main counter have no
 * entry because they are always on: without them nobody can sign in or be
 * registered.
 */
const CELL_MODULE: Record<string, string> = {
  receptionist: 'opdCounter',
  ipd_counter: 'emergency',
  doctor: 'doctor',
  pharmacist: 'pharmacy',
  store_keeper: 'stores',
  lab_tech: 'laboratory',
  radiology: 'radiology'
}

/**
 * The department buttons are a signpost, not a permission.
 *
 * What a person can do is decided by the role on their account, checked on the
 * server. Picking "Pharmacy" here only sets where they land after signing in.
 * If it granted access, anyone could click Administration.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [mode, setMode] = useState<'loading' | 'login' | 'setup'>('loading')
  const [modules, setModules] = useState<Record<string, boolean> | null>(null)
  const [dept, setDept] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Read before anyone signs in, so the cells are right on first paint.
    api.modules().then(setModules).catch(() => setModules(null))
  }, [])

  useEffect(() => {
    api.authStatus()
      .then((st) => setMode(st.needsSetup ? 'setup' : 'login'))
      .catch(() => setMode('login'))
  }, [])
  useEffect(() => { if (dept || mode === 'setup') first.current?.focus() }, [dept, mode])

  async function submit() {
    setErr(null)
    if (mode === 'setup' && password !== confirm) { setErr('The two passwords do not match'); return }
    setBusy(true)
    try {
      const r = mode === 'setup'
        ? await api.setup({ username: username.trim(), displayName: displayName.trim(), password })
        : await api.login(username.trim(), password)
      setToken(r.token)
      onSignedIn(r.user)
    } catch (e: any) {
      setErr(e.message ?? 'Could not sign in')
      setPassword('')
    } finally { setBusy(false) }
  }

  if (mode === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-muted">{tr('Starting…')}</div>
  }

  /* -------------------------------------------------------------- setup */
  if (mode === 'setup') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">{tr('Set up this hospital')}</h1>
        <p className="mt-1 text-2xs text-muted">
          Create the administrator account. Only this account can add staff, set prices
          and change doctor shares.
        </p>
        <div className="mt-5 space-y-3">
          <Field label={tr('Username')}>
            <input ref={first} value={username} onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="off" spellCheck={false} placeholder={tr('admin')} className="field" />
          </Field>
          <Field label={tr('Your name')}>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder={tr('Administrator')} className="field" />
          </Field>
          <Field label={tr('Password')} hint={tr('At least 8 characters')}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="field" />
          </Field>
          <Field label={tr('Confirm password')}>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} className="field" />
          </Field>
          <ErrorNote>{err}</ErrorNote>
          <button onClick={submit} disabled={busy || !username.trim() || !password}
            className="btn-primary w-full">
            {busy ? 'Please wait…' : 'Create administrator account'}
          </button>
          <p className="text-2xs text-muted">
            Write this password down somewhere safe. It cannot be recovered from inside
            the system, and without it nobody can manage staff or prices.
          </p>
        </div>
      </Shell>
    )
  }

  /* ------------------------------------------------------ pick a station */
  if (!dept) {
    return (
      <Shell wide>
        <h1 className="text-lg font-semibold">{tr('Where are you working?')}</h1>
        <p className="mt-1 text-2xs text-muted">
          {tr('This chooses your starting screen. What you can actually do comes from your account.')}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {DEPTS.filter((d) => {
            const key = CELL_MODULE[d.role]
            // Unknown modules, and a failed read, show everything rather than
            // locking someone out of a module that is switched on.
            return !key || !modules || modules[key] !== false
          }).map((d) => (
            <button key={d.role} onClick={() => setDept(d.role)}
              className="card-tint flex items-start gap-3 p-4 text-left transition-shadow hover:shadow-md">
              <span className="tile shrink-0">{d.label[0]}</span>
              <span>
                <span className="block text-sm font-medium text-heading">{tr(d.label)}</span>
                <span className="block text-2xs text-muted">{tr(d.desc)}</span>
              </span>
            </button>
          ))}
        </div>
      </Shell>
    )
  }

  /* -------------------------------------------------------------- login */
  const chosen = DEPTS.find((d) => d.role === dept)!
  return (
    <Shell>
      <button onClick={() => { setDept(null); setErr(null) }}
        className="mb-4 text-2xs text-muted hover:text-primary">
        &larr; Choose a different station
      </button>
      <div className="flex items-center gap-3">
        <span className="tile">{chosen.label[0]}</span>
        <div>
          <h1 className="text-lg font-semibold">{chosen.label}</h1>
          <p className="text-2xs text-muted">{tr('Sign in with your own account')}</p>
        </div>
      </div>
      <div className="mt-5 space-y-3">
        <Field label={tr('Username')}>
          <input ref={first} value={username} onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="off" spellCheck={false} className="field" />
        </Field>
        <Field label={tr('Password')}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} className="field" />
        </Field>
        <ErrorNote>{err}</ErrorNote>
        <button onClick={submit} disabled={busy || !username.trim() || !password}
          className="btn-primary w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </Shell>
  )
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-screen p-6">
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-sm'}`}>
        <div className="card p-6">{children}</div>
        <p className="mt-4 text-center text-2xs text-muted">
          {tr('Software by Ali Farooqi &middot; 0332 4471592')}
        </p>
      </div>
    </div>
  )
}
