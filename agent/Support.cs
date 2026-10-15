using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;

namespace HmsAttendance
{
    /// <summary>Settings, read from agent.ini beside the exe.</summary>
    internal class Config
    {
        public string Server = "http://192.168.1.84:4000";
        public string DeviceKey = "";
        public string DeviceName = "Staff entrance";
        public int DeviceIndex = 0;
        public int LocalPort = 5577;
        public int ReloadSeconds = 300;

        /*
         * WHICH KIND OF DEVICE, which is the one setting that changes
         * everything else.
         *
         *   reader    a ZKTeco Live20R / SLK20R / ZK9500 on this PC's USB.
         *             No brain of its own: HMS holds the fingerprints, this
         *             agent does the matching, and enrolment happens through
         *             HMS. Needs the ZKFinger SDK and a 32-bit build.
         *
         *   terminal  a ZKTeco K50 or similar on the network. A complete
         *             computer: people are enrolled ON IT, it matches them
         *             itself, and it keeps its own log. This agent reads that
         *             log and forwards it. Needs no SDK and no DLL, so it
         *             runs on any Windows and on a 64-bit build.
         *
         * Defaults to reader, because that is what is already installed and
         * an existing agent.ini with no mode line has to keep working.
         */
        public string Mode = "reader";

        /* ------------------------------------------ terminal mode only */
        public string DeviceIp = "";
        public int DevicePort = 4370;
        /*
         * The device's comm key, not a password anybody types.
         *
         * Set on the terminal under Comm > Security > Comm Key. Zero means
         * none, which is how they ship.
         */
        public string DevicePassword = "0";
        /*
         * How often to ask the terminal for new records.
         *
         * Twenty seconds by default. The device holds its own log, so the
         * only cost of a longer gap is how late a punch appears on the board
         * by the door; nothing is lost. Shorter than about ten seconds is
         * pointless — each poll disables the device's keypad for a moment
         * while it reads, and doing that constantly is felt by whoever is
         * standing at it.
         */
        public int PollSeconds = 20;
        /*
         * Refuse records older than this many days on a first run.
         *
         * A terminal that has been in service for a year hands over a year
         * of attendance the first time it is read, and posting all of it
         * would fill HMS with history nobody asked for and corrupt the
         * absentee reports for every one of those days. Fourteen days is
         * enough to catch a weekend of real punches made before the agent
         * was set up. Zero means no limit, for a deliberate back-fill.
         */
        public int BackfillDays = 14;
        /*
         * WHETHER AN UNMAPPED DEVICE ID MAY BE READ AS A STAFF ID.
         *
         * OFF, and it took a real device to show why.
         *
         * The idea was that a terminal enrolled alongside HMS would need no
         * setup: give somebody user id 7 on the device and staff 7 gets the
         * punch. That is true and it is convenient and it is only safe when
         * the two numberings are the same thing.
         *
         * On a terminal that was already in service — which is most of them,
         * because that is why anybody has one lying around — the numbers
         * mean something else entirely. The first probe against a real K50
         * paired device user 1 "Yasir" with HMS staff 1 "Administrator", and
         * eighteen more like it, every one wrong and every one looking
         * perfectly plausible in the output.
         *
         * The two failures are not equally bad. An id nobody claims is a GAP
         * — visible, counted, named in the log, fixable in a minute. A wrong
         * guess is one person's attendance filed under another person's name,
         * which nobody will ever find. So the gap is the default.
         *
         * Turn this on only when you know the device was numbered to match
         * HMS, and run --probe first to look at the names side by side.
         */
        public bool TrustDeviceIds = false;

        /*
         * Reader mode: light the reader green or red and beep after a scan.
         *
         * On by default, because somebody at a door with no screen in front
         * of them otherwise has no idea whether to press again. Off if the
         * reader's SDK build turns out not to like it.
         */
        public bool Feedback = true;

        /*
         * Terminal mode: how often to ask HMS whether anybody is waiting to be
         * created on the device, in seconds.
         *
         * Separate from PollSeconds because it costs the terminal nothing —
         * it is a question to the HMS server, and the device is only
         * connected to when there IS somebody to create. Short, so the
         * administrator who pressed the button sees the answer while still
         * at the screen.
         */
        public int JobSeconds = 5;

        public static Config Load()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string path = Path.Combine(dir, "agent.ini");

            if (!File.Exists(path))
            {
                WriteSample(path);
                throw new Exception(
                    "No settings found, so a sample was written to:\n  " + path +
                    "\n\nOpen it, put in the reader key from HMS " +
                    "(Administration > Attendance > Readers), then start the " +
                    "agent again.");
            }

