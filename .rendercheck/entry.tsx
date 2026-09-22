import { renderToString } from 'react-dom/server'
import { PrefsProvider } from '../src/client/src/lib/prefs'
import { Doctor, Earnings } from '../src/client/src/screens/Doctor'
import { Pharmacy } from '../src/client/src/screens/Pharmacy'
import { MainCounter } from '../src/client/src/screens/MainCounter'
import { OpdCounter } from '../src/client/src/screens/OpdCounter'
import { Admin } from '../src/client/src/screens/Admin'
import { BackupLocationCard, DangerZoneCard } from '../src/client/src/screens/admin/DangerZone'
import { IpdCounter } from '../src/client/src/screens/IpdCounter'
import { Stores } from '../src/client/src/screens/Stores'
import { Lab } from '../src/client/src/screens/Lab'
import { Reports as PharmaReports } from '../src/client/src/screens/pharma/Reports'
import { Ledgers } from '../src/client/src/screens/pharma/Ledgers'
import { Access } from '../src/client/src/screens/pharma/Access'
import { Returns } from '../src/client/src/screens/pharma/Returns'
import { Nuskha } from '../src/client/src/components/Nuskha'
import { LabelSheet } from '../src/client/src/components/Labels'
import { SignIn } from '../src/client/src/screens/SignIn'
import { Billing } from '../src/client/src/screens/pharmacy/Billing'
import { Bills } from '../src/client/src/screens/pharmacy/Bills'
import { Medicines } from '../src/client/src/screens/pharmacy/Medicines'
import { Overview } from '../src/client/src/screens/pharmacy/Overview'
import { Prescriptions } from '../src/client/src/screens/pharmacy/Prescriptions'
import { Receive } from '../src/client/src/screens/pharmacy/Receive'
import { StockScreen } from '../src/client/src/screens/pharmacy/Stock'
import { CounterBilling } from '../src/client/src/screens/counter/Billing'
import { PrinterSettingsCard } from '../src/client/src/components/PrinterSettings'
import { CounterBillSlip } from '../src/client/src/components/CounterBill'
import { ChitSlip, ReceiptSlip } from '../src/client/src/components/Chit'

/**
 * Every screen and every sub-view, rendered once.
 *
 * A white screen is an exception thrown during render, and nothing else in the
 * test suite exercises rendering — the earnings tab crashed for a week because
 * a local variable shadowed the translator, and the API tests were all green
 * the whole time. Sub-views are listed individually on purpose: rendering only
 * the top-level screen misses anything behind a tab, which is exactly how that
 * bug got through.
 */

const user = (role: string): any =>
  ({ id: 1, username: 'x', displayName: 'Test User', role, doctorId: 1 })

const noop = () => {}
const hospital = { name: 'Test Hospital', address: 'Somewhere', chitFooter: 'x', receiptFooter: 'y' }
const bill = { bill_no: 'INV-1', kind: 'consultation', created_at: new Date().toISOString(),
  cashier_name: 'C', patient_name: 'P', mrn: 'MRN-1', token_no: 3, subtotal_paisa: 100,
  discount_paisa: 0, total_paisa: 100, tendered_paisa: 200, change_paisa: 100, pay_method: 'cash' }
const chitUnpaid = { ...bill, chit_no: 'CHIT-1', status: 'ordered', category: 'lab' }
const chitPaid = { ...chitUnpaid, status: 'paid', paid_at: new Date().toISOString(),
  paid_by: 'Cashier', pay_method: 'cash' }
const chitDone = { ...chitPaid, status: 'completed', completed_by: 'Radiographer' }

