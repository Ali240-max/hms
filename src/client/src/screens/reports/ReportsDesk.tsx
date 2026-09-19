import type { SessionUser } from '../../lib/api'
import { Reports } from '../pharma/Reports'

/**
 * The reports desk.
 *
 * Its own sign-in, with nothing but reports behind it. Hospitals here have an
 * accounts person who is asked for figures from every department; giving them
 * an administrator account so they can pull a number is how prices quietly
 * change. This role can read everything and alter nothing.
 *
 * The screen itself is the same one each module shows — the server decides
 * which reports appear, so there is one implementation rather than five that
 * drift apart.
 */
export function ReportsDesk({ me }: { me: SessionUser }) {
  return <Reports me={me} />
}