            Config c = new Config();
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;

                int eq = line.IndexOf('=');
                if (eq <= 0) continue;

                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();

                if (key == "server") c.Server = val.TrimEnd('/');
                else if (key == "devicekey") c.DeviceKey = val;
                else if (key == "devicename") c.DeviceName = val;
                else if (key == "deviceindex") c.DeviceIndex = ToInt(val, 0);
                else if (key == "localport") c.LocalPort = ToInt(val, 5577);
                else if (key == "reloadseconds") c.ReloadSeconds = ToInt(val, 300);
                else if (key == "mode") c.Mode = val.Trim().ToLowerInvariant();
                else if (key == "deviceip") c.DeviceIp = val;
                else if (key == "deviceport") c.DevicePort = ToInt(val, 4370);
                else if (key == "devicepassword") c.DevicePassword = val;
                else if (key == "pollseconds") c.PollSeconds = ToInt(val, 20);
                else if (key == "backfilldays") c.BackfillDays = ToInt(val, 14);
                else if (key == "trustdeviceids")
                    c.TrustDeviceIds = val.Trim().ToLowerInvariant() == "true";
                else if (key == "feedback")
                    c.Feedback = val.Trim().ToLowerInvariant() != "false";
                else if (key == "jobseconds") c.JobSeconds = ToInt(val, 5);
            }

            if (c.DeviceKey.Length < 8)
            {
                throw new Exception(
                    "DeviceKey is missing from agent.ini. Add a reader in HMS " +
                    "under Administration > Attendance > Readers — the key is " +
                    "shown once, when you create it.");
            }

            /*
             * A reload under a minute would hammer the server for no benefit;
             * templates change when somebody is enrolled, which is rare.
             */
            if (c.ReloadSeconds < 60) c.ReloadSeconds = 60;

            if (c.Mode != "reader" && c.Mode != "terminal")
            {
                throw new Exception(
                    "Mode in agent.ini is \"" + c.Mode + "\". It has to be one of:\n" +
                    "  reader    a ZKTeco Live20R / SLK20R on this PC's USB\n" +
                    "  terminal  a ZKTeco K50 or similar on the network");
            }

            if (c.Mode == "terminal")
            {
                if (c.DeviceIp.Length == 0)
                {
                    throw new Exception(
                        "Mode=terminal needs DeviceIp in agent.ini — the address " +
                        "shown on the device under Menu > Comm > Ethernet.");
                }
                /*
                 * Each poll briefly puts the terminal into its "working"
                 * state while it reads, which somebody standing at it can
                 * see. Polling faster than every ten seconds makes the
                 * device feel broken for no gain: it holds its own log, so
                 * nothing is lost by waiting.
                 */
                if (c.PollSeconds < 10) c.PollSeconds = 10;
                if (c.BackfillDays < 0) c.BackfillDays = 0;
                if (c.JobSeconds < 2) c.JobSeconds = 2;
            }

