using System;
using System.Collections.Generic;
using System.Text;
using HmsAttendance;

/*
 * Run with test-protocol.bat, after the protocol checks in ProtoTest.
 *
 * Two things, neither of which needs hardware to be WRONG, and neither of
 * which this can prove RIGHT on hardware:
 *
 *   1. What the agent does with each capture from a USB reader: when it
 *      takes an enrolment press, when it retries, when it says "not
 *      recognised", when it posts a punch. The matching library is replaced
 *      by a fake, so this tests the agent's decisions and not ZKTeco's
 *      matcher.
 *
 *   2. Creating a user on a terminal, against the fake K50: the bytes go out
 *      in the layout the reference implementation uses, a user already there
 *      is never written over, and nothing is called created until it has
 *      been read back.
 *
 * A pass here says the agent behaves as designed against a device that
 * behaves as the reference implementation describes. It does not say a real
 * K50 or Live20R behaves that way. Only the hardware can.
 */
internal static class AgentTest
{
    private static void Ok(string n, bool c, string x = "") { ProtoTest.Ok(n, c, x); }

    /* ================================================= a fake matcher */

    /*
     * A "template" here is three bytes: which finger, how good the capture
     * was, and which placement it came from. Good enough to tell the agent's
     * decisions apart; nothing like a real template.
     */
    private static byte[] T(int finger, int quality, int placement)
    {
        return new byte[] { (byte)finger, (byte)quality, (byte)placement };
    }

    private class FakeOps : IFingerOps
    {
        /* fid -> finger */
        public readonly Dictionary<int, int> Enrolled = new Dictionary<int, int>();
        public readonly List<byte[][]> Merged = new List<byte[][]>();
        public bool FailMerge;
        public bool RejectOwnCaptures;
        public int Identifies;

        public bool Identify(byte[] t, out int fid, out int score)
        {
            Identifies++;
            fid = 0; score = 0;
            /* A capture taken as the finger landed is too poor to match. */
            if (t[1] < 50) return false;
            foreach (KeyValuePair<int, int> kv in Enrolled)
            {
                if (kv.Value == t[0]) { fid = kv.Key; score = 80; return true; }
            }
            return false;
        }

        public bool Same(byte[] a, byte[] b)
        {
            if (RejectOwnCaptures && a.Length > 3) return false;
            return a[0] == b[0];
        }

        public byte[] Merge(byte[] a, byte[] b, byte[] c, out string why)
        {
            Merged.Add(new byte[][] { a, b, c });
            if (FailMerge) { why = "the three captures were not the same finger"; return null; }
            why = "";
            /* Longer than a capture, so Same() can tell a merged one apart. */
            return new byte[] { a[0], 100, a[2], b[2], c[2] };
        }

        public void Store(int fid, byte[] registered) { Enrolled[fid] = registered[0]; }
    }

    private static readonly byte[] NONE = null;
    private const int EMPTY = Zk.ERR_CAPTURE;

    /* Feed n captures of the same thing; return the outcomes. */
    private static List<Outcome> Hold(ReaderLogic l, byte[] t, int n, DateTime at)
    {
        List<Outcome> got = new List<Outcome>();
        for (int i = 0; i < n; i++) got.Add(l.OnCapture(Zk.OK, t, at).Outcome);
        return got;
    }

    private static void Lift(ReaderLogic l)
    {
        for (int i = 0; i < FingerGate.LIFT_READS; i++) l.OnCapture(EMPTY, NONE, DateTime.Now);
    }

    private static int Count(List<Outcome> list, Outcome o)
    {
        int n = 0;
        foreach (Outcome x in list) if (x == o) n++;
        return n;
    }

    public static void Run()
    {
        Enrolment();
        Identification();
        TerminalUsers();
        Names();
    }

    /* ======================================================= enrolment */

