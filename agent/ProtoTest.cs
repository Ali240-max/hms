using System;
using System.Reflection;

/*
 * Run this with test-protocol.bat.
 *
 * It is not part of the agent. It is compiled into its own executable
 * alongside the agent's source, exercises the arithmetic the ZKTeco
 * protocol depends on, and posts nothing and connects to nothing.
 *
 * Worth running after any change to Terminal.cs, and worth running once
 * before trusting a new build, because the two things it checks are the two
 * that fail silently: a wrong checksum means the device ignores every packet
 * without complaint, and a wrong field offset means dates that look like
 * dates and are wrong by months.
 *
 * The expected values were produced by running the reference implementation
 * (pyzk, which is what everybody else's integration is built on), not from
 * anybody's memory of the specification. The first draft of this file
 * asserted the connect checksum was 0xFC17 from recollection; the real
 * answer is 0xFC16, because the reference folds with minus 65535 rather
 * than minus 65536.
 */

/*
 * The two pieces of the protocol that are pure arithmetic, checked against
 * the reference implementation's own numbers.
 *
 * I have no K50 here. The handshake cannot be tested without one. But the
 * checksum and the time decode are functions of their input, and getting
 * either wrong produces a device that refuses every packet or dates that
 * look plausible and are wrong — the two hardest failures to diagnose over
 * a phone. Both are testable without hardware, so both are tested.
 */
internal static class ProtoTest
{
    private static int pass = 0, fail = 0;
    internal static void Ok(string n, bool c, string x = "")
    {
        if (c) { pass++; Console.WriteLine("  ok   " + n); }
        else { fail++; Console.WriteLine("  FAIL " + n + (x.Length > 0 ? " - " + x : "")); }
    }

    private static string Hex(byte[] b) { return BitConverter.ToString(b); }

    private static byte[] FromHex(string h)
    {
        byte[] b = new byte[h.Length / 2];
        for (int i = 0; i < b.Length; i++)
            b[i] = Convert.ToByte(h.Substring(i * 2, 2), 16);
        return b;
    }

