using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace HmsAttendance
{
    /// <summary>
    /// The HMS attendance agent.
    ///
    /// Sits on the PC with the fingerprint reader plugged into it, matches a
    /// finger against the templates HMS holds, and posts the result to the
    /// server. Nothing else.
    ///
    /// Written for .NET Framework 4.x and the C# 5 compiler that ships inside
    /// Windows, so it builds on an offline hospital machine with build.bat and
    /// no installs, no Visual Studio, no SDK, no internet. That rules out
    /// string interpolation and anything newer, which is why the string
    /// handling below looks dated. It is deliberate.
    /// </summary>
    internal static class Program
    {
        private static Config _cfg;
        private static readonly object _logLock = new object();

        private static IntPtr _dev = IntPtr.Zero;
        private static IntPtr _db = IntPtr.Zero;

        /* fid -> who it is, so a match can be named in the log. */
        private static readonly Dictionary<int, string> _names =
            new Dictionary<int, string>();

        /*
         * The last time each finger was accepted.
         *
         * The reader fires continuously while a finger rests on the glass, so
         * one press is twenty captures. The server also refuses repeats
         * within five minutes, but letting twenty posts leave this machine
         * for one press would fill the log and the network for nothing. This
         * is the local half of that rule.
         */
        private static readonly Dictionary<int, DateTime> _lastSeen =
            new Dictionary<int, DateTime>();

        private static readonly TimeSpan COOLDOWN = TimeSpan.FromSeconds(5);

        private static Enrolment _enrolling;
        private static readonly object _enrolLock = new object();

        private static volatile bool _running = true;

        private static int Main(string[] args)
        {
            Console.Title = "HMS attendance agent";
            try
            {
                _cfg = Config.Load();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
                return 2;
            }

            Log("--------------------------------------------------");
            Log("HMS attendance agent starting");
            Log("server   " + _cfg.Server);
            Log("reader   " + _cfg.DeviceName);
            Log("process  " + (IntPtr.Size == 4 ? "32-bit" : "64-bit"));

            /*
             * Said out loud, because it is the first thing that goes wrong.
             *
             * The ZKFinger DLLs are 32-bit. A 64-bit build loads nothing and
             * fails with an unhelpful BadImageFormatException, so the process
             * states its own architecture in the log before anything else can
             * break.
             */
            if (IntPtr.Size != 4)
            {
                Log("WARNING: this is a 64-bit build. The ZKFinger DLLs are 32-bit " +
                    "and will probably refuse to load. Rebuild with build.bat.");
            }

            try
            {
                Zk.Bind();
            }
            catch (Exception e)
            {
                Log("SDK: " + e.Message);
                Log("The agent cannot run without the reader SDK. Stopping.");
                return 3;
            }

            if (!StartReader()) return 4;

            Console.CancelKeyPress += delegate (object s, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                _running = false;
            };

            Queue.Init(_cfg);

            new Thread(SenderLoop) { IsBackground = true, Name = "sender" }.Start();
            new Thread(ReloadLoop) { IsBackground = true, Name = "reload" }.Start();
            StartLocalApi();

            LoadTemplates();

            Log("ready — place a finger on the reader");
            CaptureLoop();

            Log("stopping");
            StopReader();
            return 0;
        }

        /* ------------------------------------------------------- the reader */

        private static bool StartReader()
        {
            int r = Zk.Init();
            /*
             * Already initialised is success, not failure. A service restarted
             * quickly can find the library still up from the previous run, and
             * treating that as an error would refuse to start for no reason.
             */
            if (r != Zk.OK && r != Zk.ERR_ALREADY_INIT)
            {
                Log("Init failed: " + Zk.Explain(r));
                return false;
            }

            int count = Zk.GetDeviceCount();
            Log("readers found: " + count);
            if (count <= 0)
            {
                Log("No reader is plugged in. Check the USB cable and that the " +
                    "ZKFinger driver is installed, then start the agent again.");
                Zk.Terminate();
                return false;
            }

            _dev = Zk.OpenDevice(_cfg.DeviceIndex);
            if (_dev == IntPtr.Zero)
            {
                Log("Could not open reader " + _cfg.DeviceIndex +
                    ". Another program may already have it open — ZKTeco's own " +
                    "attendance software holds the device exclusively.");
                Zk.Terminate();
                return false;
            }

            _db = Zk.DBInit();
            if (_db == IntPtr.Zero)
            {
                Log("Could not start the matching library.");
                Zk.CloseDevice(_dev);
                Zk.Terminate();
                return false;
            }

            return true;
        }

        private static void StopReader()
        {
            try { if (_db != IntPtr.Zero) Zk.DBFree(_db); } catch { }
            try { if (_dev != IntPtr.Zero) Zk.CloseDevice(_dev); } catch { }
            try { Zk.Terminate(); } catch { }
        }

        /* ---------------------------------------------------- the templates */

        /// <summary>
        /// Load every enrolled finger into the matching library.
        ///
        /// This has to happen on every start and cannot be skipped: the
        /// library holds templates in memory only, so a restarted service
        /// knows nobody until this runs. HMS is the only place they are kept.
        /// </summary>
        private static void LoadTemplates()
        {
            string body;
            try
            {
                body = Http.Get(_cfg.Server + "/api/attendance/agent/templates",
                    _cfg.DeviceKey);
            }
            catch (Exception e)
            {
                /*
                 * Not fatal. The agent keeps whatever it already had loaded
                 * and tries again on the next cycle: a reader that still
                 * recognises this morning's staff is better than one that
                 * recognises nobody because the server rebooted.
                 */
                Log("could not fetch templates (" + Short(e) + ") — keeping the " +
                    _names.Count + " already loaded");
                return;
            }

            object parsed;
            try { parsed = new JavaScriptSerializer().DeserializeObject(body); }
            catch (Exception e)
            {
                Log("templates came back unreadable: " + Short(e));
                return;
            }

            object[] rows = parsed as object[];
            if (rows == null)
            {
                Log("templates came back in an unexpected shape");
                return;
            }

            lock (_enrolLock)
            {
                Zk.DBClear(_db);
                _names.Clear();

                int loaded = 0, refused = 0;
                foreach (object row in rows)
                {
                    Dictionary<string, object> r = row as Dictionary<string, object>;
                    if (r == null) continue;

                    int staffId = Json.Int(r, "staff_id");
                    int finger = Json.Int(r, "finger_index");
                    string b64 = Json.Str(r, "template");
                    string name = Json.Str(r, "display_name");
                    if (staffId <= 0 || b64.Length == 0) continue;

                    byte[] tmp;
                    try { tmp = Convert.FromBase64String(b64); }
                    catch { refused++; continue; }

                    int fid = Fid.Make(staffId, finger);
                    int rc = Zk.DBAdd(_db, fid, tmp);
                    if (rc == Zk.OK) { _names[fid] = name; loaded++; }
                    else refused++;
                }

                Log("templates loaded: " + loaded +
                    (refused > 0 ? " (" + refused + " refused)" : ""));
            }
        }

        /// <summary>
        /// Templates are re-read on a slow timer.
        ///
        /// Somebody enrolled on another PC should be recognised here without
        /// anybody restarting a service they do not know exists.
        /// </summary>
        private static void ReloadLoop()
        {
            while (_running)
            {
                SleepUpTo(_cfg.ReloadSeconds);
                if (!_running) return;
                LoadTemplates();
            }
        }

        /* ------------------------------------------------------ the capture */

        private static void CaptureLoop()
        {
            byte[] image = new byte[Zk.IMAGE_BYTES];
            byte[] template = new byte[Zk.TEMPLATE_BYTES];

            while (_running)
            {
                int size = Zk.TEMPLATE_BYTES;
                int r;
                try
                {
                    r = Zk.AcquireFingerprint(_dev, image, template, ref size);
                }
                catch (Exception e)
                {
                    Log("capture threw: " + Short(e));
                    Thread.Sleep(1000);
                    continue;
                }

                if (r != Zk.OK)
                {
                    /*
                     * An empty glass is the normal answer, and arrives many
                     * times a second. Only the unusual codes are logged, or
                     * the log would be nothing but "nothing on the glass".
                     */
                    if (r != Zk.ERR_CAPTURE && r != Zk.ERR_BUSY)
                    {
                        if (r == Zk.ERR_EXTRACT_FP) Log("unreadable print");
                        else Log("capture: " + Zk.Explain(r));
                    }
                    Thread.Sleep(120);
                    continue;
                }

                byte[] captured = new byte[size];
                Array.Copy(template, captured, size);

                Enrolment job;
                lock (_enrolLock) { job = _enrolling; }

                if (job != null) HandleEnrolCapture(job, captured);
                else HandleIdentify(captured);
            }
        }

        private static void HandleIdentify(byte[] captured)
        {
            int fid = 0, score = 0;
            int r = Zk.DBIdentify(_db, captured, ref fid, ref score);

            if (r != Zk.OK)
            {
                Log("not recognised");
                Thread.Sleep(600);
                return;
            }

            DateTime now = DateTime.Now;
            lock (_lastSeen)
            {
                DateTime last;
                if (_lastSeen.TryGetValue(fid, out last) && now - last < COOLDOWN)
                {
                    /* Same finger still resting on the glass. */
                    Thread.Sleep(300);
                    return;
                }
                _lastSeen[fid] = now;
            }

            int staffId = Fid.StaffId(fid);
            string who;
            if (!_names.TryGetValue(fid, out who)) who = "staff " + staffId;

            Log("matched " + who + " (score " + score + ")");

            Queue.Add(new Punch(staffId, now,
                "SLK20R fid=" + fid + " score=" + score));

            /* Let the finger come off the glass before looking again. */
            Thread.Sleep(900);
        }

        /* ----------------------------------------------------- the enrolment */

        private static void HandleEnrolCapture(Enrolment job, byte[] captured)
        {
            lock (_enrolLock)
            {
                if (_enrolling != job) return;

                /*
                 * Every capture must be the same finger as the first.
                 *
                 * Without this, somebody using a different finger each time
                 * produces a merged template that matches none of the three,
                 * and the failure only shows up weeks later at a door.
                 */
                if (job.Captures.Count > 0)
                {
                    int m = Zk.DBMatch(_db, job.Captures[0], captured);
                    if (m <= 0)
                    {
                        job.Message = "That is a different finger. Use the same one.";
                        Log("enrol: different finger, ignored");
                        Thread.Sleep(900);
                        return;
                    }
                }

                job.Captures.Add(captured);
                job.Message = "";
                Log("enrol: capture " + job.Captures.Count + " of 3");

                if (job.Captures.Count < 3)
                {
                    Thread.Sleep(900);
                    return;
                }

                byte[] reg = new byte[Zk.TEMPLATE_BYTES];
                int regLen = Zk.TEMPLATE_BYTES;
                int r = Zk.DBMerge(_db, job.Captures[0], job.Captures[1],
                    job.Captures[2], reg, ref regLen);

                if (r != Zk.OK)
                {
                    job.Failed = true;
                    job.Message = Zk.Explain(r) + " — start again";
                    Log("enrol: merge failed: " + Zk.Explain(r));
                    /*
                     * Kept so the screen can read the outcome AFTER the job
                     * ends. Clearing _enrolling without this left the browser
                     * polling an idle agent, with no way to tell a finished
                     * enrolment from one that never started.
                     */
                    _lastEnrolment = job;
                    _enrolling = null;
                    return;
                }

                byte[] stored = new byte[regLen];
                Array.Copy(reg, stored, regLen);
                job.Template = Convert.ToBase64String(stored);

                int fid = Fid.Make(job.StaffId, job.FingerIndex);
                Zk.DBDel(_db, fid);          // replacing an earlier enrolment
                Zk.DBAdd(_db, fid, stored);

                job.Done = true;
                job.Message = "Finger enrolled.";
                Log("enrol: done for staff " + job.StaffId +
                    " finger " + job.FingerIndex);
                _lastEnrolment = job;
                _enrolling = null;
            }
        }

        /* ------------------------------------------------- the local HTTP API */

        /// <summary>
        /// A small HTTP server on this machine, for the enrolment screen.
        ///
        /// A browser cannot touch USB, so the HMS staff screen talks to this
        /// instead. It listens on the loopback address only: nothing on the
        /// hospital network can reach it, which is the point.
        /// </summary>
        private static void StartLocalApi()
        {
            HttpListener listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + _cfg.LocalPort + "/");
            try
            {
                listener.Start();
            }
            catch (Exception e)
            {
                /*
                 * Windows refuses a listener to a non-administrator unless the
                 * URL is reserved. As a service it runs as LocalSystem and
                 * this never happens; run by hand it happens every time, so
                 * the fix is in the message rather than in a document.
                 */
                Log("Could not listen on port " + _cfg.LocalPort + ": " + Short(e));
                Log("If running by hand, open an administrator prompt once and run:");
                Log("  netsh http add urlacl url=http://127.0.0.1:" +
                    _cfg.LocalPort + "/ user=Everyone");
                Log("Enrolment will not work until then. Scanning still will.");
                return;
            }

            Log("enrolment api on http://127.0.0.1:" + _cfg.LocalPort);

            new Thread(delegate ()
            {
                while (_running)
                {
                    try
                    {
                        HttpListenerContext ctx = listener.GetContext();
                        ThreadPool.QueueUserWorkItem(delegate (object s)
                        {
                            try { Serve((HttpListenerContext)s); } catch { }
                        }, ctx);
                    }
                    catch (Exception e)
                    {
                        if (_running) Log("local api: " + Short(e));
                    }
                }
            }) { IsBackground = true, Name = "localapi" }.Start();
        }

        private static void Serve(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            /*
             * The HMS page is served from another origin, so it needs these.
             * Safe because the listener is bound to loopback: only something
             * already running on this machine can reach it at all.
             */
            res.AddHeader("Access-Control-Allow-Origin", "*");
            res.AddHeader("Access-Control-Allow-Headers", "content-type");
            res.AddHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

            if (req.HttpMethod == "OPTIONS") { Send(res, 204, ""); return; }

            string path = req.Url.AbsolutePath.TrimEnd('/');

            if (path == "/status")
            {
                lock (_enrolLock)
                {
                    Send(res, 200, "{\"ok\":true,\"reader\":\"" +
                        Json.Escape(_cfg.DeviceName) + "\",\"templates\":" +
                        _names.Count + ",\"queued\":" + Queue.Count() +
                        ",\"enrolling\":" + (_enrolling != null ? "true" : "false") + "}");
                }
                return;
            }

            if (path == "/enrol/start" && req.HttpMethod == "POST")
            {
                string body = new StreamReader(req.InputStream, Encoding.UTF8).ReadToEnd();
                Dictionary<string, object> b;
                try
                {
                    b = new JavaScriptSerializer()
                        .DeserializeObject(body) as Dictionary<string, object>;
                }
                catch { b = null; }

                if (b == null) { Send(res, 400, "{\"error\":\"bad body\"}"); return; }

                int staffId = Json.Int(b, "staffId");
                int finger = Json.Int(b, "fingerIndex");
                if (finger <= 0) finger = 1;
                if (staffId <= 0) { Send(res, 400, "{\"error\":\"staffId\"}"); return; }

                lock (_enrolLock)
                {
                    /* A new run must not report the previous run's result. */
                    _lastEnrolment = null;
                    _enrolling = new Enrolment(staffId, finger);
                }
                Log("enrol: started for staff " + staffId + " finger " + finger);
                Send(res, 200, "{\"ok\":true}");
                return;
            }

            if (path == "/enrol/progress")
            {
                lock (_enrolLock)
                {
                    Enrolment j = _enrolling;
                    if (j == null)
                    {
                        Enrolment last = _lastEnrolment;
                        if (last != null && (last.Done || last.Failed))
                        {
                            Send(res, 200, "{\"captures\":" + last.Captures.Count +
                                ",\"done\":" + (last.Done ? "true" : "false") +
                                ",\"failed\":" + (last.Failed ? "true" : "false") +
                                ",\"message\":\"" + Json.Escape(last.Message) + "\"" +
                                ",\"template\":" + (last.Template == null ? "null"
                                    : "\"" + last.Template + "\"") + "}");
                            return;
                        }
                        Send(res, 200, "{\"captures\":0,\"idle\":true}");
                        return;
                    }
                    Send(res, 200, "{\"captures\":" + j.Captures.Count +
                        ",\"done\":false,\"failed\":false,\"message\":\"" +
                        Json.Escape(j.Message) + "\"}");
                }
                return;
            }

            if (path == "/enrol/cancel" && req.HttpMethod == "POST")
            {
                lock (_enrolLock) { _enrolling = null; }
                Log("enrol: cancelled");
                Send(res, 200, "{\"ok\":true}");
                return;
            }

            Send(res, 404, "{\"error\":\"no such path\"}");
        }

        private static Enrolment _lastEnrolment;

        private static void Send(HttpListenerResponse res, int code, string body)
        {
            res.StatusCode = code;
            res.ContentType = "application/json";
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.OutputStream.Close();
        }

        /* --------------------------------------------------------- the sender */

        /// <summary>
        /// Posts queued punches, and keeps them until the server confirms.
        ///
        /// The queue is on disk, so a punch survives the agent being killed,
        /// the PC being rebooted and the network being out for a day. Nothing
        /// is deleted until the server has taken it.
        /// </summary>
        private static void SenderLoop()
        {
            while (_running)
            {
                Punch p = Queue.Peek();
                if (p == null) { SleepUpTo(2); continue; }

                string body = "{\"staffId\":" + p.StaffId +
                    ",\"at\":\"" + p.At.ToString("yyyy-MM-ddTHH:mm:ssK",
                        CultureInfo.InvariantCulture) + "\"" +
                    ",\"raw\":\"" + Json.Escape(p.Raw) + "\"}";

                try
                {
                    Http.Post(_cfg.Server + "/api/attendance/agent/punch",
                        _cfg.DeviceKey, body);
                    Queue.Drop();
                    Log("posted " + p.StaffId + " at " + p.At.ToString("HH:mm:ss"));
                }
                catch (HttpError he)
                {
                    /*
                     * The server answering "no" is final; the network failing
                     * is not. A punch the server refused — an exempt person,
                     * a staff member since deleted — would otherwise be
                     * retried every two seconds until somebody noticed.
                     *
                     * Anything in the 400s is the server's considered answer.
                     * A 500 or a dropped connection is not, so those wait.
                     */
                    if (he.Status >= 400 && he.Status < 500)
                    {
                        Log("server refused punch for " + p.StaffId + ": " +
                            he.Status + " " + he.Body);
                        Queue.Drop();
                    }
                    else
                    {
                        Log("server error " + he.Status + ", will retry");
                        SleepUpTo(5);
                    }
                }
                catch (Exception e)
                {
                    Log("cannot reach the server (" + Short(e) + "), " +
                        Queue.Count() + " waiting");
                    SleepUpTo(10);
                }
            }
        }

        /* ----------------------------------------------------------- helpers */

        /// <summary>Sleeps, but wakes early when the agent is stopping.</summary>
        private static void SleepUpTo(int seconds)
        {
            for (int i = 0; i < seconds * 10 && _running; i++) Thread.Sleep(100);
        }

        private static string Short(Exception e)
        {
            return e.Message.Length > 140 ? e.Message.Substring(0, 140) : e.Message;
        }

        public static void Log(string line)
        {
            string stamped = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line;
            lock (_logLock)
            {
                Console.WriteLine(stamped);
                try
                {
                    string dir = AppDomain.CurrentDomain.BaseDirectory;
                    string file = Path.Combine(dir, "agent-" +
                        DateTime.Now.ToString("yyyy-MM-dd") + ".log");
                    File.AppendAllText(file, stamped + Environment.NewLine);
                }
                catch { /* a log that cannot be written must not stop the door */ }
            }
        }
    }

    /// <summary>
    /// How a staff member and a finger become the one integer the matching
    /// library understands.
    ///
    /// DBIdentify hands back whatever was passed to DBAdd, so the mapping has
    /// to be reversible with no lookup table. Ten fingers per person is the
    /// limit, which is the correct number of fingers.
    /// </summary>
    internal static class Fid
    {
        public static int Make(int staffId, int fingerIndex)
        {
            int f = fingerIndex < 1 ? 1 : (fingerIndex > 9 ? 9 : fingerIndex);
            return staffId * 10 + f;
        }

        public static int StaffId(int fid) { return fid / 10; }
        public static int FingerIndex(int fid) { return fid % 10; }
    }

    internal class Enrolment
    {
        public readonly int StaffId;
        public readonly int FingerIndex;
        public readonly List<byte[]> Captures = new List<byte[]>();
        public string Template;
        public string Message = "";
        public bool Done;
        public bool Failed;

        public Enrolment(int staffId, int fingerIndex)
        {
            StaffId = staffId;
            FingerIndex = fingerIndex;
        }
    }

    internal class Punch
    {
        public readonly int StaffId;
        public readonly DateTime At;
        public readonly string Raw;

        public Punch(int staffId, DateTime at, string raw)
        {
            StaffId = staffId;
            At = at;
            Raw = raw;
        }
    }
}
