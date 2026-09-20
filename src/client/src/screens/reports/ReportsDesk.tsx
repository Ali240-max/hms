import type { SessionUser } from '../../lib/api'
import { Reports } from '../pharma/Reports'

/**
 * The reports desk.
 *
 * Its own sign-in with nothing but reports behind it. Hospitals here have an
 * accounts person asked for figures from every department; giving them an
 * administrator account so they can pull a number is how prices quietly
 * change. This role reads everything and alters nothing.
 *
 * No rail of its own: the reports screen already lists every report down the
 * left, and wrapping one list in another would be a rail leading to a rail.
 */
export function ReportsDesk({ me }: { me: SessionUser }) {
  return <Reports me={me} />
}
