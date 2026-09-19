const BASE = '/api'

/**
 * Session token, in memory only. Closing the tab signs you out, which is right
 * on a shared ward machine where the next person should identify themselves.
 */
let token: string | null = null
export const setToken = (t: string | null) => { token = t }
export const getToken = () => token

let onSignedOut: (() => void) | null = null
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  })
  if (res.status === 401 && !path.startsWith('/auth')) {
    token = null
    onSignedOut?.()
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw Object.assign(new Error(body.error ?? 'Request failed'),
      { code: body.code, status: res.status })
  }
  return res.json()
}

export type Role = 'admin' | 'main_counter' | 'receptionist' | 'ipd_counter' | 'store_keeper' | 'lab_tech' | 'radiology' | 'doctor' | 'pharmacist' | 'pharmacy_admin' | 'reports'
export type SessionUser = {
  id: number; username: string; displayName: string; role: Role
  departmentId: number | null; departmentName?: string | null; doctorId?: number | null
}

export type SearchHit = {
  id: number; name: string; generic_name: string | null; strength: string | null
  form: string | null; unit_label: string; sub_unit_label: string | null
  pack_size: number; allow_loose: boolean
  schedule: 'otc' | 'g' | 'controlled' | 'refrigerated'
  tax_rate_bp: number; total_qty: number; manufacturer: string | null
  /** Price per single unit, set on the medicine rather than per delivery. */
  purchase_paisa: number; trade_paisa: number; retail_paisa: number
  batch_id: number | null; batch_no: string | null
  expiry_date: string | null; price_paisa: number | null
}

