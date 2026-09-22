import { useEffect, useState } from 'react'
import { Sidebar, type NavItem } from '../components/Sidebar'
import { Settings2 } from 'lucide-react'
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
import { PharmacySetup } from './pharma/Setup'
import { Ledgers } from './pharma/Ledgers'
import { Access } from './pharma/Access'
import { Returns } from './pharma/Returns'

type Tab = 'billing' | 'prescriptions' | 'medicines' | 'receive' | 'stock' | 'bills'
  | 'returns' | 'overview' | 'reports' | 'ledgers' | 'access' | 'setup' | 'printing'

/**
 * The rail, grouped by what a person is doing rather than alphabetically.
 *
 * Eleven tabs across the top scrolled off the right-hand edge on the 1366-wide
 * screens these counters have, and the ones that scrolled off were the ones
 * nobody found. Down the side they all fit and stay readable.
 */
const NAV: (NavItem & { id: Tab })[] = [
  { id: 'billing', label: 'Billing', glyph: 'B', section: 'Counter' },
  { id: 'prescriptions', label: 'Prescriptions', glyph: 'Rx' },
  { id: 'returns', label: 'Returns', glyph: 'R' },

  { id: 'medicines', label: 'Medicines', glyph: 'M', section: 'Stock' },
  { id: 'receive', label: 'Receive', glyph: 'in' },
  { id: 'stock', label: 'Stock', glyph: 'S' },

  { id: 'overview', label: 'Overview', glyph: 'O', section: 'Money' },
  { id: 'bills', label: 'Bills', glyph: 'Bl' },
  { id: 'ledgers', label: 'Ledgers', glyph: 'L' },
  { id: 'reports', label: 'Reports', glyph: 'Rp' },

  { id: 'setup', label: 'Suppliers & formulas', glyph: 'Su', icon: Settings2,
    section: 'Setup' },
  { id: 'access', label: 'Access', glyph: 'A' },
  { id: 'printing', label: 'Printing', glyph: 'P' }
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

  access: 'staff.access',
  setup: 'product.edit'
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

  const items = NAV.filter((n) => can(n.id))

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={items} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Pharmacy" subtitle={me.displayName} />

      <div key={tab} className="anim-fade min-h-0 flex-1 overflow-auto bg-screen">
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
        {tab === 'setup' && <PharmacySetup />}
        {tab === 'printing' && (
          <div className="p-4">
            <PrinterSettingsCard module="pharmacy" label={tr('Pharmacy till')} />
          </div>
        )}
      </div>
    </div>
  )
}
