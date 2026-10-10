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
                "ReloadSeconds=300" + Environment.NewLine);
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
