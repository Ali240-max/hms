using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Sockets;
using System.Text;

namespace HmsAttendance
{
    /// <summary>
    /// A ZKTeco STANDALONE TERMINAL over the network. The K50 and its family.
    ///
    /// This is a different machine from the Live20R the rest of this agent
    /// talks to, and the difference decides the whole design:
    ///
    ///   The Live20R is glass on a USB cable. It has no brain. This PC holds
    ///   the fingerprints and does the matching.
    ///
    ///   The K50 is a complete computer on the wall. People are enrolled on
    ///   it, it matches them itself, and it keeps its own log. There is no
    ///   useful way to push HMS templates into it and no reason to: it
    ///   already knows who everybody is.
    ///
    /// So this class does not identify anybody. It reads a log of decisions
    /// the device already made — a user id and a time — and hands them over.
    /// Everything downstream, the queue and the posting and the retry, is
    /// shared with reader mode and untouched.
    ///
    /// The one thing it WRITES is a new user, when HMS asks (EnsureUser):
    /// only when nobody is there under that id, and only reported as done
    /// once read back. It never deletes, never overwrites, never sends
    /// fingerprints, and never clears the log.
    ///
    /// WRITTEN AGAINST THE PROTOCOL, NOT THE SDK.
    ///
    /// ZKTeco ship zkemkeeper.dll for this, and it would have been less code.
    /// It is also a 32-bit COM component that has to be registered by an
    /// installer, which pins this agent to an x86 build and to a machine
    /// somebody has run a setup program on. The whole point of this agent is
    /// that build.bat compiles it on an offline hospital PC with no installs.
    /// Sockets keep that true.
    ///
    /// The wire format is the long-standing ZK protocol on TCP 4370, as
    /// documented by adrobinoga's protocol notes and implemented by pyzk.
    /// NOTHING HERE HAS BEEN RUN AGAINST A REAL DEVICE BY ME — I have no K50.
    /// It is written from the specification and the reference implementation,
    /// and `--probe` exists so the first thing you do is find out whether I
    /// got it right, in one command, before anything is trusted.
    /// </summary>
    internal class Terminal : IDisposable
    {
        /* ------------------------------------------------------- commands */
        private const ushort CMD_CONNECT = 1000;
        private const ushort CMD_EXIT = 1001;
        private const ushort CMD_ENABLEDEVICE = 1002;
        private const ushort CMD_DISABLEDEVICE = 1003;
        private const ushort CMD_AUTH = 1102;
        private const ushort CMD_ACK_OK = 2000;
        private const ushort CMD_ACK_ERROR = 2001;
        private const ushort CMD_ACK_DATA = 2002;
        private const ushort CMD_ACK_UNAUTH = 2005;
        private const ushort CMD_DATA = 1501;
        private const ushort CMD_FREE_DATA = 1502;
        private const ushort CMD_PREPARE_BUFFER = 1503;   // undocumented, universal
        private const ushort CMD_READ_BUFFER = 1504;
        private const ushort CMD_ATTLOG_RRQ = 13;
        private const ushort CMD_USERTEMP_RRQ = 9;
        private const ushort CMD_GET_FREE_SIZES = 50;
        private const ushort CMD_GET_TIME = 201;
        private const ushort CMD_SET_TIME = 202;
        /*
         * Writing a user, and asking the device to re-read its tables so the
         * new user shows in its own menus. Numbers from the same reference
         * implementation as everything else here (pyzk's set_user).
         */
        private const ushort CMD_USER_WRQ = 8;
        private const ushort CMD_REFRESHDATA = 1013;

        /** The data set being asked for, inside a buffered read. */
        private const int FCT_USER = 5;

        /*
         * The four bytes that start every packet: 50 50 82 7D.
         *
         * Written as two little-endian 16-bit words, so the second one is
         * 0x7D82 and NOT 0x7282.
         *
         * I shipped 0x7282 and the K50 reset the connection the instant it
         * saw the first packet. The reason is worth recording because it is
         * a trap anybody reading the same source will fall into: pyzk
         * declares this as
         *
         *     MACHINE_PREPARE_DATA_2 = 32130 # 0x7282
         *
         * and the comment is wrong. 32130 is 0x7D82. I copied the comment
         * instead of the value, emitted 50 50 82 72, and the device — quite
         * correctly — decided this was not its protocol and hung up. The
         * error that comes back is "an existing connection was forcibly
         * closed by the remote host", which says nothing at all about why.
         *
         * The documented magic is 50 50 82 7D and that is now what the test
         * pins, byte for byte, rather than trusting any constant.
         */
        private const ushort MAGIC_1 = 0x5050;
        private const ushort MAGIC_2 = 0x7D82;

        /*
         * The largest chunk to ask for in one go.
         *
         * 0xFFC0 rather than 0x10000 because the length field is 16 bits in
         * places and the reference implementation settled on this. A whole
         * month of punches is well under one chunk anyway; the loop exists
         * for the device that has not been read since it was installed.
         */
        private const int MAX_CHUNK = 0xFFC0;

        private readonly string _host;
        private readonly int _port;
        private readonly string _password;
        private readonly int _timeoutMs;

        private TcpClient _tcp;
        private NetworkStream _net;
        private ushort _session;
        private ushort _reply;

        /** Set once a reply has been read, so errors can name the code. */
        private ushort _lastCode;

        /*
         * Print every packet as hex.
         *
         * Added after a day lost to one wrong byte in the header. The device
         * answers a malformed packet by closing the socket and saying
         * nothing, so "forcibly closed by the remote host" is the whole of
         * the evidence — and from that it is impossible to tell a bad magic
         * number from a bad checksum from a firmware that wanted UDP. With
         * the bytes on screen it is thirty seconds.
         */
        private bool _trace;
        public void TraceOn() { _trace = true; }

