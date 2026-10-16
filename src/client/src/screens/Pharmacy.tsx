import { motion } from 'framer-motion'
import { DUR, EASE } from '../lib/motion'
import { useCallback, useEffect, useState } from 'react'
import { Sidebar, type NavItem } from '../components/Sidebar'
import {
  Settings2, Calculator, FileText, Undo2, Pill, ClipboardList, PackagePlus,
  Boxes, ClipboardCheck, PackageX, CalendarX, PackageOpen, LayoutDashboard,
  ReceiptText, BookOpen, BarChart3, ShieldCheck, Printer, Cross, Building2
} from 'lucide-react'
import { api, type SessionUser } from '../lib/api'
import { useT } from '../lib/prefs'
import { Billing } from './pharmacy/Billing'
import { Prescriptions } from './pharmacy/Prescriptions'
import { Medicines } from './pharmacy/Medicines'
import { Receive } from './pharmacy/Receive'
import { StockScreen } from './pharmacy/Stock'
import { Audits } from './pharmacy/Audits'
import { WriteOff } from './pharmacy/WriteOff'
import { Ordering } from './pharmacy/Ordering'
import { Opening } from './pharmacy/Opening'
import { Bills } from './pharmacy/Bills'
import { DepartmentBilling } from './pharmacy/DepartmentBilling'
import { Overview } from './pharmacy/Overview'
import { PrinterSettingsCard } from '../components/PrinterSettings'
import { Reports } from './pharma/Reports'
import { PharmacySetup } from './pharma/Setup'
import { Ledgers } from './pharma/Ledgers'
import { Access } from './pharma/Access'
import { Returns } from './pharma/Returns'

type Tab = 'billing' | 'prescriptions' | 'medicines' | 'receive' | 'stock' | 'bills'
  | 'returns' | 'overview' | 'reports' | 'ledgers' | 'access' | 'setup' | 'printing'
  | 'audits' | 'ordering' | 'opening' | 'damage' | 'expiry' | 'departments'

/**
 * The rail, grouped by what a person is doing rather than alphabetically.
 *
 * Eleven tabs across the top scrolled off the right-hand edge on the 1366-wide
 * screens these counters have, and the ones that scrolled off were the ones
 * nobody found. Down the side they all fit and stay readable.
 */