export const api = {
  /* ------------------------------------------------------------ pharmacy */
  ph: {
    inventory: (o: { q?: string; filter?: string; manufacturer?: string; supplierId?: number } = {}) => {
      const p = new URLSearchParams()
      if (o.q) p.set('q', o.q)
      if (o.filter) p.set('filter', o.filter)
      if (o.manufacturer) p.set('manufacturer', o.manufacturer)
      if (o.supplierId) p.set('supplierId', String(o.supplierId))
      return req<any[]>(`/pharmacy/inventory?${p}`)
    },
    summary: () => req<any>('/pharmacy/inventory/summary'),
    filters: () => req<{ manufacturers: any[]; suppliers: any[] }>('/pharmacy/inventory/filters'),
    createProduct: (b: any) => req<any>('/pharmacy/products', { method: 'POST', body: JSON.stringify(b) }),
    updateProduct: (id: number, b: any) =>
      req<any>(`/pharmacy/products/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    archiveProduct: (id: number) => req<any>(`/pharmacy/products/${id}/archive`, { method: 'POST' }),
    restoreProduct: (id: number) => req<any>(`/pharmacy/products/${id}/restore`, { method: 'POST' }),
    batches: (id: number) => req<any[]>(`/pharmacy/products/${id}/batches`),

    suppliers: (all = false) => req<any[]>(`/pharmacy/suppliers${all ? '?all=1' : ''}`),
    createSupplier: (b: any) => req<any>('/pharmacy/suppliers', { method: 'POST', body: JSON.stringify(b) }),
    updateSupplier: (id: number, b: any) =>
      req<any>(`/pharmacy/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    deleteSupplier: (id: number) =>
      req<{ action: 'deleted' | 'archived'; reason?: string }>(`/pharmacy/suppliers/${id}`, { method: 'DELETE' }),
    restoreSupplier: (id: number) => req<any>(`/pharmacy/suppliers/${id}/restore`, { method: 'POST' }),

    purchases: (o: { q?: string; supplier?: number; from?: string; to?: string } = {}) => {
      const p = new URLSearchParams()
      if (o.q) p.set('q', o.q)
      if (o.supplier) p.set('supplier', String(o.supplier))
      if (o.from) p.set('from', o.from)
      if (o.to) p.set('to', o.to)
      return req<any[]>(`/pharmacy/purchases?${p}`)
    },
    purchase: (id: number) => req<any>(`/pharmacy/purchases/${id}`),
    receiveGoods: (b: any) => req<any>('/pharmacy/purchases', { method: 'POST', body: JSON.stringify(b) }),

    sell: (b: any) => req<any>('/pharmacy/sales', { method: 'POST', body: JSON.stringify(b) }),
    sales: (o: any) => {
      const p = new URLSearchParams({ mode: o.mode })
      for (const k of ['from', 'to', 'seqFrom', 'seqTo', 'amtFrom', 'amtTo', 'q', 'sort', 'cashier']) {
        if (o[k] != null && o[k] !== '') p.set(k, String(o[k]))
      }
      return req<{ rows: any[]; totals: any }>(`/pharmacy/sales?${p}`)
    },
    sale: (id: number) => req<any>(`/pharmacy/sales/${id}`),
    saleBounds: () => req<any>('/pharmacy/sales/bounds'),
    cashiers: () => req<any[]>('/pharmacy/sales/cashiers'),

    expiring: (days = 90) => req<any[]>(`/pharmacy/reports/expiring?days=${days}`),
    lowStock: () => req<any[]>('/pharmacy/reports/low-stock'),
    dashboard: (days = 30) => req<any>(`/pharmacy/dashboard?days=${days}`)
  },

  authStatus: () => req<{ needsSetup: boolean; user: SessionUser | null }>('/auth/status'),
  setup: (b: any) => req<{ token: string; user: SessionUser }>('/auth/setup', { method: 'POST', body: JSON.stringify(b) }),
  login: (username: string, password: string) =>
    req<{ token: string; user: SessionUser }>('/auth/login',
      { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  departments: () => req<any[]>('/departments'),
  createDepartment: (b: any) => req<any>('/departments', { method: 'POST', body: JSON.stringify(b) }),

  staff: () => req<any[]>('/staff'),
  createStaff: (b: any) => req<any>('/staff', { method: 'POST', body: JSON.stringify(b) }),
  setStaffPassword: (id: number, password: string) =>
    req<any>(`/staff/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  archiveStaff: (id: number) => req<any>(`/staff/${id}/archive`, { method: 'POST' }),
  restoreStaff: (id: number) => req<any>(`/staff/${id}/restore`, { method: 'POST' }),
  updateDoctor: (id: number, b: any) => req<any>(`/doctors/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  doctors: () => req<any[]>('/doctors'),
  doctorShares: (id: number) => req<any[]>(`/doctors/${id}/shares`),
  setDoctorShare: (id: number, serviceId: number, shareBp: number | null) =>
    req<any>(`/doctors/${id}/shares`, { method: 'POST', body: JSON.stringify({ serviceId, shareBp }) }),

  services: (all = false) => req<any[]>(`/services${all ? '?all=1' : ''}`),
  saveService: (b: any) => req<any>('/services', { method: 'POST', body: JSON.stringify(b) }),

  searchPatients: (q: string) => req<any[]>(`/patients/search?q=${encodeURIComponent(q)}`),
  checkDuplicates: (b: any) => req<any[]>('/patients/check-duplicates', { method: 'POST', body: JSON.stringify(b) }),
  registerPatient: (b: any) => req<any>('/patients', { method: 'POST', body: JSON.stringify(b) }),
  patient: (id: number) => req<any>(`/patients/${id}`),
  patientHistory: (id: number) => req<any[]>(`/patients/${id}/history`),

  queue: (doctorId?: number) => req<any[]>(`/visits/queue${doctorId ? `?doctor=${doctorId}` : ''}`),
  createVisit: (b: any) => req<any>('/visits', { method: 'POST', body: JSON.stringify(b) }),
  visit: (id: number) => req<any>(`/visits/${id}`),
  setVisitStatus: (id: number, status: string) =>
    req<any>(`/visits/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  markFeePaid: (id: number) => req<any>(`/visits/${id}/fee-paid`, { method: 'POST' }),

  prescription: (visitId: number) => req<any>(`/visits/${visitId}/prescription`),
  saveConsultation: (visitId: number, b: any) =>
    req<any>(`/visits/${visitId}/consultation`, { method: 'POST', body: JSON.stringify(b) }),

  /* -------------------------------------------------------------- chits */
  chits: (o: { status?: string; category?: string; q?: string; from?: string; to?: string } = {}) => {
    const p = new URLSearchParams()
    for (const k of ['status', 'category', 'q', 'from', 'to'] as const) {
      if (o[k]) p.set(k, String(o[k]))
    }
    return req<any[]>(`/chits?${p}`)
  },
  chit: (id: number) => req<any>(`/chits/${id}`),
  visitChits: (visitId: number) => req<{ chits: any[]; unbilled: any[] }>(`/visits/${visitId}/chits`),
  printChits: (visitId: number) => req<any[]>(`/visits/${visitId}/chits`, { method: 'POST' }),
  payChit: (id: number, payMethod = 'cash') =>
    req<any>(`/chits/${id}/pay`, { method: 'POST', body: JSON.stringify({ payMethod }) }),
  completeChit: (id: number, note?: string) =>
    req<any>(`/chits/${id}/complete`, { method: 'POST', body: JSON.stringify({ note }) }),

  /* ----------------------------------------------------------- settings */
  /* ------------------------------------------------------ counter till */
  draftForVisit: (visitId: number) => req<any>(`/counter/draft/visit/${visitId}`),
  draftForChit: (chitId: number) => req<any>(`/counter/draft/chit/${chitId}`),
  completeBill: (b: any) => req<any>('/counter/bills', { method: 'POST', body: JSON.stringify(b) }),
  directServiceVisit: (patientId: number, serviceIds: number[]) =>
    req<any>('/counter/direct', { method: 'POST',
      body: JSON.stringify({ patientId, serviceIds }) }),
  counterBills: (o: { q?: string; kind?: string; from?: string; to?: string } = {}) => {
    const p = new URLSearchParams()
    for (const k of ['q', 'kind', 'from', 'to'] as const) if (o[k]) p.set(k, String(o[k]))
    return req<{ rows: any[]; totals: any }>(`/counter/bills?${p}`)
  },
  counterBill: (id: number) => req<any>(`/counter/bills/${id}`),
  /* ------------------------------------------------------------- lab */
  labQueue: (o: { status?: string; q?: string; category?: string } = {}) => {
    const p = new URLSearchParams()
    for (const k of ['status', 'q', 'category'] as const) if (o[k]) p.set(k, String(o[k]))
    return req<any[]>(`/lab/queue?${p}`)
  },
  labStats: () => req<any>('/lab/stats'),
  collectSample: (serviceOrderId: number, sampleType: string | null) =>
    req<any>('/lab/collect', { method: 'POST',
      body: JSON.stringify({ serviceOrderId, sampleType }) }),
  /* ------------------------------------------- the rebuilt pharmacy */
  reportCatalogue: () => req<any[]>('/pharma/reports'),

  /* Every report the signed-in person may see, across all modules. */
  allReports: () => req<any[]>('/reports'),
  runAnyReport: (id: string, o: Record<string, string> = {}) =>
    req<any>(`/reports/run/${id}?${new URLSearchParams(o)}`),
  runReport: (id: string, o: Record<string, string> = {}) =>
    req<any>(`/pharma/reports/run/${id}?${new URLSearchParams(o)}`),

  pharmaSalts: (q = '') => req<any[]>(`/pharma/salts?q=${encodeURIComponent(q)}`),
  saltBrands: (id: number) => req<any[]>(`/pharma/salts/${id}/brands`),
  pharmaManufacturers: (q = '') => req<any[]>(`/pharma/manufacturers?q=${encodeURIComponent(q)}`),
  pharmaGroups: () => req<any[]>('/pharma/groups'),
  pharmaParties: (o: { q?: string; kind?: string } = {}) =>
    req<any[]>(`/pharma/parties?${new URLSearchParams(o as any)}`),
  createParty: (b: any) => req<any>('/pharma/parties', { method: 'POST', body: JSON.stringify(b) }),

  ledger: (kind: string, id: number, o: { from?: string; to?: string } = {}) =>
    req<any>(`/pharma/ledger/${kind}/${id}?${new URLSearchParams(o as any)}`),
  outstandingParties: (kind: string) => req<any[]>(`/pharma/outstanding/${kind}`),
  recordPayment: (b: any) => req<any>('/pharma/payments', { method: 'POST', body: JSON.stringify(b) }),

  repriceProduct: (id: number, b: any) =>
    req<any>(`/pharma/products/${id}/price`, { method: 'POST', body: JSON.stringify(b) }),

  pharmaPermissions: () => req<any[]>('/pharma/permissions'),
  pharmacyStaff: () => req<any[]>('/pharma/staff'),
  permissionsFor: (staffId: number) => req<any>(`/pharma/permissions/${staffId}`),
  savePermissions: (staffId: number, allowed: string[]) =>
    req<any>(`/pharma/permissions/${staffId}`, { method: 'PUT', body: JSON.stringify({ allowed }) }),

  lookupSaleForReturn: (invoiceNo: string) =>
    req<any>(`/pharma/returns/lookup?invoice=${encodeURIComponent(invoiceNo)}`),
  createReturn: (b: any) => req<any>('/pharma/returns', { method: 'POST', body: JSON.stringify(b) }),
  listReturns: (o: { from?: string; to?: string; q?: string } = {}) =>
    req<any[]>(`/pharma/returns?${new URLSearchParams(o as any)}`),

  /** One draw for every test this patient is waiting on. */
  collectVisit: (visitId: number, sampleType: string | null) =>
    req<any>('/lab/collect-visit', { method: 'POST',
      body: JSON.stringify({ visitId, sampleType }) }),
  visitWork: (visitId: number) => req<any[]>(`/lab/visits/${visitId}/work`),
  startTest: (labOrderId: number) =>
    req<any>(`/lab/orders/${labOrderId}/start`, { method: 'POST' }),
  saveLabResults: (labOrderId: number, values: any[], notes: string | null) =>
    req<any>(`/lab/orders/${labOrderId}/results`, { method: 'POST',
      body: JSON.stringify({ values, notes }) }),
  verifyResult: (labOrderId: number) =>
    req<any>(`/lab/orders/${labOrderId}/verify`, { method: 'POST' }),
  labReport: (labOrderId: number) => req<any>(`/lab/orders/${labOrderId}`),
  labFooter: () => req<any>('/lab/footer'),
  saveLabFooter: (b: any) => req<any>('/lab/footer', { method: 'PUT', body: JSON.stringify(b) }),

  serviceParameters: (serviceId: number) => req<any[]>(`/services/${serviceId}/parameters`),
  saveServiceParameters: (serviceId: number, parameters: any[]) =>
    req<any[]>(`/services/${serviceId}/parameters`, { method: 'PUT',
      body: JSON.stringify({ parameters }) }),
  serviceConsumables: (serviceId: number) => req<any[]>(`/services/${serviceId}/consumables`),
  saveServiceConsumables: (serviceId: number, consumables: any[]) =>
    req<any[]>(`/services/${serviceId}/consumables`, { method: 'PUT',
      body: JSON.stringify({ consumables }) }),

  /* ---------------------------------------------------------- stores */
  supplyItems: (o: { q?: string; filter?: string; category?: string } = {}) => {
    const p = new URLSearchParams()
    for (const k of ['q', 'filter', 'category'] as const) if (o[k]) p.set(k, String(o[k]))
    return req<any[]>(`/supplies/items?${p}`)
  },
  supplySummary: () => req<any>('/supplies/summary'),
  supplyCategories: () => req<string[]>('/supplies/categories'),
  createSupplyItem: (b: any) =>
    req<any>('/supplies/items', { method: 'POST', body: JSON.stringify(b) }),
  updateSupplyItem: (id: number, b: any) =>
    req<any>(`/supplies/items/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  archiveSupplyItem: (id: number) =>
    req<any>(`/supplies/items/${id}/archive`, { method: 'POST' }),
  receiveSupplies: (b: any) =>
    req<any>('/supplies/receive', { method: 'POST', body: JSON.stringify(b) }),
  issueSupply: (b: any) =>
    req<any>('/supplies/issue', { method: 'POST', body: JSON.stringify(b) }),
  wasteSupply: (b: any) =>
    req<any>('/supplies/waste', { method: 'POST', body: JSON.stringify(b) }),
  adjustSupply: (itemId: number, countedQty: number, reason: string) =>
    req<any>('/supplies/adjust', { method: 'POST',
      body: JSON.stringify({ itemId, countedQty, reason }) }),
  supplyMovements: (o: { item?: number; department?: number; kind?: string } = {}) => {
    const p = new URLSearchParams()
    for (const k of ['item', 'department', 'kind'] as const) if (o[k]) p.set(k, String(o[k]))
    return req<any[]>(`/supplies/movements?${p}`)
  },
  supplyReports: (days = 30) => req<any>(`/supplies/reports?days=${days}`),

  /* ------------------------------------------------------- emergency */
  ipdQueue: (all = false) => req<any[]>(`/ipd/queue${all ? '?all=1' : ''}`),
  createEmergencyVisit: (b: any) =>
    req<any>('/ipd/visits', { method: 'POST', body: JSON.stringify(b) }),
  addEmergencyMedicines: (visitId: number, items: any[]) =>
    req<any>(`/ipd/visits/${visitId}/medicines`, { method: 'POST', body: JSON.stringify({ items }) }),
  emergencyDues: (visitId: number) => req<any>(`/ipd/visits/${visitId}/dues`),
  closeEmergencyVisit: (visitId: number, outcome?: string) =>
    req<any>(`/ipd/visits/${visitId}/close`, { method: 'POST', body: JSON.stringify({ outcome }) }),

  abandonVisit: (visitId: number) => req<any>(`/visits/${visitId}/abandon`, { method: 'POST' }),
  deletePatient: (id: number) => req<any>(`/patients/${id}`, { method: 'DELETE' }),
  sendIn: (visitId: number) => req<any>(`/visits/${visitId}/send-in`, { method: 'POST' }),

  saveVitals: (visitId: number, b: any) =>
    req<any>(`/visits/${visitId}/vitals`, { method: 'PATCH', body: JSON.stringify(b) }),
  receptionOverview: (hours = 24) => req<any>(`/reception/overview?hours=${hours}`),
  modules: () => req<Record<string, boolean>>('/modules'),
  saveModules: (b: Record<string, boolean>) =>
    req<Record<string, boolean>>('/modules', { method: 'PUT', body: JSON.stringify(b) }),
  hospital: () => req<any>('/settings/hospital'),
  saveHospital: (b: any) => req<any>('/settings/hospital', { method: 'PUT', body: JSON.stringify(b) }),
  backups: () => req<any[]>('/admin/backups'),
  runBackup: () => req<any>('/admin/backups', { method: 'POST' }),

  /* -------------------------------------------------- patient directory */
  patients: (bucket: string, q = '') =>
    req<{ rows: any[]; counts: any }>(`/patients?bucket=${bucket}&q=${encodeURIComponent(q)}`),
  updatePatient: (id: number, b: any) =>
    req<any>(`/patients/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  earningsByPatient: (from: string, to: string) =>
    req<any[]>(`/me/earnings/by-patient?from=${from}&to=${to}`),

  pharmacyQueue: (q?: string) =>
    req<any[]>(`/pharmacy/prescriptions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  productSearch: (q: string) => req<SearchHit[]>(`/products/search?q=${encodeURIComponent(q)}`),

  myEarnings: (from: string, to: string, doctorId?: number) =>
    req<any>(`/earnings/me?from=${from}&to=${to}${doctorId ? `&doctor=${doctorId}` : ''}`),
  allEarnings: (from: string, to: string) => req<any[]>(`/earnings/all?from=${from}&to=${to}`),
  statsToday: () => req<any>('/stats/today'),
  demoStatus: () => req<{ hasData: boolean }>('/admin/demo-status'),
  loadDemoData: (reset: boolean, days = 45) =>
    req<any>('/admin/demo-data', { method: 'POST', body: JSON.stringify({ reset, days }) })
}

/** Paisa to a grouped rupee string. Never do arithmetic on the display value. */
export function rs(paisa: number | string | null | undefined): string {
  const n = Number(paisa ?? 0)
  const neg = n < 0
  const abs = Math.abs(n)
  return `${neg ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-PK')}.${String(abs % 100).padStart(2, '0')}`
}

/** "1500" or "1500.50" typed by a human, back to integer paisa. */
export function toPaisa(input: string): number {
  const clean = String(input).replace(/[^0-9.]/g, '')
  if (!clean) return 0
  const [w, f = ''] = clean.split('.')
  return Number(w || 0) * 100 + Number((f + '00').slice(0, 2))
}

export const bpToPct = (bp: number) => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)
export const pctToBp = (pct: string) => Math.round((Number(pct) || 0) * 100)
export const today = () => new Date().toISOString().slice(0, 10)

/** Whole days from today to a yyyy-mm-dd date. Negative once it has passed. */
export function daysUntil(date: string): number {
  const then = new Date(date + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((then.getTime() - now.getTime()) / 86400000)
}

export const shortDate = (date: string) =>
  new Date(date + 'T00:00:00').toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: '2-digit' })

/**
 * A unique key for a list row.
 *
 * Not `crypto.randomUUID()`. That function only exists in a secure context,
 * which means HTTPS or localhost. This system is served over plain HTTP on a
 * LAN address, so on every machine except the server itself the function is
 * simply not there and calling it throws — a white screen the moment someone
 * adds a line to a delivery note or an emergency medicine list. It worked in
 * testing precisely because testing happens on localhost.
 *
 * These ids never leave the browser; they exist to give React a stable key,
 * so a counter plus a random suffix is more than enough.
 */
let idSeq = 0
export function newId(): string {
  idSeq += 1
  return `${Date.now().toString(36)}-${idSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Open a server-generated document.
 *
 * The browser fetches the URL itself, so it cannot send the Authorization
 * header the session lives in. It gets a one-minute ticket instead, bound to
 * this one path and to the signed-in user.
 *
 * An earlier version fetched the file and handed over a blob URL. That fails
 * in a way worth remembering: the object URL is released when the dialog
 * closes, so a download still in flight or a print job still reading gets a
 * truncated file — "failed to load PDF" on a file of the right size. A real
 * URL and the browser's own viewer avoid the whole problem, and printing
 * works because it is a normal page rather than an iframe holding a blob.
 *
 * The tab is opened before the request, not after: a window.open that happens
 * after an await is a popup as far as the browser is concerned, and gets
 * blocked.
 */
export async function openDocument(path: string): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    /**
     * The ticket is issued against the path alone.
     *
     * A report URL carries its date window in the query string, and sending
     * the whole thing as the path makes the server refuse it — a ticket is
     * bound to a document, not to one set of filters.
     */
    const [pathname, query] = path.split('?')
    const { ticket } = await req<{ ticket: string }>('/tickets', {
      method: 'POST', body: JSON.stringify({ path: pathname })
    })
    const url = `/api${pathname}?${query ? query + '&' : ''}ticket=${encodeURIComponent(ticket)}`
    if (tab) tab.location.href = url
    else window.location.href = url   // popup blocked: use this tab instead
  } catch (e) {
    tab?.close()
    throw e
  }
}