        /*
         * The reply id the next answer should carry.
         *
         * Checked, because one unread packet put every later read a place
         * behind and the symptom showed up two commands away from the cause:
         * the attendance request appeared to be refused when in fact its
         * answer was still in the queue behind somebody else's.
         *
         * A stale packet is skipped rather than accepted. Three in a row and
         * the connection is declared confused, which is honest — carrying on
         * would mean reading one command's answer as another's, and the
         * numbers that come out of that look real.
         */
        private ushort _expect;

        private static void Trace(string what, byte[] b)
        {
            int n = Math.Min(b.Length, 64);
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            for (int i = 0; i < n; i++) sb.Append(b[i].ToString("x2")).Append(' ');
            Console.WriteLine("    " + what + " " + b.Length + " bytes: " +
                sb.ToString().TrimEnd() + (b.Length > n ? " ..." : ""));
        }

        public Terminal(string host, int port, string password, int timeoutSeconds)
        {
            _host = host;
            _port = port <= 0 ? 4370 : port;
            _password = string.IsNullOrEmpty(password) ? "0" : password;
            _timeoutMs = Math.Max(2, timeoutSeconds) * 1000;
        }

        /* ===================================================== connection */

        public void Connect()
        {
            _tcp = new TcpClient();
            /*
             * Connect with a timeout. TcpClient.Connect blocks for the
             * operating system's own retry period — twenty seconds or more —
             * and an agent that freezes for twenty seconds every poll because
             * somebody unplugged the terminal is worse than one that says so.
             */
            IAsyncResult ar = _tcp.BeginConnect(_host, _port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(_timeoutMs))
            {
                _tcp.Close();
                throw new TerminalError("no answer from " + _host + ":" + _port +
                    " within " + (_timeoutMs / 1000) + "s");
            }
            _tcp.EndConnect(ar);

            _net = _tcp.GetStream();
            _net.ReadTimeout = _timeoutMs;
            _net.WriteTimeout = _timeoutMs;

            _session = 0;
            /*
             * 65534, so the first packet checksums over 65534 and carries 0.
             * That is the exact pair of numbers a device is sent by the SDK,
             * and the test pins the resulting bytes.
             */
            _reply = 65534;

            byte[] reply = Send(CMD_CONNECT, new byte[0]);
            _session = _lastSession;

            if (_lastCode == CMD_ACK_UNAUTH)
            {
                /*
                 * The device wants its comm key. Not a password anybody
                 * types: the number set under Comm > Security > Comm Key on
                 * the device itself, scrambled with the session id so the
                 * same key looks different on every connection.
                 */
                Send(CMD_AUTH, MakeCommKey(_password, _session));
                if (_lastCode != CMD_ACK_OK)
                {
                    throw new TerminalError(
                        "the terminal refused the comm key. Check Comm > Security > " +
                        "Comm Key on the device and devicepassword in agent.ini " +
                        "(they must match, and 0 means none).");
                }
            }
            else if (_lastCode != CMD_ACK_OK)
            {
                throw new TerminalError("the terminal refused the connection (code " +
                    _lastCode + ")");
            }
            GC.KeepAlive(reply);
        }

        public void Dispose()
        {
            try { if (_net != null) Send(CMD_EXIT, new byte[0]); }
            catch { /* going away anyway */ }
            try { if (_net != null) _net.Close(); } catch { }
            try { if (_tcp != null) _tcp.Close(); } catch { }
            _net = null; _tcp = null;
        }

        /* ======================================================= the clock */

        /// <summary>
        /// The device's own idea of the time.
        ///
        /// Worth asking, and worth comparing. Every record the terminal keeps
        /// is stamped from THIS clock, not from the server's. A device whose
        /// battery has died and come back at midnight on the first of January
        /// will hand over a month of punches dated in 2000, and HMS will
        /// store them exactly as given. There is nothing the server can do
        /// about it afterwards, so the agent says so at the top of every
        /// poll.
        /// </summary>
        public DateTime GetTime()
        {
            byte[] d = Send(CMD_GET_TIME, new byte[0]);
            if (_lastCode != CMD_ACK_OK || d.Length < 4)
                throw new TerminalError("the terminal would not give its time");
            return DecodeTime(BitConverter.ToUInt32(d, 0));
        }

        /// <summary>Sets the device clock. Only on an explicit instruction.</summary>
        public void SetTime(DateTime t)
        {
            Send(CMD_SET_TIME, BitConverter.GetBytes(EncodeTime(t)));
            if (_lastCode != CMD_ACK_OK)
                throw new TerminalError("the terminal refused the new time");
        }

        /* ======================================================== counters */

        public Sizes ReadSizes()
        {
            byte[] d = Send(CMD_GET_FREE_SIZES, new byte[0], 1024);
            Sizes s = new Sizes();
            if (d.Length >= 80)
            {
                /* Twenty little-endian integers; the useful ones by index. */
                s.Users = BitConverter.ToInt32(d, 4 * 4);
                s.Fingers = BitConverter.ToInt32(d, 6 * 4);
                s.Records = BitConverter.ToInt32(d, 8 * 4);
                s.UserCapacity = BitConverter.ToInt32(d, 15 * 4);
                s.RecordCapacity = BitConverter.ToInt32(d, 16 * 4);
            }
            return s;
        }

        /* ========================================================== users */