const NAV: (NavItem & { id: Tab })[] = [
  { id: 'billing', label: 'Billing', glyph: 'B', icon: Calculator, section: 'Counter' },
  { id: 'prescriptions', label: 'Prescriptions', glyph: 'Rx', icon: FileText },
  { id: 'returns', label: 'Returns', glyph: 'R', icon: Undo2 },
  /*
   * In the Counter group: it is billing, done at the same counter by the
   * same people, just to a department of the hospital instead of a patient.
   */
  { id: 'departments', label: 'Interdepartmental Billing', glyph: 'ID', icon: Building2 },

  { id: 'medicines', label: 'Medicines', glyph: 'M', icon: Pill, section: 'Stock' },
  { id: 'ordering', label: 'Order', glyph: 'PO', icon: ClipboardList },
  { id: 'receive', label: 'Receive', glyph: 'in', icon: PackagePlus },
  { id: 'stock', label: 'Stock', glyph: 'S', icon: Boxes },
  { id: 'audits', label: 'Audits', glyph: 'Au', icon: ClipboardCheck },
  /*
   * Breakage and expiry, next to the count sheets.
   *
   * All three answer the same question - why the shelf and the system
   * disagree - and somebody who has just found an out-of-date box is one
   * click from the screen that takes it off.
   */
  { id: 'damage', label: 'Damage', glyph: 'Dm', icon: PackageX },
  { id: 'expiry', label: 'Expiry', glyph: 'Ex', icon: CalendarX },
  /*
   * Last in the Stock group, and invisible without its own permission.
   *
   * It belongs to the first morning of a changeover and nowhere else, so it
   * sits below the tabs somebody uses every day rather than above them.
   */
  { id: 'opening', label: 'Opening stock', glyph: 'Op', icon: PackageOpen },

  { id: 'overview', label: 'Overview', glyph: 'O', icon: LayoutDashboard, section: 'Money' },
  { id: 'bills', label: 'Bills', glyph: 'Bl', icon: ReceiptText },
  { id: 'ledgers', label: 'Ledgers', glyph: 'L', icon: BookOpen },
  { id: 'reports', label: 'Reports', glyph: 'Rp', icon: BarChart3 },

  { id: 'setup', label: 'Suppliers & formulas', glyph: 'Su', icon: Settings2,
    section: 'Setup' },
  { id: 'access', label: 'Access', glyph: 'A', icon: ShieldCheck },
  { id: 'printing', label: 'Printing', glyph: 'P', icon: Printer }
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
  /* Its own tick, on for counter staff by default; the server checks it too. */
  departments: 'sale.department',
  /*
   * Off for a pharmacy running on its own.
   *
   * A standalone chemist has no doctors sending prescriptions through, so the
   * tab is an empty screen somebody clicks once and never again. It is on by
   * default, so a hospital pharmacy sees no change.
   */
  prescriptions: 'prescriptions.see',
  audits: 'stock.view',
  /*
   * Visible to anybody who can see stock. The SAVE is what is gated.
   *
   * These were hidden behind their own write permissions, which are off for
   * counter staff by default — so an owner who went looking for the damage
   * screen found no tab and no explanation, which is exactly how the
   * discount box went missing. Seeing what came off the shelf and taking
   * something off it are different questions, and only the second is
   * dangerous; the same reasoning the Returns tab already runs on.
   *
   * The button on the screen is disabled without the tick, it says which
   * tick is missing, and the server refuses regardless.
   */
  damage: 'stock.view',
  expiry: 'stock.view',
  receive: 'purchase.receive',
  /*
   * Returns is deliberately NOT in this map.
   *
   * It was gated on sale.return, which is not granted by default, so the tab
   * was invisible to everyone except a pharmacy administrator — and a
   * customer standing at the counter with a strip they want to bring back is
   * the most ordinary thing that happens at a till. The person serving them
   * could not even find the screen to tell them no.
   *
   * The screen itself still refuses to post a return without the permission,
   * which is the right place for that check: seeing the tab and being able
   * to give money back are different questions, and only the second one is
   * dangerous.
   */
  stock: 'stock.view',
  ordering: 'purchase.receive',
  opening: 'stock.opening',
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

  /*
   * Expired batches still on the shelf, as a badge beside Expiry in the rail.
   *
   * The same request, and so the same rule, as the Expiry screen used for
   * the badge that sat beside its title: batches past their expiry date
   * (before the database's today) that still hold stock. Read once when the
   * module opens, again whenever the person moves between tabs — stock comes
   * in under Receive and goes out under Expiry and Damage, and moving away
   * from those is when the count can have changed — after every write-off,
   * and every ten minutes so it turns over at midnight on a till left open.
   * A failed read leaves the last count rather than flashing it away.
   */
  const [expired, setExpired] = useState<{ batches: number; medicines: number; units: number } | null>(null)
  const mayExpiry = can('expiry')
  const loadExpired = useCallback(() => {
    if (!mayExpiry) return
    api.ph.expiredCount().then(setExpired).catch(() => {})
  }, [mayExpiry])
  useEffect(loadExpired, [loadExpired, tab])
  useEffect(() => {
    const t = setInterval(loadExpired, 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadExpired])

  const items = NAV.filter((n) => can(n.id)).map((n) => n.id === 'expiry' && expired
    ? { ...n, badge: expired.batches, badgeTone: 'bad' as const,
        badgeTitle: `${expired.batches} ${tr('expired batches')} · ${expired.medicines} ${
          tr('medicines')} · ${expired.units} ${tr('units on the shelf')}` }
    : n)

  return (
    <div className="flex h-full min-h-0">
      <Sidebar items={items} active={tab} onSelect={(id) => setTab(id as Tab)}
        title="Pharmacy" subtitle={me.displayName} brandIcon={Cross} />

      {/*
        A keyed panel that animates in, with no exit and no AnimatePresence.

        This was `AnimatePresence mode="wait"`, which holds the incoming tab
        until the outgoing one has finished animating away. When that exit
        never completed — an interrupted transition, a child unmounting with
        its own exit animation partway through — the new tab was never mounted
        and every screen in the module stayed blank until the whole app was
        remounted by signing in again.

        Waiting buys a slightly tidier crossfade and costs a module that can
        wedge itself. Not a trade worth making on a counter.
      */}
        <motion.div key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.page, ease: EASE }}
          className="min-h-0 flex-1 overflow-auto bg-screen">
        {tab === 'billing' && (
          <Billing me={me} pending={pending} onConsumed={() => setPending(null)} />
        )}
        {tab === 'prescriptions' && <Prescriptions onFill={fill} />}
        {tab === 'medicines' && <Medicines />}
        {tab === 'receive' && <Receive />}
        {tab === 'returns' && <Returns me={me} />}
        {tab === 'stock' && <StockScreen />}
        {tab === 'audits' && <Audits me={me} />}
        {tab === 'damage' && <WriteOff kind="damage" me={me} />}
        {tab === 'expiry' && <WriteOff kind="expiry" me={me} onWrittenOff={loadExpired} />}
        {tab === 'ordering' && <Ordering me={me} />}
        {tab === 'opening' && <Opening me={me} />}
        {tab === 'bills' && <Bills me={me} />}
        {tab === 'departments' && <DepartmentBilling me={me} />}
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
      </motion.div>
    </div>
  )
}