            return c;
        }

        private static int ToInt(string s, int fallback)
        {
            int n;
            return int.TryParse(s, out n) ? n : fallback;
        }

        private static void WriteSample(string path)
        {
            File.WriteAllText(path,
                "# HMS attendance agent" + Environment.NewLine +
                "#" + Environment.NewLine +
                "# Where the HMS server is. No trailing slash." + Environment.NewLine +
                "Server=http://192.168.1.84:4000" + Environment.NewLine +
                Environment.NewLine +
                "# From HMS: Administration > Attendance > Readers > Add a reader." +
                Environment.NewLine +
                "# The key is shown once, when the reader is created." +
                Environment.NewLine +
                "DeviceKey=" + Environment.NewLine +
                Environment.NewLine +
                "# Only for the log, so two readers can be told apart." +
                Environment.NewLine +
                "DeviceName=Staff entrance" + Environment.NewLine +
                Environment.NewLine +
                "# Which reader, if more than one is plugged into this PC." +
                Environment.NewLine +
                "DeviceIndex=0" + Environment.NewLine +
                Environment.NewLine +
                "# The port the HMS enrolment screen talks to. Loopback only." +
                Environment.NewLine +
                "LocalPort=5577" + Environment.NewLine +
                Environment.NewLine +
                "# How often to re-read the enrolled fingers, in seconds." +
                Environment.NewLine +
                "ReloadSeconds=300" + Environment.NewLine +
                Environment.NewLine +
                "# Light the reader green or red and beep after each scan." +
                Environment.NewLine +
                "# Set false if the reader misbehaves with it." +
                Environment.NewLine +
                "Feedback=true" + Environment.NewLine +
                Environment.NewLine +
                "# =====================================================" +
                Environment.NewLine +
                "# WHICH KIND OF DEVICE" + Environment.NewLine +
                "# =====================================================" +
                Environment.NewLine +
                "#" + Environment.NewLine +
                "#   reader    a ZKTeco Live20R / SLK20R / ZK9500 plugged" +
                Environment.NewLine +
                "#             into THIS PC. HMS holds the fingerprints," +
                Environment.NewLine +
                "#             this agent does the matching, and staff are" +
                Environment.NewLine +
                "#             enrolled from the HMS screen." +
                Environment.NewLine +
                "#             Needs the ZKFinger SDK DLL beside the exe." +
                Environment.NewLine +
                "#" + Environment.NewLine +
                "#   terminal  a ZKTeco K50 or similar ON THE NETWORK. The" +
                Environment.NewLine +
                "#             device holds its own fingerprints and does" +
                Environment.NewLine +
                "#             its own matching; staff are enrolled ON THE" +
                Environment.NewLine +
                "#             DEVICE. This agent reads its log and sends" +
                Environment.NewLine +
                "#             it to HMS. No SDK and no DLL needed." +
                Environment.NewLine +
                "#" + Environment.NewLine +
                "Mode=reader" + Environment.NewLine +
                Environment.NewLine +
                "# --- terminal mode only, ignored otherwise ---" +
                Environment.NewLine +
                "#" + Environment.NewLine +
                "# The address on the device: Menu > Comm > Ethernet." +
                Environment.NewLine +
                "DeviceIp=" + Environment.NewLine +
                "DevicePort=4370" + Environment.NewLine +
                Environment.NewLine +
                "# The device's comm key: Menu > Comm > Security > Comm Key." +
                Environment.NewLine +
                "# 0 means none, which is how they ship." +
                Environment.NewLine +
                "DevicePassword=0" + Environment.NewLine +
                Environment.NewLine +
                "# How often to ask the terminal for new punches, in seconds." +
                Environment.NewLine +
                "PollSeconds=20" + Environment.NewLine +
                Environment.NewLine +
                "# How often to ask HMS whether anybody is waiting to be" +
                Environment.NewLine +
                "# created on the terminal, in seconds." + Environment.NewLine +
                "JobSeconds=5" + Environment.NewLine +
                Environment.NewLine +
                "# On the FIRST run, ignore anything older than this many" +
                Environment.NewLine +
                "# days. A terminal already in service holds months of" +
                Environment.NewLine +
                "# history and posting all of it would rewrite every" +
                Environment.NewLine +
                "# absentee report for those days. 0 means no limit." +
                Environment.NewLine +
                "BackfillDays=14" + Environment.NewLine +
                Environment.NewLine +
                "# May a device user id be read as an HMS staff id when no" +
                Environment.NewLine +
                "# mapping has been set for it?" + Environment.NewLine +
                "#" + Environment.NewLine +
                "# false  an unmapped id is counted, named in the log and" +
                Environment.NewLine +
                "#        DROPPED. You get a visible gap you can fix." +
                Environment.NewLine +
                "# true   device user 7 is taken to be HMS staff 7." +
                Environment.NewLine +
                "#" + Environment.NewLine +
                "# Leave it false unless you enrolled the device to match" +
                Environment.NewLine +
                "# HMS on purpose. On a device that was already in service" +
                Environment.NewLine +
                "# the numbers mean something else, and true would file one" +
                Environment.NewLine +
                "# person's attendance under another person's name." +
                Environment.NewLine +
                "# Run --probe and read the two name columns first." +
                Environment.NewLine +
                "TrustDeviceIds=false" + Environment.NewLine);
        }
    }

    /// <summary>The server said no, and said why.</summary>
    internal class HttpError : Exception
    {
        public readonly int Status;
        public readonly string Body;

        public HttpError(int status, string body)
            : base("HTTP " + status)
        {
            Status = status;
            Body = body;
        }
    }

    internal static class Http
    {
        private const int TIMEOUT_MS = 15000;

        public static string Get(string url, string deviceKey)
        {
            HttpWebRequest req = Make(url, "GET", deviceKey);
            return Read(req);
        }

        public static string Post(string url, string deviceKey, string json)
        {
            HttpWebRequest req = Make(url, "POST", deviceKey);
            req.ContentType = "application/json";

            byte[] body = Encoding.UTF8.GetBytes(json);
            req.ContentLength = body.Length;
            using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);

            return Read(req);
        }

        private static HttpWebRequest Make(string url, string method, string key)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = TIMEOUT_MS;
            req.ReadWriteTimeout = TIMEOUT_MS;
            req.Headers.Add("x-device-key", key);
            /*
             * No proxy and no keep-alive.
             *
             * A Windows machine that once had a proxy configured will try to
             * send a request for 192.168.1.84 through it and hang until the
             * timeout, on a LAN with no internet at all. Going direct is both
             * faster and the only thing that works here.
             */
            req.Proxy = null;
            req.KeepAlive = false;
            return req;
        }

        private static string Read(HttpWebRequest req)
        {
            try
            {
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader r = new StreamReader(res.GetResponseStream()))
                {
                    return r.ReadToEnd();
                }
            }
            catch (WebException we)
            {
                HttpWebResponse res = we.Response as HttpWebResponse;
                if (res == null) throw;   // the network, not the server

                string body = "";
                try
                {
                    using (StreamReader r = new StreamReader(res.GetResponseStream()))
                        body = r.ReadToEnd();
                }
                catch { }

                if (body.Length > 200) body = body.Substring(0, 200);
                throw new HttpError((int)res.StatusCode, body);
            }
        }
    }

    /// <summary>
    /// The punches waiting to be posted, kept on disk.
    ///
    /// One JSON object per line, appended. A punch is removed only after the
    /// server has taken it, so the agent being killed mid-post costs a
    /// duplicate — which the server's unique index refuses — rather than a
    /// lost arrival. That is the right way round: a punch that arrives twice
    /// is invisible, a punch that never arrives is somebody marked absent.
    /// </summary>
    internal static class Queue
    {
        private static readonly object _lock = new object();
        private static string _path;
        private static List<Punch> _items = new List<Punch>();

        public static void Init(Config cfg)
        {
            _path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "queue.txt");
            lock (_lock)
            {
                _items = ReadAll();
                if (_items.Count > 0)
                    Program.Log("queue: " + _items.Count + " punches waiting from last time");
            }
        }

        public static int Count()
        {
            lock (_lock) { return _items.Count; }
        }

        public static void Add(Punch p)
        {
            lock (_lock)
            {
                _items.Add(p);
                Save();
            }
        }

        public static Punch Peek()
        {
            lock (_lock) { return _items.Count > 0 ? _items[0] : null; }
        }

        public static void Drop()
        {
            lock (_lock)
            {
                if (_items.Count > 0) _items.RemoveAt(0);
                Save();
            }
        }

        private static List<Punch> ReadAll()
        {
            List<Punch> list = new List<Punch>();
            try
            {
                if (!File.Exists(_path)) return list;
                foreach (string line in File.ReadAllLines(_path))
                {
                    if (line.Trim().Length == 0) continue;
                    string[] parts = line.Split(new char[] { '\t' }, 3);
                    if (parts.Length < 2) continue;

                    int staffId;
                    DateTime at;
                    if (!int.TryParse(parts[0], out staffId)) continue;
                    if (!DateTime.TryParse(parts[1], null,
                        DateTimeStyles.RoundtripKind, out at)) continue;

                    list.Add(new Punch(staffId, at, parts.Length > 2 ? parts[2] : ""));
                }
            }
            catch (Exception e)
            {
                Program.Log("queue could not be read: " + e.Message);
            }
            return list;
        }

        private static void Save()
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                foreach (Punch p in _items)
                {
                    sb.Append(p.StaffId).Append('\t')
                      .Append(p.At.ToString("o", CultureInfo.InvariantCulture))
                      .Append('\t')
                      .Append(p.Raw.Replace('\t', ' ').Replace('\n', ' '))
                      .Append(Environment.NewLine);
                }
                File.WriteAllText(_path, sb.ToString());
            }
            catch (Exception e)
            {
                Program.Log("queue could not be written: " + e.Message);
            }
        }
    }

    internal static class Json
    {
        public static string Escape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        /// <summary>
        /// A boolean out of parsed JSON.
        ///
        /// Postgres can hand a boolean back as true, as "true" or as "t"
        /// depending on the driver and the query, and this reads all three.
        /// Anything it cannot read is FALSE, which is the safe direction: a
        /// mapping that cannot be confirmed as real must not be trusted as
        /// one.
        /// </summary>
        public static bool Bool(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return false;
            if (v is bool) return (bool)v;
            string t = Convert.ToString(v, CultureInfo.InvariantCulture);
            if (t == null) return false;
            t = t.Trim().ToLowerInvariant();
            return t == "true" || t == "t" || t == "1" || t == "yes";
        }

        public static int Int(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); }
            catch { return 0; }
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }
    }
}