        /// <summary>
        /// Everybody enrolled on the device: its internal uid, the user id
        /// printed in its menus, and the name somebody typed in.
        ///
        /// Read for two reasons. The 8-byte attendance record carries only
        /// the internal uid and has to be turned into a user id, and a human
        /// setting this up needs to see the list to fill in the mapping.
        /// </summary>
        public List<TerminalUser> GetUsers()
        {
            List<TerminalUser> users = new List<TerminalUser>();
            byte[] data = ReadWithBuffer(CMD_USERTEMP_RRQ, FCT_USER);
            if (data.Length <= 4) return users;

            int total = (int)BitConverter.ToUInt32(data, 0);
            int body = data.Length - 4;
            /*
             * The record size is derived, not assumed.
             *
             * Firmware generations use 28 or 72 bytes per user and there is
             * no field that says which. Dividing the declared total by the
             * number of records is how the reference implementation decides,
             * and it is right for both.
             */
            int size = 72;
            int count = 0;
            foreach (int candidate in new int[] { 72, 28 })
            {
                if (body % candidate == 0) { size = candidate; count = body / candidate; break; }
            }
            if (count == 0) { size = 72; count = body / 72; }
            if (count > 0) _userLayout = size;

            for (int i = 0; i < count; i++)
            {
                int o = 4 + i * size;
                if (o + size > data.Length) break;

                TerminalUser u = new TerminalUser();
                u.Uid = BitConverter.ToUInt16(data, o);

                if (size == 28)
                {
                    /* <HB5s8sIxBhI : uid, privilege, password, name, card,
                     * pad, group, timezone, user_id (an integer here).
                     *
                     * The name starts at 8: two bytes of uid, one of
                     * privilege, five of password. It was read from 14,
                     * which is the middle of the name, and nothing noticed
                     * because the K50 uses the 72-byte layout. Creating
                     * users reads their names back to check them, so it
                     * matters now. */
                    u.Name = Str(data, o + 8, 8);
                    u.UserId = BitConverter.ToUInt32(data, o + 24)
                        .ToString(CultureInfo.InvariantCulture);
                }
                else
                {
                    /* <HB8s24sIx7sx24s : uid, privilege, password, name,
                     * card, pad, group, pad, user_id (a string here) */
                    u.Name = Str(data, o + 11, 24);
                    u.UserId = Str(data, o + 48, 24);
                }
                if (u.UserId.Length == 0)
                    u.UserId = u.Uid.ToString(CultureInfo.InvariantCulture);
                users.Add(u);
            }
            GC.KeepAlive(total);
            return users;
        }

        /*
         * The user record layout this device answered with: 72 bytes on
         * current firmware, the K50 included, or 28 on old firmware. Zero
         * until a user list has been read with somebody on it.
         */
        private int _userLayout;

        /* ================================================ creating users */

        /// <summary>
        /// Make sure a user with this id is on the device, creating one if
        /// not.
        ///
        /// THE RULES, in the order they are applied:
        ///
        ///   1. Read the device's users first. A user already there under
        ///      that id is NOT written to — not renamed, not given a new
        ///      privilege, nothing. It is reported, with the name the device
        ///      holds, and HMS decides whether it is the same person. Writing
        ///      over a stranger enrolled years ago in ZKBio would take their
        ///      fingerprints' owner away from them.
        ///
        ///   2. A new user gets the next free internal slot, ordinary user
        ///      privilege, no password and no card. HMS holds none of those
        ///      for anybody, and inventing them would be worse than leaving
        ///      them empty: a device administrator nobody chose is a way to
        ///      wipe the terminal from its own keypad.
        ///
        ///   3. Nothing is called created until the user list has been read
        ///      AGAIN and the user is in it. The device saying "ok" to the
        ///      write is not the same thing as the user existing.
        ///
        /// Fingerprints are not sent. The person enrols a finger on the K50
        /// itself, against the id this creates.
        /// </summary>
        public UserSyncResult EnsureUser(string userId, string name)
        {
            UserSyncResult res = new UserSyncResult();
            res.UserId = userId ?? "";

            if (!IsDeviceId(res.UserId))
            {
                res.Code = "DEVICE_ERROR";
                res.Message = "\"" + res.UserId + "\" is not an id a terminal can hold.";
                return res;
            }

            List<TerminalUser> users = GetUsers();
            int layout = _userLayout == 28 ? 28 : 72;
            res.ExpectedName = FitName(name, layout == 28 ? 8 : 24);

            TerminalUser there = FindUser(users, res.UserId, layout);
            if (there != null)
            {
                res.Code = "ALREADY_PRESENT";
                res.DeviceName = there.Name;
                res.Uid = there.Uid;
                return res;
            }

            Sizes sizes = ReadSizes();
            if (sizes.UserCapacity > 0 && sizes.Users >= sizes.UserCapacity)
            {
                res.Code = "DEVICE_FULL";
                res.Message = "The terminal is full: " + sizes.Users + " of " +
                    sizes.UserCapacity + " users.";
                return res;
            }

            int uid = 1;
            foreach (TerminalUser u in users) if (u.Uid >= uid) uid = u.Uid + 1;
            if (uid > 65534)
            {
                res.Code = "DEVICE_FULL";
                res.Message = "The terminal has no free internal user slot.";
                return res;
            }

            byte[] record = layout == 28
                ? PackUser28(uid, res.UserId, res.ExpectedName)
                : PackUser72(uid, res.UserId, res.ExpectedName);

            try
            {
                Send(CMD_USER_WRQ, record);
            }
            catch (TerminalRefused)
            {
                /*
                 * A plain no. The reply was read, so the session is still in
                 * step and the next job can go ahead. Anything else thrown
                 * here — out of step, a timeout — is left for
                 * EnsureUserSafely, which stops using the connection.
                 */
                res.Code = "DEVICE_ERROR";
                res.Message = "The terminal refused to add the user.";
                return res;
            }
            if (_lastCode != CMD_ACK_OK)
            {
                res.Code = "DEVICE_ERROR";
                res.Message = "The terminal answered the write with code " + _lastCode + ".";
                return res;
            }

            /* So the user appears in the device's own menus straight away. */
            try { Send(CMD_REFRESHDATA, new byte[0]); } catch (TerminalError) { }

            TerminalUser made = FindUser(GetUsers(), res.UserId, layout);
            if (made == null)
            {
                res.Code = "VERIFY_FAILED";
                res.Message = "The terminal accepted the user but does not list " +
                    "them when asked. Nothing is mapped in HMS until it does.";
                return res;
            }

            res.Code = "CREATED";
            res.DeviceName = made.Name;
            res.Uid = made.Uid;
            return res;
        }