    private static MethodInfo M(string name)
    {
        Type t = typeof(HmsAttendance.Terminal);
        return t.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static);
    }

    public static int Main()
    {
        Console.WriteLine("\n- the checksum -");
        MethodInfo cs = M("Checksum");
        Ok("the method is there", cs != null);

        /*
         * FOUR VECTORS, COMPUTED BY RUNNING THE REFERENCE ALGORITHM, not
         * recalled.
         *
         * My first attempt at this test asserted 0xFC17 for the connect
         * packet from memory. The C# said 0xFC16 and the C# was right - the
         * reference folds with `- 65535` rather than `- 65536`, which is off
         * by one from the ordinary ones-complement sum anybody would write
         * from the description. A wrong checksum means the device silently
         * ignores every packet, so getting this from the real algorithm
         * rather than from recollection is the difference between working
         * tonight and an evening with a packet sniffer.
         */
        /*
         * NOTE: this is the checksum FUNCTION on a packet carrying reply id
         * 65535. It is not the connect packet a device is sent — that one
         * carries reply id 0 and checksums to 0xFC17, because the checksum
         * is taken before the counter moves. Both numbers are right and they
         * are testing different things; the real packet is pinned whole
         * further down, under "the exact bytes on the wire".
         */
        byte[] connect = new byte[8];
        connect[0] = 0xE8; connect[1] = 0x03;   // CMD_CONNECT 1000
        connect[2] = 0x00; connect[3] = 0x00;   // checksum field, zeroed
        connect[4] = 0x00; connect[5] = 0x00;   // session 0
        connect[6] = 0xFF; connect[7] = 0xFF;   // reply 65535
        ushort sum = (ushort)cs.Invoke(null, new object[] { connect });
        Ok("the checksum of an 8-byte header with reply 65535 is 0xFC16",
            sum == 0xFC16, "got 0x" + sum.ToString("X4"));

        byte[] attlog = new byte[] { 0x0D, 0x00, 0, 0, 0x34, 0x12, 0x00, 0x00 };
        ushort s2 = (ushort)cs.Invoke(null, new object[] { attlog });
        Ok("CMD_ATTLOG_RRQ with a session checksums to 0xEDBD", s2 == 0xEDBD,
            "got 0x" + s2.ToString("X4"));

        /* Odd length: the trailing byte is added, not dropped. */
        byte[] odd = new byte[9];
        odd[0] = 0x0D; odd[8] = 0x7F;
        ushort s3 = (ushort)cs.Invoke(null, new object[] { odd });
        Ok("a nine-byte payload checksums to 0xFF72", s3 == 0xFF72,
            "got 0x" + s3.ToString("X4"));

        /* A buffered-read request, header plus its eleven bytes of data. */
        byte[] wrrq = new byte[] {
            0xDF, 0x05, 0, 0, 0x01, 0x00, 0x02, 0x00,
            1, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
        ushort s4 = (ushort)cs.Invoke(null, new object[] { wrrq });
        Ok("a buffered-read request checksums to 0xED1B", s4 == 0xED1B,
            "got 0x" + s4.ToString("X4"));

        Console.WriteLine("\n- the device clock -");
        MethodInfo dec = M("DecodeTime");
        MethodInfo enc = M("EncodeTime");
        Ok("both are there", dec != null && enc != null);

        /*
         * The format counts 31 days to a month and 12 months to a year from
         * 2000. So the counter for 2000-01-01 00:00:00 is zero, and every
         * other value follows from the arithmetic rather than from a
         * calendar.
         */
        DateTime zero = (DateTime)dec.Invoke(null, new object[] { (uint)0 });
        Ok("zero is the first second of 2000",
            zero == new DateTime(2000, 1, 1, 0, 0, 0), zero.ToString("u"));

        Ok("one second later", (DateTime)dec.Invoke(null, new object[] { (uint)1 })
            == new DateTime(2000, 1, 1, 0, 0, 1));
        Ok("one day later is the 2nd",
            (DateTime)dec.Invoke(null, new object[] { (uint)86400 })
            == new DateTime(2000, 1, 2, 0, 0, 0));
        /* 31 days of seconds is the start of February, because 31-day months. */
        Ok("31 days later is 1 February",
            (DateTime)dec.Invoke(null, new object[] { (uint)(86400 * 31) })
            == new DateTime(2000, 2, 1, 0, 0, 0));
        Ok("12 months of 31 days later is 1 January 2001",
            (DateTime)dec.Invoke(null, new object[] { (uint)(86400 * 31 * 12) })
            == new DateTime(2001, 1, 1, 0, 0, 0));

        /*
         * The round trip, which is what actually matters: a time encoded and
         * decoded must come back unchanged, or --set-time moves the device's
         * clock to the wrong moment.
         */
        DateTime[] cases = new DateTime[] {
            new DateTime(2026, 10, 10, 9, 14, 33),
            new DateTime(2026, 1, 1, 0, 0, 0),
            new DateTime(2026, 12, 31, 23, 59, 59),
            new DateTime(2025, 2, 28, 7, 5, 1),
            new DateTime(2030, 6, 15, 18, 45, 12)
        };
        bool allRound = true;
        foreach (DateTime d in cases)
        {
            uint v = (uint)enc.Invoke(null, new object[] { d });
            DateTime back = (DateTime)dec.Invoke(null, new object[] { v });
            if (back != d) { allRound = false; Console.WriteLine("       " + d.ToString("u") + " -> " + back.ToString("u")); }
        }
        Ok("every time survives encode and decode unchanged", allRound);

        /*
         * An empty or corrupt slot must not decode to a believable date.
         * 0xFFFFFFFF is what a blank record reads as, and posting a punch
         * dated in 2136 would be stored exactly as given.
         */
        DateTime far = (DateTime)dec.Invoke(null, new object[] { uint.MaxValue });
        Ok("a blank record decodes outside the range the agent accepts",
            far.Year < 2015 || far.Year > 2100, far.ToString("u"));

        Console.WriteLine("\n- the comm key -");
        MethodInfo mk = M("MakeCommKey");
        Ok("it is there", mk != null);
        byte[] k0 = (byte[])mk.Invoke(null, new object[] { "0", (ushort)0 });
        Ok("it is always four bytes", k0.Length == 4, k0.Length.ToString());
        byte[] k1 = (byte[])mk.Invoke(null, new object[] { "0", (ushort)1234 });
        Ok("the session changes it, so a captured key cannot be replayed",
            BitConverter.ToString(k0) != BitConverter.ToString(k1));
        byte[] k2 = (byte[])mk.Invoke(null, new object[] { "123456", (ushort)1234 });
        Ok("and the key itself changes it",
            BitConverter.ToString(k1) != BitConverter.ToString(k2));
        /* The third byte is the tick constant, unmasked, in every variant. */
        Ok("the tick byte is where the SDK puts it", k0[2] == 50 && k1[2] == 50 && k2[2] == 50);

        /*
         * AGAINST THE REFERENCE'S OWN OUTPUT, for three inputs.
         *
         * A wrong comm key is answered with "unauthenticated" and nothing
         * else, on a device whose menu offers no clue, so this is worth
         * pinning exactly rather than testing that it merely varies.
         */
        Ok("no key, session 0 matches the reference",
            Hex(k0) == "61-7D-32-79", Hex(k0));
        Ok("no key, session 1234 matches the reference",
            Hex(k1) == "61-7D-32-7D", Hex(k1));
        Ok("key 123456, session 1234 matches the reference",
            Hex(k2) == "26-7F-32-FD", Hex(k2));

        Console.WriteLine("\n- an attendance record off the wire -");
        /*
         * A real 40-byte record, built by the reference's own packing:
         * uid 7, user id "0042", status 1, 2026-10-10 09:14:33, punch 0.
         *
         * This is the layout where a mistake is most expensive, because
         * status sits BEFORE the timestamp and punch after it. Swapping them
         * gives dates that look like dates and are wrong by months, which
         * survives a demo and shows up as an attendance report nobody can
         * explain.
         */
        byte[] payload = FromHex(
            "28000000" +                                     // declared size 40
            "0700" +                                         // uid 7
            "30303432" + new string('0', 40) +               // "0042" padded to 24
            "01" +                                           // status 1
            "f95d4b33" +                                     // timestamp
            "00" +                                           // punch 0
            "0000000000000000");                             // padding

        MethodInfo parse = typeof(HmsAttendance.Terminal).GetMethod("ParseAttendance",
            BindingFlags.NonPublic | BindingFlags.Static);
        Ok("the parser is reachable for testing", parse != null);
        if (parse != null)
        {
            var list = (System.Collections.Generic.List<HmsAttendance.TerminalPunch>)
                parse.Invoke(null, new object[] { payload, null });
            Ok("one record is read", list.Count == 1, list.Count.ToString());
            if (list.Count == 1)
            {
                Ok("the user id is the string the device sent, zeros and all",
                    list[0].UserId == "0042", "\"" + list[0].UserId + "\"");
                Ok("the time is 2026-10-10 09:14:33",
                    list[0].At == new DateTime(2026, 10, 10, 9, 14, 33),
                    list[0].At.ToString("u"));
                Ok("status and punch are the right way round",
                    list[0].Status == 1 && list[0].Punch == 0,
                    "status " + list[0].Status + ", punch " + list[0].Punch);
                Ok("and it knows which layout it read", list[0].Layout == 40);
            }

            /* A blank slot must be dropped, not posted with a 2000 date. */
            byte[] blank = FromHex("28000000" + new string('0', 80));
            var none = (System.Collections.Generic.List<HmsAttendance.TerminalPunch>)
                parse.Invoke(null, new object[] { blank, null });
            Ok("a blank record is dropped rather than dated in 2000",
                none.Count == 0, none.Count.ToString());
        }


        Console.WriteLine("\n- the exact bytes on the wire -");
        /*
         * THE TEST THAT WOULD HAVE SAVED A DAY.
         *
         * The first build of this agent sent 50 50 82 72 instead of
         * 50 50 82 7D, because pyzk declares the second magic word as
         *
         *     MACHINE_PREPARE_DATA_2 = 32130 # 0x7282
         *
         * and that comment is wrong: 32130 is 0x7D82. I copied the comment.
         * The K50 saw a packet that was not its protocol, closed the socket,
         * and the only evidence was "an existing connection was forcibly
         * closed by the remote host" — which says nothing about why.
         *
         * Every other check in this file tested arithmetic. None of them
         * tested the FRAMING, so all of them passed on a build that could
         * never talk to a device. This one pins the finished packet byte for
         * byte against what the reference implementation puts on the wire.
         */
        MethodInfo build = typeof(HmsAttendance.Terminal).GetMethod("BuildPacket",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo frame = typeof(HmsAttendance.Terminal).GetMethod("Frame",
            BindingFlags.NonPublic | BindingFlags.Static);
        Ok("both are reachable for testing", build != null && frame != null);

        if (build != null && frame != null)
        {
            /* CMD_CONNECT, session 0, the reply counter at its start value. */
            object[] args = new object[] { (ushort)1000, new byte[0], (ushort)0, (ushort)65534 };
            byte[] pk = (byte[])build.Invoke(null, args);
            byte[] wire = (byte[])frame.Invoke(null, new object[] { pk });

            Ok("the header is 50 50 82 7d and nothing else",
                wire[0] == 0x50 && wire[1] == 0x50 && wire[2] == 0x82 && wire[3] == 0x7D,
                Hex(new byte[] { wire[0], wire[1], wire[2], wire[3] }));

            /*
             * The whole connect packet, as the reference sends it. Sixteen
             * bytes: the eight-byte frame then the eight-byte payload.
             */
            Ok("the connect packet matches the reference byte for byte",
                Hex(wire) == "50-50-82-7D-08-00-00-00-E8-03-17-FC-00-00-00-00",
                Hex(wire));

            /*
             * And the two halves of that which are easy to get backwards:
             * the checksum is taken over the reply id BEFORE it moves on,
             * and the packet carries the one AFTER.
             */
            Ok("the checksum is 0xFC17, taken before the counter moved",
                pk[2] == 0x17 && pk[3] == 0xFC,
                Hex(new byte[] { pk[2], pk[3] }));
            Ok("the packet carries reply id 0, the counter having wrapped",
                pk[6] == 0x00 && pk[7] == 0x00,
                Hex(new byte[] { pk[6], pk[7] }));
            Ok("and the counter was advanced for the caller",
                (ushort)args[3] == 0, args[3].ToString());
        }


        Console.WriteLine("\n- a whole conversation, against a fake device -");
        /*
         * THE TEST THAT WOULD HAVE FOUND THE REAL BUG.
         *
         * Everything above tests arithmetic, and the first build was correct
         * at all of it while being unable to read an attendance log. The
         * fault was one unread packet: a chunked read answers with three —
         * PREPARE_DATA, DATA, and a bare ACK_OK — and the agent read two.
         * The leftover became the next command's answer, and from then on
         * every reply belonged to the command before it.
         *
         * The user list still worked, because it came first. The attendance
         * read got the previous command's empty acknowledgement and reported
         * that the device had refused a buffered read, which was false in
         * every particular. The symptom was two commands away from the
         * cause.
         *
         * No amount of unit testing finds that. It needs the other end of a
         * socket. FakeDevice replays the sequence a real K50 produced,
         * trailing acknowledgement and all.
         */
        using (HmsAttendance.FakeDevice dev = new HmsAttendance.FakeDevice())
        {
            try
            {
            using (HmsAttendance.Terminal t =
                new HmsAttendance.Terminal("127.0.0.1", dev.Port, "0", 5))
            {
                t.Connect();
                Ok("it connects and authorises", true);

                DateTime clock = t.GetTime();
                Ok("the clock reads back", clock == new DateTime(2026, 10, 10, 15, 22, 32),
                    clock.ToString("u"));

                HmsAttendance.Sizes sz = t.ReadSizes();
                Ok("the counters read back", sz.Users == 58 && sz.RecordCapacity == 100000,
                    sz.Users + " users, capacity " + sz.RecordCapacity);

                var users = t.GetUsers();
                Ok("the user list reads back", users.Count == 2, users.Count.ToString());
                if (users.Count == 2)
                {
                    Ok("with the names the device holds",
                        users[0].Name == "Yasir" && users[1].Name == "Saleem",
                        users[0].Name + ", " + users[1].Name);
                }

                /*
                 * AND THEN THE ATTENDANCE, which is the half that broke.
                 * Reading it immediately after the user list is the whole
                 * point: that is the order in which the leftover packet did
                 * its damage.
                 */
                var punches = t.GetAttendance(users);
                Ok("the attendance log reads back AFTER the user list",
                    punches.Count == 3, punches.Count.ToString());

                if (punches.Count == 3)
                {
                    Ok("sorted oldest first, whatever order the device gave them",
                        punches[0].At < punches[1].At && punches[1].At < punches[2].At,
                        punches[0].At.ToString("u") + " then " + punches[2].At.ToString("u"));
                    Ok("the first is yesterday evening",
                        punches[0].At == new DateTime(2026, 10, 9, 18, 2, 44),
                        punches[0].At.ToString("u"));
                    Ok("the last is this morning, to the second",
                        punches[2].At == new DateTime(2026, 10, 10, 9, 15, 2),
                        punches[2].At.ToString("u"));
                    Ok("the user ids came through as the device's own strings",
                        punches[2].UserId == "7", "\"" + punches[2].UserId + "\"");
                    Ok("and the 40-byte layout was recognised",
                        punches[0].Layout == 40, punches[0].Layout.ToString());
                }

                /* Twice over, because the fault only showed on the second read. */
                var again = t.GetAttendance(users);
                Ok("and again, so the connection is still in step",
                    again.Count == 3, again.Count.ToString());
            }
            }
            catch (Exception e)
            {
                /* A protocol fault is a failed check, not a crashed run. */
                Ok("the whole conversation completes", false, e.Message);
            }
        }

        /*
         * Now prove the agent NOTICES when a device does not send that
         * trailing packet, instead of silently reading everything one place
         * behind for the rest of the connection.
         */
        using (HmsAttendance.FakeDevice dev = new HmsAttendance.FakeDevice())
        {
            dev.SendTrailingAck = false;
            using (HmsAttendance.Terminal t =
                new HmsAttendance.Terminal("127.0.0.1", dev.Port, "0", 5))
            {
                t.Connect();
                /*
                 * A device that does not send the trailing packet must still
                 * work. Waiting forever for it would be the opposite
                 * mistake to leaving it in the socket, and worse: the agent
                 * would hang on every poll rather than misread one log.
                 *
                 * So both reads must succeed and the connection must stay in
                 * step, just more slowly.
                 */
                var users = t.GetUsers();
                Ok("a device that sends no trailing ack still gives its users",
                    users.Count == 2, users.Count.ToString());
                var p1 = t.GetAttendance(users);
                Ok("and its attendance", p1.Count == 3, p1.Count.ToString());
                var p2 = t.GetAttendance(users);
                Ok("and stays in step for the next read", p2.Count == 3,
                    p2.Count.ToString());
            }
        }

        /* The reader's scan decisions and creating users on a terminal. */
        AgentTest.Run();

        Console.WriteLine("\n" + pass + " passed, " + fail + " failed\n");
        return fail > 0 ? 1 : 0;
    }
}