const cases: [string, () => any][] = [
  ['SignIn', () => <SignIn onSignedIn={noop} />],
  ['Doctor (queue)', () => <Doctor me={user('doctor')} />],
  ['Doctor (earnings)', () => <Earnings me={user('doctor')} />],
  ['MainCounter', () => <MainCounter me={user('main_counter')} />],
  ['CounterBilling (empty)', () => <CounterBilling me={user('main_counter')} target={null} onDone={noop} onCancel={noop} />],
  ['CounterBilling (consultation)', () => <CounterBilling me={user('main_counter')} target={{ kind: 'consultation', visitId: 1 }} onDone={noop} onCancel={noop} />],
  ['OpdCounter', () => <OpdCounter me={user('receptionist')} />],
  ['IpdCounter', () => <IpdCounter me={user('ipd_counter')} />],
  ['Stores', () => <Stores me={user('store_keeper')} />],
  ['Lab', () => <Lab me={user('lab_tech')} />],
  ['Pharmacy reports', () => <PharmaReports me={user('pharmacist')} />],
  ['Pharmacy ledgers', () => <Ledgers me={user('pharmacist')} />],
  ['Pharmacy access', () => <Access me={user('pharmacy_admin')} />],
  ['Pharmacy returns', () => <Returns me={user('pharmacist')} />],
  ['Radiology', () => <Lab me={user('radiology')} />],
  ['Prescription slip', () => <Nuskha hospital={hospital} data={{
    prescription: { patient_name: 'Test Patient', mrn: 'MRN-1', age_years: 40,
      gender: 'male', doctor_name: 'Dr Yasir', diagnosis: 'Viral fever',
      advice: 'Rest and fluids', visit_at: new Date().toISOString() },
    items: [
      { id: 1, drug_name: 'Panadol 500mg', dose: '1 tab', frequency: 'TDS',
        duration_days: 5, qty_prescribed: 2, instructions: 'After meals' },
      { id: 2, drug_name: 'Augmentin 625', dose: '1 tab', frequency: 'BD',
        duration_days: 7, qty_prescribed: 1 },
      { id: 3, drug_name: 'Cough syrup', frequency: 'SOS', qty_prescribed: 1 }
    ]
  }} />],
  ['Medicine labels', () => <LabelSheet hospital={hospital} labels={[
    { name: 'Panadol 500mg', qty: '10 tablets', slots: { morning: true, noon: true, evening: true },
      days: '5', instructions: 'After meals', frequency: 'TDS' },
    { name: 'Augmentin 625', qty: '6 tablets', slots: { morning: true, noon: false, evening: true },
      days: '3', instructions: 'With water', frequency: 'BD' },
    { name: 'Cough syrup', qty: '1 bottle', slots: { morning: false, noon: false, evening: false },
      frequency: 'SOS', instructions: 'When needed' }
  ]} />],
  ['Admin', () => <Admin me={user('admin')} />],
  ['Backup location', () => <BackupLocationCard />],
  ['Danger zone', () => <DangerZoneCard me={user('admin')} />],
  ['Pharmacy', () => <Pharmacy me={user('pharmacist')} />],
  ['Pharmacy billing', () => <Billing me={user('pharmacist')} pending={null} onConsumed={noop} />],
  ['Pharmacy bills', () => <Bills />],
  ['Pharmacy medicines', () => <Medicines />],
  ['Pharmacy overview', () => <Overview />],
  ['Pharmacy prescriptions', () => <Prescriptions onFill={noop} />],
  ['Pharmacy receive', () => <Receive />],
  ['Pharmacy stock', () => <StockScreen />],
  ['Printer settings', () => <PrinterSettingsCard module="counter" label="Test" />],
  ['Counter bill slip', () => <CounterBillSlip bill={bill} items={[{ id: 1, description: 'Consultation', amount_paisa: 100 }]} hospital={hospital} />],
  ['Chit slip (unpaid)', () => <ChitSlip chit={chitUnpaid} lines={[{ id: 1, service_name: 'X-Ray', price_paisa: 100 }]} hospital={hospital} categoryLabel="Radiology" />],
  ['Chit slip (paid)', () => <ChitSlip chit={chitPaid} lines={[{ id: 1, service_name: 'X-Ray', price_paisa: 100 }]} hospital={hospital} categoryLabel="Radiology" />],
  ['Chit slip (completed)', () => <ChitSlip chit={chitDone} lines={[{ id: 1, service_name: 'X-Ray', price_paisa: 100 }]} hospital={hospital} categoryLabel="Radiology" />],
  ['Receipt slip', () => <ReceiptSlip sale={{ invoiceNo: 'B-1', soldAt: new Date().toISOString(), cashierName: 'C', subtotalPaisa: 100, discountPaisa: 0, taxPaisa: 0, totalPaisa: 100, paidPaisa: 100, payMethod: 'cash' }} items={[{ id: 1, product_name: 'Panadol', display_qty: 1, unit_price_paisa: 100, line_total_paisa: 100 }]} hospital={hospital} />]
]

let failed = 0
for (const lang of ['en', 'ur'] as const) {
  globalThis.localStorage.setItem('hms.lang', lang)
  console.log(`\n— rendering in ${lang} —`)
  for (const [name, make] of cases) {
    try {
      renderToString(<PrefsProvider>{make()}</PrefsProvider>)
      console.log('  ok   ' + name)
    } catch (e: any) {
      failed++
      console.log('  FAIL ' + name + ' — ' + (e?.message ?? e))
    }
  }
}
console.log(failed ? `\n${failed} render failure(s)\n` : `\nall ${cases.length * 2} renders clean\n`)
process.exit(failed ? 1 : 0)
