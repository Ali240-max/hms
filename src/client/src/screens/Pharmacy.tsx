import { useEffect, useState } from 'react'
import { api, type SessionUser } from '../lib/api'
import { useT } from '../lib/prefs'
import { Billing } from './pharmacy/Billing'
import { Prescriptions } from './pharmacy/Prescriptions'
import { Medicines } from './pharmacy/Medicines'
import { Receive } from './pharmacy/Receive'
import { StockScreen } from './pharmacy/Stock'
import { Bills } from './pharmacy/Bills'
import { Overview } from './pharmacy/Overview'
import { PrinterSettingsCard } from '../components/PrinterSettings'
import { Reports } from './pharma/Reports'
import { Ledgers } from './pharma/Ledgers'
import { Access } from './pharma/Access'
import { Returns } from './pharma/Returns'

type Tab = 'billing' | 'prescriptions' | 'medicines' | 'receive' | 'stock' | 'bills'
  | 'returns' | 'overview' | 'reports' | 'ledgers' | 'access' | 'printing'

const TABS: [Tab, string][] = [
  ['billing', 'Billing'], ['prescriptions', 'Prescriptions'], ['medicines', 'Medicines'],
  ['receive', 'Receive'], ['returns', 'Returns'], ['stock', 'Stock'],
  ['bills', 'Bills'], ['overview', 'Overview'],
  ['reports', 'Reports'], ['ledgers', 'Ledgers'], ['access', 'Access'], ['printing', 'Printing']
]

export type PendingFill = {
  visitId: number; patientId: number; patientName: string; doctorName: string; items: any[]
}

/**
 * The pharmacy, as its own application inside the hospital system.
 *
 * The counter is the first tab because that is where a pharmacist spends the
 * day. Handing a prescription to Billing is the one piece of state that has to
 * live up here, since it crosses between two tabs.
 */
/**
 * Which permission each tab needs.
 *
 * There is one pharmacy module, not two. A counter assistant and the owner
 * open the same screen; what differs is the row of tabs across the top, and
 * that follows the checkboxes set against the person rather than their job
 * title. Splitting it into a separate "office" application was the wrong shape
 * — it put the reports somewhere the person at the counter could not reach
 * even when they were allowed to see them.
 */
const TAB_PERMISSION: Partial<Record<Tab, string>> = {
  billing: 'sale.counter',
  receive: 'purchase.receive',
  returns: 'sale.return',
  stock: 'stock.view',
  bills: 'report.sales',
  overview: 'report.sales',
  reports: 'report.sales',
  ledgers: 'ledger.view',
  access: 'staff.access'
}

export function Pharmacy({ me }: { me: SessionUser }) {
  const [allowed, setAllowed] = useState<Set<string> | null>(null)

  useEffect(() => {
    api.permissionsFor(me.id)
      .then((d: any) => setAllowed(new Set<string>(d.allowed)))
      // If permissions cannot be read, show everything the role already
      // allowed rather than locking someone out of their own till.
      .catch(() => setAllowed(null))
  }, [me.id])

  const can = (tab: Tab) => {
    const need = TAB_PERMISSION[tab]
    if (!need || !allowed) return true
    if (me.role === 'admin') return true
    return allowed.has(need)
  }

  const tr = useT()
  const [tab, setTab] = useState<Tab>('billing')
  const [pending, setPending] = useState<PendingFill | null>(null)

  function fill(p: PendingFill) {
    setPending(p)
    setTab('billing')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex gap-1 overflow-x-auto border-b border-line bg-card px-4 pt-3">
        {TABS.filter(([id]) => can(id)).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`relative whitespace-nowrap rounded-t-xl px-3 py-2 text-sm
                        transition-all duration-150 hover:-translate-y-px ${
              tab === id
                ? 'border-b-2 border-primary font-medium text-primary'
                : 'text-muted hover:text-body'}`}>
            {tr(label)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'billing' && (
          <Billing me={me} pending={pending} onConsumed={() => setPending(null)} />
        )}
        {tab === 'prescriptions' && <Prescriptions onFill={fill} />}
        {tab === 'medicines' && <Medicines />}
        {tab === 'receive' && <Receive />}
        {tab === 'returns' && <Returns me={me} />}
        {tab === 'stock' && <StockScreen />}
        {tab === 'bills' && <Bills />}
        {tab === 'overview' && <Overview />}
        {tab === 'reports' && <Reports me={me} />}
        {tab === 'ledgers' && <Ledgers me={me} />}
        {tab === 'access' && <Access me={me} />}
        {tab === 'printing' && (
          <div className="p-4">
            <PrinterSettingsCard module="pharmacy" label={tr('Pharmacy till')} />
          </div>
        )}
      </div>
    </div>
  )
}
