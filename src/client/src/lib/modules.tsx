import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'

/**
 * Which modules this hospital is using.
 *
 * Fetched once and shared, so a screen can hide a button that leads somewhere
 * the hospital has not bought yet — "Send to doctor" when there is no doctor
 * terminal, for instance.
 *
 * Nothing here is a permission. The server does not refuse a request because
 * a module is switched off, and it should not: the data stays valid, the
 * module can be switched on next month, and a hospital that turns the doctor
 * terminal on in March must find its January visits exactly where they were.
 * This only decides what is worth showing.
 *
 * A module covers the work that module does, not everything touching it. With
 * the doctor terminal off the counter still books appointments against a
 * doctor and still takes the fee — what stops is the consultation, the
 * prescribing and the handing over from the OPD desk. That is the part the
 * hospital has not started using yet, and hiding the booking as well would
 * have stopped them selling an appointment at all.
 */
export type Modules = {
  doctor: boolean
  opdCounter: boolean
  pharmacy: boolean
  laboratory: boolean
  radiology: boolean
  emergency: boolean
  stores: boolean
}

const ALL_ON: Modules = {
  doctor: true, opdCounter: true, pharmacy: true, laboratory: true,
  radiology: true, emergency: true, stores: true
}

const Ctx = createContext<Modules>(ALL_ON)

export function ModulesProvider({ children }: { children: ReactNode }) {
  const [m, setM] = useState<Modules>(ALL_ON)
  useEffect(() => {
    // A failed read leaves everything on. Hiding a module the hospital is
    // actually using would look like the system had lost a feature.
    api.modules().then((r) => setM({ ...ALL_ON, ...(r as any) })).catch(() => {})
  }, [])
  return <Ctx.Provider value={m}>{children}</Ctx.Provider>
}

export const useModules = () => useContext(Ctx)