    private static void Enrolment()
    {
        Console.WriteLine("\n- enrolment takes three SEPARATE presses -");

        FakeOps ops = new FakeOps();
        ReaderLogic l = new ReaderLogic(ops);
        DateTime now = new DateTime(2026, 10, 16, 9, 0, 0);

        l.StartEnrolment(12, 1);
        /* The glass is empty when the button is clicked. */
        Lift(l);

        /*
         * THE BUG. A finger held on the glass for two seconds is twenty
         * captures. The old code took one, slept 900 ms and took the next, so
         * all three "presses" were one placement.
         */
        List<Outcome> held = Hold(l, T(5, 90, 1), 20, now);
        Ok("a finger held down gives ONE press, not three",
            l.Enrolling != null && l.Enrolling.Captures.Count == 1,
            l.Enrolling == null ? "finished" : l.Enrolling.Captures.Count.ToString());
        Ok("and the rest of that hold is only waiting",
            Count(held, Outcome.Waiting) == 19, Count(held, Outcome.Waiting).ToString());
        Ok("the screen is told to lift the finger",
            l.Enrolling.Message.IndexOf("Lift", StringComparison.Ordinal) >= 0, l.Enrolling.Message);

        /* One empty frame is a finger rocking, not lifted. */
        l.OnCapture(EMPTY, NONE, now);
        Hold(l, T(5, 90, 1), 3, now);
        Ok("a single empty frame does not count as lifting",
            l.Enrolling.Captures.Count == 1, l.Enrolling.Captures.Count.ToString());

        Lift(l);
        Hold(l, T(5, 90, 2), 10, now);
        Ok("after a real lift, the next press is taken",
            l.Enrolling.Captures.Count == 2, l.Enrolling.Captures.Count.ToString());

        Lift(l);
        Outcome last = l.OnCapture(Zk.OK, T(5, 90, 3), now).Outcome;
        Ok("the third press finishes it", last == Outcome.EnrolDone, last.ToString());
        Ok("with a template the screen can save",
            l.LastEnrolment != null && l.LastEnrolment.Done && l.LastEnrolment.Template != null);
        Ok("and the finger is live for matching straight away",
            ops.Enrolled.ContainsKey(Fid.Make(12, 1)));

        byte[][] m = ops.Merged[ops.Merged.Count - 1];
        Ok("the three merged captures came from three different placements",
            m[0][2] != m[1][2] && m[1][2] != m[2][2] && m[0][2] != m[2][2],
            m[0][2] + "," + m[1][2] + "," + m[2][2]);

        Console.WriteLine("\n- enrolment refuses what would make a bad template -");

        /* A finger already resting when Enrol was clicked is not a press. */
        l.StartEnrolment(13, 1);
        Hold(l, T(6, 90, 1), 5, now);
        Ok("a finger already on the glass at the start is not taken",
            l.Enrolling.Captures.Count == 0, l.Enrolling.Captures.Count.ToString());
        Lift(l);
        l.OnCapture(Zk.OK, T(6, 90, 2), now);
        Lift(l);
        Outcome diff = l.OnCapture(Zk.OK, T(9, 90, 3), now).Outcome;
        Ok("a different finger is refused", diff == Outcome.EnrolDifferent, diff.ToString());
        Ok("and not counted", l.Enrolling.Captures.Count == 1, l.Enrolling.Captures.Count.ToString());
        l.CancelEnrolment();

        ops.FailMerge = true;
        l.StartEnrolment(14, 1);
        for (int p = 1; p <= 3; p++) { Lift(l); l.OnCapture(Zk.OK, T(7, 90, p), now); }
        Ok("a merge the SDK refuses fails the enrolment, saying so",
            l.LastEnrolment != null && l.LastEnrolment.Failed && l.Enrolling == null,
            l.LastEnrolment == null ? "no result" : l.LastEnrolment.Message);
        Ok("and stores nothing", !ops.Enrolled.ContainsKey(Fid.Make(14, 1)));
        ops.FailMerge = false;

        /*
         * The template must recognise the presses it was made from. Checked
         * at the desk, so a weak enrolment fails in front of the person
         * enrolling rather than at the door a week later.
         */
        ops.RejectOwnCaptures = true;
        l.StartEnrolment(15, 1);
        for (int p = 1; p <= 3; p++) { Lift(l); l.OnCapture(Zk.OK, T(8, 90, p), now); }
        Ok("a merged template that does not match its own presses is refused",
            l.LastEnrolment != null && l.LastEnrolment.Failed
            && !ops.Enrolled.ContainsKey(Fid.Make(15, 1)));
        ops.RejectOwnCaptures = false;
    }