        /// <summary>
        /// EnsureUser, with every way a connection can fail turned into an
        /// answer for HMS rather than an exception.
        ///
        /// After a failure that leaves the connection in doubt — a timeout, a
        /// reset, a reply out of step — the session is marked broken and the
        /// remaining jobs are answered without touching the device: half a
        /// conversation is how one command's reply gets read as another's.
        /// </summary>
        public UserSyncResult EnsureUserSafely(string userId, string name)
        {
            if (Broken != null)
            {
                UserSyncResult skip = new UserSyncResult();
                skip.UserId = userId ?? "";
                skip.Code = "DEVICE_ERROR";
                skip.Message = "Not tried: the connection to the terminal failed " +
                    "on an earlier step (" + Broken + ").";
                return skip;
            }
            try
            {
                return EnsureUser(userId, name);
            }
            catch (Exception e)
            {
                Broken = DescribeFailure(e);
                UserSyncResult res = new UserSyncResult();
                res.UserId = userId ?? "";
                res.Code = "DEVICE_ERROR";
                res.Message = Broken;
                return res;
            }
        }

        /// <summary>Why the connection stopped being usable, once it has.</summary>
        public string Broken;

        internal static string DescribeFailure(Exception e)
        {
            SocketException se = e as SocketException;
            if (se != null && se.SocketErrorCode == SocketError.ConnectionRefused)
                return "nothing is answering on that address and port";
            if (e is System.IO.IOException || e is SocketException)
            {
                string m = e.Message ?? "";
                if (m.IndexOf("period of time", StringComparison.OrdinalIgnoreCase) >= 0
                    || m.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0
                    || m.IndexOf("did not properly respond", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return "the terminal stopped answering (timed out)";
                }
                return "the connection to the terminal broke: " + Trim(m);
            }
            if (e is TerminalError) return Trim(e.Message);
            return Trim(e.GetType().Name + ": " + e.Message);
        }

        private static string Trim(string s)
        {
            if (s == null) return "";
            return s.Length > 200 ? s.Substring(0, 200) : s;
        }

        /// <summary>
        /// Digits only, at most nine, not all zeros. What the keypad can type
        /// and what the 28-byte layout's integer can hold.
        /// </summary>
        internal static bool IsDeviceId(string id)
        {
            if (string.IsNullOrEmpty(id) || id.Length > 9) return false;
            bool nonZero = false;
            foreach (char c in id)
            {
                if (c < '0' || c > '9') return false;
                if (c != '0') nonZero = true;
            }
            return nonZero;
        }

        /// <summary>
        /// The user with this id, if the device has one.
        ///
        /// On the 28-byte layout the id is an integer, so "0042" comes back
        /// as "42": compared as numbers there, as exact strings otherwise.
        /// </summary>
        internal static TerminalUser FindUser(List<TerminalUser> users, string userId, int layout)
        {
            foreach (TerminalUser u in users)
            {
                if (layout == 28)
                {
                    uint a, b;
                    if (uint.TryParse(u.UserId, out a) && uint.TryParse(userId, out b) && a == b)
                        return u;
                }
                else if (string.Equals(u.UserId, userId, StringComparison.Ordinal))
                {
                    return u;
                }
            }
            return null;
        }

        /// <summary>
        /// A name cut to fit the device's field, on a character boundary, so
        /// a multi-byte letter is never written in half.
        /// </summary>
        internal static string FitName(string name, int maxBytes)
        {
            if (name == null) return "";
            StringBuilder sb = new StringBuilder();
            int bytes = 0;
            string clean = name.Trim();
            for (int i = 0; i < clean.Length; i++)
            {
                string ch = char.IsHighSurrogate(clean[i]) && i + 1 < clean.Length
                    ? clean.Substring(i, 2) : clean.Substring(i, 1);
                if (ch.Length == 2) i++;
                if (ch[0] < ' ') ch = " ";
                int n = Encoding.UTF8.GetByteCount(ch);
                if (bytes + n > maxBytes) break;
                sb.Append(ch);
                bytes += n;
            }
            return sb.ToString().Trim();
        }

        /// <summary>
        /// The 72-byte user record: uid, privilege, password[8], name[24],
        /// card, pad, group[7], pad, user_id[24]. Laid out the way the
        /// reference packs it ('HB8s24s4sx7sx24s'), and the same offsets
        /// GetUsers reads back.
        /// </summary>
        internal static byte[] PackUser72(int uid, string userId, string name)
        {
            byte[] r = new byte[72];
            Buffer.BlockCopy(BitConverter.GetBytes((ushort)uid), 0, r, 0, 2);
            r[2] = 0;                          // privilege: ordinary user
            /* password 3..10, card 35..38 and group 40..46 stay zero */
            PutStr(r, 11, name, 24);
            PutStr(r, 48, userId, 24);
            return r;
        }

        /// <summary>
        /// The 28-byte record of older firmware: uid, privilege, password[5],
        /// name[8], card, pad, group, timezone, user_id as an integer.
        /// </summary>
        internal static byte[] PackUser28(int uid, string userId, string name)
        {
            byte[] r = new byte[28];
            Buffer.BlockCopy(BitConverter.GetBytes((ushort)uid), 0, r, 0, 2);
            r[2] = 0;
            PutStr(r, 8, name, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(uint.Parse(userId,
                CultureInfo.InvariantCulture)), 0, r, 24, 4);
            return r;
        }

        private static void PutStr(byte[] into, int at, string s, int max)
        {
            byte[] b = Encoding.UTF8.GetBytes(s ?? "");
            Buffer.BlockCopy(b, 0, into, at, Math.Min(b.Length, max));
        }

        /* ===================================================== attendance */

        /// <summary>
        /// The device's attendance log, oldest first.
        ///
        /// NOTHING IS DELETED. The protocol has a command to clear the log
        /// and this agent never sends it. Clearing is the obvious way to
        /// avoid reading the same record twice and it is the wrong way: the
        /// moment HMS is unreachable, or this PC is off, or the mapping is
        /// wrong, the only copy of a day's attendance would be gone. The
        /// agent keeps a high-water mark instead and the device keeps its
        /// log, which is what it is for. A K50 holds tens of thousands of
        /// records; a hospital will not fill it.
        /// </summary>
        public List<TerminalPunch> GetAttendance(List<TerminalUser> users)
        {
            return ParseAttendance(ReadWithBuffer(CMD_ATTLOG_RRQ, 0), users);
        }

        /// <summary>
        /// The log, turned into punches. Separated from the reading so it can
        /// be tested without a device.
        ///
        /// Which matters more here than anywhere else in this file: the
        /// 40-byte layout puts status BEFORE the timestamp and punch after
        /// it, and getting that wrong produces dates that look like dates
        /// and are wrong by months. That survives a demo and resurfaces as an
        /// attendance report nobody can explain. There is a test that builds
        /// a record with the reference implementation's own packing and
        /// checks every field.
        /// </summary>
        internal static List<TerminalPunch> ParseAttendance(
            byte[] data, List<TerminalUser> users)
        {
            List<TerminalPunch> punches = new List<TerminalPunch>();
            if (data == null || data.Length <= 4) return punches;

            int body = data.Length - 4;
            /*
             * Three record layouts exist in the wild: 8, 16 and 40 bytes.
             * Which one is in use is decided by dividing the payload, since
             * no field declares it. 40 is tried first because it is what
             * current firmware — the K50 included — produces, and because a
             * 40-byte payload also divides by 8.
             */
            int size = 0;
            foreach (int candidate in new int[] { 40, 16, 8 })
            {
                if (body % candidate == 0) { size = candidate; break; }
            }
            if (size == 0) throw new TerminalError(
                "the attendance log came back " + body + " bytes, which is not a " +
                "whole number of records in any layout this agent knows");

            Dictionary<int, string> byUid = new Dictionary<int, string>();
            if (users != null)
                foreach (TerminalUser u in users) byUid[u.Uid] = u.UserId;

            for (int o = 4; o + size <= data.Length; o += size)
            {
                TerminalPunch p = new TerminalPunch();
                p.Layout = size;

                if (size == 8)
                {
                    /* HB4sB : uid, status, timestamp, punch */
                    int uid = BitConverter.ToUInt16(data, o);
                    p.Status = data[o + 2];
                    p.At = DecodeTime(BitConverter.ToUInt32(data, o + 3));
                    p.Punch = data[o + 7];
                    p.UserId = byUid.ContainsKey(uid)
                        ? byUid[uid] : uid.ToString(CultureInfo.InvariantCulture);
                }
                else if (size == 16)
                {
                    /* <I4sBB2sI : user_id (integer), timestamp, status,
                     * punch, reserved, workcode */
                    p.UserId = BitConverter.ToUInt32(data, o)
                        .ToString(CultureInfo.InvariantCulture);
                    p.At = DecodeTime(BitConverter.ToUInt32(data, o + 4));
                    p.Status = data[o + 8];
                    p.Punch = data[o + 9];
                }
                else
                {
                    /*
                     * <H24sB4sB8s : uid, user_id (string), status,
                     * timestamp, punch, padding.
                     *
                     * Note the order: status comes BEFORE the timestamp and
                     * punch after it. Getting those two the other way round
                     * yields plausible-looking dates that are all wrong,
                     * which is the kind of bug that survives a demo.
                     */
                    p.UserId = Str(data, o + 2, 24);
                    p.Status = data[o + 26];
                    p.At = DecodeTime(BitConverter.ToUInt32(data, o + 27));
                    p.Punch = data[o + 31];
                    if (p.UserId.Length == 0)
                    {
                        int uid = BitConverter.ToUInt16(data, o);
                        p.UserId = byUid.ContainsKey(uid)
                            ? byUid[uid] : uid.ToString(CultureInfo.InvariantCulture);
                    }
                }

                /*
                 * A record with an impossible date is dropped, not posted.
                 *
                 * The decode is arithmetic on a 32-bit counter, so a corrupt
                 * or empty slot decodes to something in the year 2000 or well
                 * past 2100 rather than failing. Posting those would put
                 * attendance in the wrong decade and nobody would know where
                 * it came from.
                 */
                if (p.At.Year < 2015 || p.At.Year > 2100) continue;
                if (p.UserId.Length == 0) continue;

                punches.Add(p);
            }

            punches.Sort(delegate (TerminalPunch a, TerminalPunch b)
            {
                return a.At.CompareTo(b.At);
            });
            return punches;
        }

        /* ============================================== the buffered read */

        /// <summary>
        /// A large data set, in chunks.
        ///
        /// Command 1503 is undocumented by ZKTeco and supported by every
        /// device anybody has tried it on, which is why both the reference
        /// implementations use it. It answers either with the data outright,
        /// for a small set, or with a size to come back for in pieces.
        /// </summary>
        private byte[] ReadWithBuffer(ushort what, int fct)
        {
            /* <bhii : 1, command, fct, ext */
            byte[] req = new byte[11];
            req[0] = 1;
            Buffer.BlockCopy(BitConverter.GetBytes(what), 0, req, 1, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(fct), 0, req, 3, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(0), 0, req, 7, 4);

            byte[] first = Send(CMD_PREPARE_BUFFER, req, 1024);

            if (_lastCode == CMD_DATA)
            {
                /*
                 * Small set, sent straight back. On TCP the reply may be
                 * shorter than the header promised, because the device is
                 * streaming: Send has already read to the declared length,
                 * so this is simply the data.
                 */
                return first;
            }
            if (_lastCode != CMD_ACK_OK)
            {
                throw new TerminalError(
                    "the terminal refused a buffered read, answering with code " +
                    _lastCode + " instead of 2000.");
            }
            if (first.Length < 5)
            {
                /*
                 * A correct code with no data behind it.
                 *
                 * The old message here blamed old firmware, and that is
                 * what it told somebody with a perfectly modern K50 — which
                 * cost an afternoon looking at the wrong thing. The device
                 * had answered properly; its answer was one place further
                 * down the socket, behind a packet the agent had not read.
                 *
                 * So the message now names the likely cause rather than
                 * guessing at the device's age.
                 */
                throw new TerminalError(
                    "the terminal said yes to a buffered read and sent no size " +
                    "with it (" + first.Length + " bytes). That usually means " +
                    "this reply belongs to an earlier command and the two sides " +
                    "are out of step. Run --probe --trace and send the output.");
            }

            int size = (int)BitConverter.ToUInt32(first, 1);
            if (size <= 0) return new byte[0];

            byte[] all = new byte[size];
            int got = 0;
            while (got < size)
            {
                int want = Math.Min(MAX_CHUNK, size - got);
                byte[] chunk = ReadChunk(got, want);
                if (chunk.Length == 0)
                    throw new TerminalError("the terminal stopped sending after " +
                        got + " of " + size + " bytes");
                int take = Math.Min(chunk.Length, size - got);
                Buffer.BlockCopy(chunk, 0, all, got, take);
                got += take;
            }

            try { Send(CMD_FREE_DATA, new byte[0]); } catch { /* best effort */ }
            return all;
        }

        private byte[] ReadChunk(int start, int size)
        {
            byte[] req = new byte[8];
            Buffer.BlockCopy(BitConverter.GetBytes(start), 0, req, 0, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(size), 0, req, 4, 4);

            byte[] d = Send(CMD_READ_BUFFER, req, size + 32);

            /*
             * The answer is either the data outright, or three packets:
             * CMD_PREPARE_DATA, then CMD_DATA, then a bare CMD_ACK_OK.
             *
             * THAT THIRD PACKET IS THE ONE THAT MATTERS, and leaving it in
             * the socket is the bug this comment exists for.
             *
             * The device sends all three without waiting to be asked, and
             * they all carry the same reply number. My first version read
             * two of them. The ACK_OK stayed in the buffer, so the NEXT
             * command read it as its own answer and every read after that
             * was one packet behind. The user list still worked, because it
             * came first. The attendance read then got the previous
             * command's bare ACK_OK — correct code, no data — and reported
             * "the terminal would not start a buffered read", which is both
             * wrong and unhelpful: the terminal had started it perfectly and
             * its reply was sitting one place further down the queue.
             *
             * One unread packet, and the symptom appeared two commands away
             * from the cause.
             */
            if (_lastCode == CMD_PREPARE_DATA_CODE)
            {
                d = ReadPacket();
                if (_lastCode == CMD_DATA) DrainTrailingAck();
            }
            return d;
        }

        private const ushort CMD_PREPARE_DATA_CODE = 1500;

        /// <summary>
        /// Reads the bare acknowledgement that follows a data transfer, and
        /// does not insist on it.
        ///
        /// Every device I have seen a trace from sends it, and the protocol
        /// notes say it does. Leaving it in the socket is what broke the
        /// attendance read: the next command took it as its own answer and
        /// every reply after that belonged to the command before it.
        ///
        /// WAITING FOREVER FOR IT WOULD BE THE OPPOSITE MISTAKE. There is a
        /// lot of ZKTeco firmware in the world and I have tested against
        /// one device. A version that does not send it would hang this
        /// agent on every poll, which is worse than the bug being fixed. So
        /// the read is given a second and a half of its own and a silence is
        /// accepted: the reply-number check on every other read is what
        /// catches a desync if one happens anyway.
        /// </summary>
        private void DrainTrailingAck()
        {
            int was = _net.ReadTimeout;
            try
            {
                _net.ReadTimeout = 1500;
                ReadPacket();
            }
            catch (TerminalError)
            {
                /* Out of step, which the next read reports properly. */
            }
            catch (Exception)
            {
                /*
                 * A timeout, almost always. Nothing arrived, so nothing was
                 * left behind, which is the state this method exists to
                 * guarantee.
                 */
                if (_trace) Console.WriteLine("    (no trailing ack; carrying on)");
            }
            finally
            {
                try { _net.ReadTimeout = was; } catch { }
            }
        }

        /* ================================================== the wire */

        private ushort _lastSession;
        private ushort _lastReply;

        /// <summary>
        /// One command packet, built exactly the way the devices expect it.
        ///
        /// THE CHECKSUM IS COMPUTED OVER THE REPLY ID BEFORE IT IS
        /// INCREMENTED, and the packet then carries the incremented one. So
        /// the checksum does not match the bytes beside it, which looks like
        /// a mistake and is not: it is what the SDK does and what every
        /// device in the field was built against.
        ///
        /// My first version incremented first and checksummed the finished
        /// packet, which is what anybody would write and gives a different
        /// number — 0xFC16 for a connect rather than the 0xFC17 a real
        /// device is sent. Separated into its own method so the test can pin
        /// the whole packet byte for byte instead of only the arithmetic.
        /// </summary>
        internal static byte[] BuildPacket(ushort command, byte[] data,
            ushort session, ref ushort reply)
        {
            if (data == null) data = new byte[0];

            byte[] payload = new byte[8 + data.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(command), 0, payload, 0, 2);
            /* The checksum field stays zero while the checksum is taken. */
            Buffer.BlockCopy(BitConverter.GetBytes(session), 0, payload, 4, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(reply), 0, payload, 6, 2);
            Buffer.BlockCopy(data, 0, payload, 8, data.Length);

            ushort sum = Checksum(payload);

            /* Now move the counter on, wrapping at 65535 to zero. */
            int next = reply + 1;
            if (next >= 65535) next -= 65535;
            reply = (ushort)next;

            Buffer.BlockCopy(BitConverter.GetBytes(sum), 0, payload, 2, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(reply), 0, payload, 6, 2);
            return payload;
        }

        /// <summary>The whole thing, header and all, ready for the socket.</summary>
        internal static byte[] Frame(byte[] payload)
        {
            byte[] framed = new byte[8 + payload.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(MAGIC_1), 0, framed, 0, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(MAGIC_2), 0, framed, 2, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(payload.Length), 0, framed, 4, 4);
            Buffer.BlockCopy(payload, 0, framed, 8, payload.Length);
            return framed;
        }

        /// <summary>
        /// Sends one command and reads one reply.
        /// </summary>
        private byte[] Send(ushort command, byte[] data, int expect = 1024)
        {
            if (data == null) data = new byte[0];

            /*
             * The reply id this packet will carry, kept so the answer can be
             * matched to the question. BuildPacket advances the counter, so
             * it has to be read off the finished packet rather than off
             * _reply.
             */
            byte[] payload = BuildPacket(command, data, _session, ref _reply);
            _expect = BitConverter.ToUInt16(payload, 6);
            byte[] framed = Frame(payload);

            if (_trace) Trace("sent", framed);

            _net.Write(framed, 0, framed.Length);
            _net.Flush();
            GC.KeepAlive(expect);

            return ReadPacket();
        }

        /// <summary>
        /// Reads one packet, skipping any that answers an earlier question.
        ///
        /// A packet left unread by a previous exchange would otherwise be
        /// taken as the answer to this one, and from then on every reply
        /// belongs to the command before it. That is not a crash: it is a
        /// run of answers that all look valid and all belong to the wrong
        /// question, which is the hardest kind of fault to see.
        /// </summary>
        private byte[] ReadPacket()
        {
            for (int skipped = 0; ; skipped++)
            {
                byte[] got = ReadOnePacket();
                /*
                 * Zero is the reply id used by the realtime packets and by
                 * the first exchange, so it is never treated as stale.
                 */
                if (_expect == 0 || _lastReply == _expect) return got;

                if (skipped >= 3)
                {
                    throw new TerminalError(
                        "the terminal and this agent are out of step: expected a " +
                        "reply numbered " + _expect + " and kept getting " +
                        _lastReply + ". Restart the agent; if it happens every " +
                        "time, send the output of --probe --trace.");
                }
                if (_trace)
                {
                    Console.WriteLine("    (skipped a stale reply numbered " +
                        _lastReply + ", waiting for " + _expect + ")");
                }
            }
        }

        private byte[] ReadOnePacket()
        {
            byte[] top = ReadExactly(8);
            if (_trace) Trace("recv head", top);
            ushort m1 = BitConverter.ToUInt16(top, 0);
            ushort m2 = BitConverter.ToUInt16(top, 2);
            if (m1 != MAGIC_1 || m2 != MAGIC_2)
            {
                throw new TerminalError(
                    "the reply did not start with the protocol's marker: got " +
                    top[0].ToString("x2") + " " + top[1].ToString("x2") + " " +
                    top[2].ToString("x2") + " " + top[3].ToString("x2") +
                    ", expected 50 50 82 7d. Either that is not a ZKTeco device, " +
                    "or not on that port.");
            }

            int len = (int)BitConverter.ToUInt32(top, 4);
            if (len < 8 || len > 16 * 1024 * 1024)
                throw new TerminalError("the terminal declared a reply of " + len +
                    " bytes, which cannot be right");

            byte[] payload = ReadExactly(len);
            if (_trace) Trace("recv body", payload);
            _lastCode = BitConverter.ToUInt16(payload, 0);
            _lastSession = BitConverter.ToUInt16(payload, 4);
            _lastReply = BitConverter.ToUInt16(payload, 6);

            byte[] data = new byte[len - 8];
            Buffer.BlockCopy(payload, 8, data, 0, data.Length);

            if (_lastCode == CMD_ACK_ERROR)
                throw new TerminalRefused("the terminal answered with an error");

            return data;
        }

        /// <summary>
        /// Reads exactly n bytes, because TCP does not promise them in one go.
        ///
        /// A single Read returning whatever happened to arrive is the classic
        /// way this kind of code works on a desk and fails on a hospital LAN,
        /// where a 40 KB attendance log arrives in a dozen pieces.
        /// </summary>
        private byte[] ReadExactly(int n)
        {
            byte[] buf = new byte[n];
            int got = 0;
            while (got < n)
            {
                int r = _net.Read(buf, got, n - got);
                if (r <= 0) throw new TerminalError(
                    "the terminal closed the connection after " + got + " of " +
                    n + " bytes");
                got += r;
            }
            return buf;
        }

        /* ===================================================== arithmetic */

        /// <summary>
        /// The protocol's checksum: 16-bit words summed, folded, inverted.
        /// </summary>
        private static ushort Checksum(byte[] p)
        {
            int sum = 0;
            int i = 0;
            while (i + 1 < p.Length)
            {
                sum += p[i] | (p[i + 1] << 8);
                if (sum > 0xFFFF) sum -= 0xFFFF;
                i += 2;
            }
            if (i < p.Length) sum += p[i];
            while (sum > 0xFFFF) sum -= 0xFFFF;

            sum = ~sum;
            while (sum < 0) sum += 0xFFFF;
            return (ushort)sum;
        }

        /// <summary>
        /// The comm key, scrambled with the session id.
        ///
        /// Straight out of the SDK's own MakeKey: spread the key's bits, add
        /// the session, exclusive-or with the letters Z K S O, swap the two
        /// halves, then exclusive-or three of the four bytes with a tick
        /// count. The constant 50 is what every implementation uses and what
        /// the devices accept.
        /// </summary>
        private static byte[] MakeCommKey(string password, ushort session)
        {
            uint key;
            if (!uint.TryParse(password, out key)) key = 0;

            uint k = 0;
            for (int i = 0; i < 32; i++)
            {
                if ((key & (1u << i)) != 0) k = (k << 1) | 1u;
                else k = k << 1;
            }
            k += session;

            byte[] b = BitConverter.GetBytes(k);
            b[0] ^= (byte)'Z';
            b[1] ^= (byte)'K';
            b[2] ^= (byte)'S';
            b[3] ^= (byte)'O';

            /* Swap the two 16-bit halves. */
            byte[] s = new byte[4] { b[2], b[3], b[0], b[1] };

            const byte ticks = 50;
            return new byte[4]
            {
                (byte)(s[0] ^ ticks),
                (byte)(s[1] ^ ticks),
                ticks,
                (byte)(s[3] ^ ticks)
            };
        }

        /// <summary>
        /// The device's time format: one counter of seconds since 2000,
        /// except that it counts 31 days to a month and 12 months to a year.
        ///
        /// It is not a Unix timestamp and it is not a calendar. Treating it
        /// as either gives dates that are close enough to look right and
        /// wrong by days.
        /// </summary>
        private static DateTime DecodeTime(uint v)
        {
            long t = v;
            int second = (int)(t % 60); t /= 60;
            int minute = (int)(t % 60); t /= 60;
            int hour = (int)(t % 24); t /= 24;
            int day = (int)(t % 31) + 1; t /= 31;
            int month = (int)(t % 12) + 1; t /= 12;
            int year = (int)(t + 2000);

            try { return new DateTime(year, month, day, hour, minute, second); }
            catch { return DateTime.MinValue; }
        }

        private static uint EncodeTime(DateTime d)
        {
            long t = ((long)(d.Year % 100) * 12 * 31 + ((d.Month - 1) * 31) + d.Day - 1);
            t = t * (24 * 60 * 60) + (d.Hour * 3600) + (d.Minute * 60) + d.Second;
            return (uint)t;
        }

        /// <summary>A null-terminated string out of a fixed-width field.</summary>
        private static string Str(byte[] b, int offset, int max)
        {
            if (offset >= b.Length) return "";
            int end = offset;
            int limit = Math.Min(offset + max, b.Length);
            while (end < limit && b[end] != 0) end++;
            return Encoding.UTF8.GetString(b, offset, end - offset).Trim();
        }
    }

    internal class TerminalError : Exception
    {
        public TerminalError(string m) : base(m) { }
    }

    /// <summary>The device answered ACK_ERROR: a refusal, with the session still in step.</summary>
    internal class TerminalRefused : TerminalError
    {
        public TerminalRefused(string m) : base(m) { }
    }

    internal class Sizes
    {
        public int Users;
        public int Fingers;
        public int Records;
        public int UserCapacity;
        public int RecordCapacity;
    }

    /// <summary>What EnsureUser found or did, in the words HMS expects.</summary>
    internal class UserSyncResult
    {
        /** CREATED, ALREADY_PRESENT, DEVICE_FULL, DEVICE_ERROR, VERIFY_FAILED */
        public string Code = "DEVICE_ERROR";
        public string Message = "";
        public string UserId = "";
        /** What the device holds under that id, read back off it. */
        public string DeviceName = "";
        /** What this job writes, cut to fit the device's record. */
        public string ExpectedName = "";
        public int Uid;
    }

    internal class TerminalUser
    {
        public int Uid;
        public string UserId = "";
        public string Name = "";
    }

    internal class TerminalPunch
    {
        public string UserId = "";
        public DateTime At;
        public int Status;
        public int Punch;
        public int Layout;
    }
}
