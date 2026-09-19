import { useEffect, useState } from 'react'
import { api, setToken, setSignedOutHandler, type SessionUser } from './lib/api'
import { SignIn } from './screens/SignIn'
import { MainCounter } from './screens/MainCounter'
import { OpdCounter } from './screens/OpdCounter'
import { IpdCounter } from './screens/IpdCounter'
import { Stores } from './screens/Stores'
import { Lab } from './screens/Lab'
import { Doctor } from './screens/Doctor'
import { Pharmacy } from './screens/Pharmacy'
import { Admin } from './screens/Admin'
import { ReportsDesk } from './screens/reports/ReportsDesk'
import { AppearanceToggle, useT } from './lib/prefs'
import { ModulesProvider } from './lib/modules'
import { t as tr } from './lib/prefs'

const HOME: Record<string, string> = {
  admin: 'Administration', main_counter: 'Main counter', receptionist: 'OPD counter',
  ipd_counter: 'Emergency', store_keeper: 'Stores', lab_tech: 'Laboratory',
  radiology: 'Radiology',
  doctor: 'Consultation', pharmacist: 'Pharmacy', reports: 'Reports'
}

export default function App() {
  const [me, setMe] = useState<SessionUser | null>(null)
  const tr = useT()

  // If the server ever rejects the session, drop straight back to sign-in
  // rather than leaving screens showing data they can no longer refresh.
  useEffect(() => { setSignedOutHandler(() => setMe(null)) }, [])

  if (!me) return <><SignIn onSignedIn={setMe} /><AppearanceToggle /></>

  return (
    <ModulesProvider>
    <div className="flex h-full flex-col bg-screen">
      {/*
        Sized for whatever monitor a ward happens to have. The title shrinks
        away before the account controls do, so signing out is always reachable.
      */}
      <header className="no-print flex shrink-0 items-center gap-4 border-b-2 border-line bg-card px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="tile shrink-0">H</span>
          <span className="hidden truncate text-sm font-semibold text-heading sm:block">
            {tr(HOME[me.role])}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden text-right sm:block">
            <span className="block text-2xs font-medium leading-tight text-heading">
              {me.displayName}
            </span>
            <span className="block text-2xs capitalize leading-tight text-muted">
              {me.departmentName ? `${me.role} · ${me.departmentName}` : me.role}
            </span>
          </span>
          <button
            onClick={async () => {
              await api.logout().catch(() => {})
              setToken(null)
              setMe(null)
            }}
            className="btn-ghost px-3 py-1.5 text-2xs">
            {tr('Sign out')}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {me.role === 'main_counter' && <MainCounter me={me} />}
        {me.role === 'receptionist' && <OpdCounter me={me} />}
        {me.role === 'ipd_counter' && <IpdCounter me={me} />}
        {me.role === 'store_keeper' && <Stores me={me} />}
        {me.role === 'lab_tech' && <Lab me={me} />}
        {me.role === 'radiology' && <Lab me={me} />}
        {me.role === 'doctor' && <Doctor me={me} />}
        {me.role === 'pharmacist' && <Pharmacy me={me} />}
        {/*
          Accounts created before the pharmacy became one module still carry
          the old role, so they are sent to the same screen rather than left
          staring at a blank page.
        */}
        {(me.role as string) === 'pharmacy_admin' && <Pharmacy me={me} />}
        {me.role === 'reports' && <ReportsDesk me={me} />}
        {me.role === 'admin' && <Admin me={me} />}
      </main>
      <AppearanceToggle />
    </div>
    </ModulesProvider>
  )
}