    /* =================================================== at the door */

    private static void Identification()
    {
        Console.WriteLine("\n- at the door: one press, one punch -");

        FakeOps ops = new FakeOps();
        ops.Enrolled[Fid.Make(21, 1)] = 4;          // staff 21's finger is "4"
        ReaderLogic l = new ReaderLogic(ops);
        DateTime t0 = new DateTime(2026, 10, 16, 8, 55, 0);
        Lift(l);

        List<Outcome> press = Hold(l, T(4, 90, 1), 25, t0);
        Ok("a good finger matches on the first capture", press[0] == Outcome.Matched,
            press[0].ToString());
        Ok("and a long press does not become more punches",
            Count(press, Outcome.Matched) == 1, Count(press, Outcome.Matched).ToString());
        Ok("the reader stops matching until the finger lifts",
            ops.Identifies == 1, ops.Identifies + " identifications");

        Lift(l);
        Outcome again = l.OnCapture(Zk.OK, T(4, 90, 2), t0.AddSeconds(3)).Outcome;
        Ok("pressing again three seconds later is a repeat, not a punch",
            again == Outcome.Repeat, again.ToString());

        Lift(l);
        Outcome later = l.OnCapture(Zk.OK, T(4, 90, 3), t0.AddSeconds(20)).Outcome;
        Ok("twenty seconds later it counts again (the server decides if it is too soon)",
            later == Outcome.Matched, later.ToString());

        Console.WriteLine("\n- a press that lands badly is retried, not failed -");
        /*
         * The first frame of a press is often the finger still landing. That
         * used to be "not recognised", a 600 ms pause, and a person pressing
         * again. Now the next frames of the SAME press are tried.
         */
        Lift(l);
        DateTime t1 = t0.AddMinutes(10);
        Outcome a = l.OnCapture(Zk.OK, T(4, 20, 4), t1).Outcome;     // landing
        Outcome b = l.OnCapture(Zk.OK, T(4, 90, 4), t1).Outcome;     // settled
        Ok("a poor first frame is retried", a == Outcome.Retrying, a.ToString());
        Ok("and the settled frame of the same press matches", b == Outcome.Matched, b.ToString());

        Console.WriteLine("\n- a finger that is not enrolled -");
        Lift(l);
        List<Outcome> stranger = Hold(l, T(99, 90, 1), 10, t1);
        Ok("is tried three times on one press",
            Count(stranger, Outcome.Retrying) == ReaderLogic.MAX_ATTEMPTS - 1,
            Count(stranger, Outcome.Retrying).ToString());
        Ok("then reported once as not recognised",
            Count(stranger, Outcome.NotRecognised) == 1);
        Ok("and NEVER matched — nothing is accepted without a match",
            Count(stranger, Outcome.Matched) == 0 && Count(stranger, Outcome.Repeat) == 0);
        Ok("and then waits for the finger to lift rather than failing again and again",
            Count(stranger, Outcome.Waiting) == 10 - ReaderLogic.MAX_ATTEMPTS);

        Lift(l);
        Outcome after = l.OnCapture(Zk.OK, T(4, 90, 5), t1.AddMinutes(1)).Outcome;
        Ok("after lifting, the next person is matched as normal",
            after == Outcome.Matched, after.ToString());

        Console.WriteLine("\n- a print the SDK cannot read -");
        Lift(l);
        List<Outcome> smudge = new List<Outcome>();
        for (int i = 0; i < 5; i++)
            smudge.Add(l.OnCapture(Zk.ERR_EXTRACT_FP, NONE, t1).Outcome);
        Ok("is retried, then reported as unreadable once",
            Count(smudge, Outcome.Unreadable) == 1 && Count(smudge, Outcome.Matched) == 0);

        Lift(l);
        Outcome busy = l.OnCapture(Zk.ERR_BUSY, NONE, t1).Outcome;
        Ok("a busy reader is not taken for a finger", busy == Outcome.Nothing, busy.ToString());

        /* No identification at all while somebody is enrolling at this reader. */
        int before = ops.Identifies;
        l.StartEnrolment(30, 1);
        Lift(l);
        l.OnCapture(Zk.OK, T(4, 90, 6), t1);
        Ok("while enrolling, a press is an enrolment press and never a punch",
            ops.Identifies == before && l.Enrolling != null && l.Enrolling.Captures.Count == 1);
        l.CancelEnrolment();
    }

    /* ====================================================== the terminal */

    private static void TerminalUsers()
    {
        Console.WriteLine("\n- creating a user on the terminal -");

        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 5))
        {
            t.Connect();

            UserSyncResult r = t.EnsureUser("15", "Nadia Aslam");
            Ok("a new id is created", r.Code == "CREATED", r.Code + " " + r.Message);
            Ok("with one write", dev.Writes == 1, dev.Writes.ToString());
            FakeDevice.FakeUser made = dev.Users.Find(delegate (FakeDevice.FakeUser u) { return u.UserId == "15"; });
            Ok("the device holds the id and the name",
                made != null && made.Name == "Nadia Aslam", made == null ? "missing" : made.Name);
            Ok("in a fresh internal slot, after the highest in use",
                made != null && made.Uid == 8, made == null ? "" : made.Uid.ToString());
            Ok("and the result names what the device holds", r.DeviceName == "Nadia Aslam");

            /* Pressing it again, or the agent retrying after a lost reply. */
            UserSyncResult again = t.EnsureUser("15", "Nadia Aslam");
            Ok("doing it again finds the user instead of creating a second",
                again.Code == "ALREADY_PRESENT", again.Code);
            Ok("and writes nothing", dev.Writes == 1, dev.Writes.ToString());
            Ok("still exactly one user 15",
                dev.Users.FindAll(delegate (FakeDevice.FakeUser u) { return u.UserId == "15"; }).Count == 1);

            /* Somebody already enrolled on the device, unrelated to HMS. */
            UserSyncResult clash = t.EnsureUser("7", "Hina Butt");
            Ok("an id already taken on the device is reported, not overwritten",
                clash.Code == "ALREADY_PRESENT" && clash.DeviceName == "Saleem",
                clash.Code + " " + clash.DeviceName);
            Ok("nothing was written for it", dev.Writes == 1, dev.Writes.ToString());
            Ok("and the person on the device is still who they were",
                dev.Users.Find(delegate (FakeDevice.FakeUser u) { return u.UserId == "7"; }).Name == "Saleem");

            UserSyncResult bad = t.EnsureUser("12a", "Somebody");
            Ok("an id the device cannot hold is refused before anything is sent",
                bad.Code == "DEVICE_ERROR" && dev.Writes == 1, bad.Code);

            /* The connection must still be in step for the punch read after. */
            List<TerminalPunch> punches = t.GetAttendance(t.GetUsers());
            Ok("the punch log still reads afterwards on the same connection",
                punches.Count == 3, punches.Count.ToString());
        }

        Console.WriteLine("\n- when the terminal says no, or lies, or goes quiet -");

        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 5))
        {
            dev.RefuseWrites = true;
            t.Connect();
            UserSyncResult r = t.EnsureUserSafely("16", "Refused Person");
            Ok("a refused write is an error, not a success", r.Code == "DEVICE_ERROR", r.Code);
            Ok("and leaves the connection usable", t.Broken == null, t.Broken ?? "");
            dev.RefuseWrites = false;
            UserSyncResult next = t.EnsureUserSafely("17", "Next Person");
            Ok("so the next job on it goes through", next.Code == "CREATED", next.Code + " " + next.Message);
        }

        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 5))
        {
            dev.IgnoreWrites = true;
            t.Connect();
            UserSyncResult r = t.EnsureUserSafely("18", "Vanished Person");
            Ok("a device that says ok but does not keep the user is NOT reported as created",
                r.Code == "VERIFY_FAILED", r.Code);
        }

        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 5))
        {
            dev.UserCapacity = 58;   // the counters already say 58 users
            t.Connect();
            UserSyncResult r = t.EnsureUserSafely("19", "One Too Many");
            Ok("a full device is reported as full, and nothing is sent",
                r.Code == "DEVICE_FULL" && dev.Writes == 0, r.Code + " writes " + dev.Writes);
        }

        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 2))
        {
            dev.SilentOnWrite = true;
            t.Connect();
            DateTime started = DateTime.Now;
            UserSyncResult r = t.EnsureUserSafely("20", "Timed Out");
            Ok("a device that stops answering is a timeout, not a hang",
                r.Code == "DEVICE_ERROR" && (DateTime.Now - started).TotalSeconds < 10,
                r.Code + " after " + (int)(DateTime.Now - started).TotalSeconds + "s: " + r.Message);
            Ok("and says it timed out", r.Message.IndexOf("timed out", StringComparison.Ordinal) >= 0,
                r.Message);
            UserSyncResult next = t.EnsureUserSafely("21", "Not Tried");
            Ok("the rest of the jobs are not tried on a connection in doubt",
                next.Code == "DEVICE_ERROR" && dev.Writes == 1,
                next.Code + " writes " + dev.Writes + ": " + next.Message);
        }

        /* Nothing listening at all. */
        try
        {
            using (Terminal t = new Terminal("127.0.0.1", 1, "0", 2)) { t.Connect(); }
            Ok("connecting to nothing fails", false);
        }
        catch (Exception e)
        {
            string why = Terminal.DescribeFailure(e);
            Ok("connecting to nothing gives a reason HMS can show", why.Length > 0, why);
        }

        Console.WriteLine("\n- the older 28-byte user record -");
        using (FakeDevice dev = new FakeDevice())
        using (Terminal t = new Terminal("127.0.0.1", dev.Port, "0", 5))
        {
            dev.UserLayout = 28;
            t.Connect();
            List<TerminalUser> before = t.GetUsers();
            Ok("names are read from the right place in the record",
                before.Count == 2 && before[0].Name == "Yasir",
                before.Count > 0 ? "\"" + before[0].Name + "\"" : "none");

            UserSyncResult r = t.EnsureUser("22", "Muhammad Ali");
            Ok("a user is created in that layout", r.Code == "CREATED", r.Code + " " + r.Message);
            Ok("with the name cut to the eight bytes it holds",
                r.ExpectedName == "Muhammad" && r.DeviceName == "Muhammad",
                r.ExpectedName + " / " + r.DeviceName);
        }
    }

    /* ========================================================= names */

    private static void Names()
    {
        Console.WriteLine("\n- names cut to fit the device -");
        string longName = "Dr Muhammad Abdullah Khan Niazi";
        string fit = Terminal.FitName(longName, 24);
        Ok("an English name is cut to 24 bytes",
            Encoding.UTF8.GetByteCount(fit) <= 24 && longName.StartsWith(fit), fit);

        /* Two bytes a letter: a cut in the middle of one would write rubbish. */
        string urdu = "محمد علی خان نیازی";
        string cut = Terminal.FitName(urdu, 24);
        Ok("an Urdu name is never cut through a letter",
            Encoding.UTF8.GetByteCount(cut) <= 24 && urdu.StartsWith(cut) && cut.IndexOf('�') < 0,
            Encoding.UTF8.GetByteCount(cut) + " bytes");

        Ok("ids: digits up to nine", Terminal.IsDeviceId("15") && Terminal.IsDeviceId("123456789"));
        Ok("ids: not ten digits, not letters, not all zeros",
            !Terminal.IsDeviceId("1234567890") && !Terminal.IsDeviceId("E-17")
            && !Terminal.IsDeviceId("000") && !Terminal.IsDeviceId(""));
    }
}
