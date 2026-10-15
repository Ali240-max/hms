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
            Log("mode     " + _cfg.Mode);
            Log("device   " + _cfg.DeviceName);
            Log("process  " + (IntPtr.Size == 4 ? "32-bit" : "64-bit"));

            /*
             * TERMINAL MODE TAKES A COMPLETELY DIFFERENT PATH.
             *
             * It needs no SDK, loads no DLL, holds no templates and matches
             * nobody: the device on the wall has already done all of that.
             * So it branches here, before the SDK is bound — a machine with
             * a K50 and no reader has no ZKFinger DLL to bind, and asking
             * for one would stop the agent for a thing it does not use.
             */
            if (_cfg.Mode == "terminal")
            {
                Log("terminal " + _cfg.DeviceIp + ":" + _cfg.DevicePort);
                return RunTerminal(args);
            }

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


        /* =================================================== terminal mode */

        /*
         * Device user id -> HMS staff id, from the server.
         *
         * The terminal identifies people itself and hands over an id of its
         * own choosing. This is the only thing it cannot tell us.
         */
        private static Dictionary<string, int> _map =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, string> _mapNames =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /** Device ids that are only a guess from the staff id, not a mapping. */
        private static readonly HashSet<string> _guessed =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        /*
         * The newest record already sent, kept on disk.
         *
         * THE DEVICE LOG IS NEVER CLEARED, so without a mark the agent would
         * repost the whole log on every start. The server's five-minute
         * repeat rule would reject most of it, which means the first thing a
         * restart does is fire thousands of requests to be refused — and the
         * ones older than five minutes would NOT be refused and would land
         * twice.
         *
         * A timestamp alone is not enough: several people punch in the same
         * second at shift change, and ">" would drop all but the first while
         * ">=" would resend them forever. So the mark is the timestamp plus
         * the ids already seen at exactly that moment.
         */
        private static DateTime _mark = DateTime.MinValue;
        private static readonly HashSet<string> _markIds =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private static string MarkPath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                "last-punch.txt");
        }

        private static void LoadMark()
        {
            try
            {
                string path = MarkPath();
                if (!File.Exists(path)) return;
                string[] lines = File.ReadAllLines(path);
                if (lines.Length > 0)
                {
                    DateTime t;
                    if (DateTime.TryParse(lines[0], CultureInfo.InvariantCulture,
                            DateTimeStyles.None, out t)) _mark = t;
                }
                for (int i = 1; i < lines.Length; i++)
                {
                    string id = lines[i].Trim();
                    if (id.Length > 0) _markIds.Add(id);
                }
                Log("resuming after " + _mark.ToString("yyyy-MM-dd HH:mm:ss") +
                    " (" + _markIds.Count + " already sent at that second)");
            }
            catch (Exception e) { Log("could not read the last-punch mark: " + Short(e)); }
        }

        private static void SaveMark()
        {
            try
            {
                List<string> lines = new List<string>();
                lines.Add(_mark.ToString("yyyy-MM-ddTHH:mm:ss",
                    CultureInfo.InvariantCulture));
                foreach (string id in _markIds) lines.Add(id);
                File.WriteAllLines(MarkPath(), lines.ToArray());
            }
            catch (Exception e) { Log("could not save the last-punch mark: " + Short(e)); }
        }

        /// <summary>
        /// The roster, which in terminal mode replaces the template list.
        /// </summary>
        private static void LoadRoster()
        {
            string body;
            try
            {
                body = Http.Get(_cfg.Server + "/api/attendance/agent/roster",
                    _cfg.DeviceKey);
            }
            catch (Exception e)
            {
                Log("could not fetch the roster (" + Short(e) + ") — keeping the " +
                    _map.Count + " already loaded");
                return;
            }

            object parsed;
            try { parsed = new JavaScriptSerializer().DeserializeObject(body); }
            catch (Exception e) { Log("roster came back unreadable: " + Short(e)); return; }

            object[] rows = parsed as object[];
            if (rows == null) { Log("roster came back in an unexpected shape"); return; }

            Dictionary<string, int> fresh =
                new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            lock (_mapNames)
            {
                _mapNames.Clear();
                _guessed.Clear();
                int real = 0, guess = 0;
                foreach (object row in rows)
                {
                    Dictionary<string, object> r = row as Dictionary<string, object>;
                    if (r == null) continue;
                    int staffId = Json.Int(r, "staff_id");
                    string devId = Json.Str(r, "device_user_id");
                    string name = Json.Str(r, "display_name");
                    if (staffId <= 0 || devId.Length == 0) continue;

                    /*
                     * A mapping somebody set, or the staff id standing in
                     * for one. The server says which, and the difference
                     * decides whether a punch may be posted at all.
                     */
                    bool isReal = Json.Bool(r, "mapped");
                    if (isReal) real++;
                    else { guess++; _guessed.Add(devId); }

                    if (isReal || _cfg.TrustDeviceIds) fresh[devId] = staffId;
                    _mapNames[devId] = name;
                }
                _map = fresh;

                Log("roster: " + real + " mapped" +
                    (guess > 0 ? ", " + guess + " unmapped" : ""));

                /*
                 * Said every time the roster is read, not once at startup.
                 *
                 * TrustDeviceIds turns every unmapped id into a guess, and a
                 * wrong guess files one person's attendance under another's
                 * name. Nobody finds that later. If it is on, it is going to
                 * be in the log beside the punches it produced.
                 */
                if (guess > 0 && _cfg.TrustDeviceIds)
                {
                    Log("WARNING: TrustDeviceIds is on, so " + guess + " device " +
                        "id(s) with no mapping will be read as staff ids. Run " +
                        "--probe and check the two name columns match before " +
                        "trusting any of it.");
                }
                else if (guess > 0)
                {
                    Log(guess + " staff member(s) have no terminal id set, so " +
                        "punches from an unknown id will be dropped rather than " +
                        "guessed. Set them under Administration > Staff > Edit.");
                }
            }
        }

        /// <summary>
        /// Terminal mode: poll the device, forward what is new.
        /// </summary>
        private static int RunTerminal(string[] args)
        {
            bool probe = false;
            bool setTime = false;
            bool trace = false;
            foreach (string a in args)
            {
                string f = a.Trim().ToLowerInvariant();
                if (f == "--probe" || f == "/probe") probe = true;
                if (f == "--set-time" || f == "/set-time") setTime = true;
                /*
                 * Every packet as hex, both ways.
                 *
                 * Added after a day lost to one wrong byte in the header. A
                 * device answers a malformed packet by closing the socket
                 * and saying nothing, so "forcibly closed by the remote
                 * host" is the whole of the evidence — and from that you
                 * cannot tell a bad magic number from a bad checksum from a
                 * firmware that wanted UDP. With the bytes on screen it is
                 * thirty seconds.
                 */
                if (f == "--trace" || f == "/trace") trace = true;
            }

            if (probe) return Probe(setTime, trace);

            Console.CancelKeyPress += delegate (object s2, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                _running = false;
            };

            Queue.Init(_cfg);
            LoadMark();
            new Thread(SenderLoop) { IsBackground = true, Name = "sender" }.Start();

            LoadRoster();
            DateTime rosterAt = DateTime.UtcNow;

            Log("ready — polling " + _cfg.DeviceIp + " every " +
                _cfg.PollSeconds + "s");

            bool first = _mark == DateTime.MinValue;
            int quietPolls = 0;

            while (_running)
            {
                if ((DateTime.UtcNow - rosterAt).TotalSeconds >= _cfg.ReloadSeconds)
                {
                    LoadRoster();
                    rosterAt = DateTime.UtcNow;
                }

                try
                {
                    int sent = PollOnce(ref first);
                    if (sent > 0)
                    {
                        Log("sent " + sent + " punch(es)");
                        quietPolls = 0;
                    }
                    else
                    {
                        /*
                         * A quiet corridor is normal and must not fill the
                         * log. Said once every thirty polls — ten minutes at
                         * the default — so there is still evidence in the
                         * file that the agent was alive and talking to the
                         * device at 3am.
                         */
                        if (++quietPolls % 30 == 0)
                            Log("still polling; nothing new (" + quietPolls + " quiet checks)");
                    }
                }
                catch (TerminalError te)
                {
                    Log("terminal: " + te.Message);
                }
                catch (Exception e)
                {
                    Log("terminal: " + Short(e));
                }

                SleepUpTo(_cfg.PollSeconds);
            }

            Log("stopping");
            SaveMark();
            return 0;
        }

        /// <summary>
        /// One poll: connect, read, queue what is new, disconnect.
        ///
        /// A fresh connection each time rather than one held open. The
        /// devices drop an idle socket without saying so, and a held
        /// connection that has quietly died looks identical to a quiet
        /// corridor — the agent would report everything normal for a week.
        /// Connecting costs a few hundred milliseconds every twenty seconds.
        /// </summary>
        private static int PollOnce(ref bool first)
        {
            int queued = 0;

            using (Terminal t = new Terminal(_cfg.DeviceIp, _cfg.DevicePort,
                                             _cfg.DevicePassword, 8))
            {
                t.Connect();

                /*
                 * The device's clock, checked against this PC's.
                 *
                 * Every record it hands over is stamped from its own clock.
                 * If that clock is wrong, the attendance is wrong, and
                 * nothing downstream can tell. A battery that died and came
                 * back gives a device sitting in the year 2000 and a day of
                 * punches filed under a date nobody will ever look at.
                 */
                try
                {
                    DateTime dev = t.GetTime();
                    double off = Math.Abs((dev - DateTime.Now).TotalMinutes);
                    if (off > 2)
                    {
                        Log("WARNING: the terminal's clock says " +
                            dev.ToString("yyyy-MM-dd HH:mm") + " and this PC says " +
                            DateTime.Now.ToString("yyyy-MM-dd HH:mm") + " — " +
                            Math.Round(off) + " minutes apart. Every punch is " +
                            "stamped by the TERMINAL, so fix its clock " +
                            "(run the agent once with --probe --set-time).");
                    }
                }
                catch (Exception e) { Log("could not read the terminal clock: " + Short(e)); }

                List<TerminalUser> users = null;
                /*
                 * The user list is only needed to turn an internal uid into
                 * a user id, which the 40-byte record already carries. Read
                 * anyway on the first poll so the log can name anybody whose
                 * mapping is missing, and skipped afterwards because it is
                 * the slow part of the read.
                 */
                if (first)
                {
                    try { users = t.GetUsers(); }
                    catch (Exception e) { Log("could not read the user list: " + Short(e)); }
                    if (users != null) Log("the terminal has " + users.Count + " users enrolled");
                }

                List<TerminalPunch> punches = t.GetAttendance(users);

                DateTime floor = DateTime.MinValue;
                if (first && _cfg.BackfillDays > 0)
                {
                    floor = DateTime.Now.Date.AddDays(-_cfg.BackfillDays);
                    Log("first run: ignoring anything before " +
                        floor.ToString("yyyy-MM-dd") + " (BackfillDays=" +
                        _cfg.BackfillDays + ")");
                }

                int skippedOld = 0, unmapped = 0;
                List<string> unknownIds = new List<string>();

                foreach (TerminalPunch p in punches)
                {
                    if (p.At < floor) { skippedOld++; continue; }

                    /* Already sent: older than the mark, or seen at it. */
                    if (p.At < _mark) continue;
                    if (p.At == _mark && _markIds.Contains(p.UserId)) continue;

                    int staffId;
                    if (!_map.TryGetValue(p.UserId, out staffId))
                    {
                        /*
                         * No mapping. The punch is NOT guessed into a staff
                         * id: a wrong guess files somebody else's attendance
                         * under this person's name, which is worse than a
                         * gap somebody can see and fix.
                         */
                        unmapped++;
                        if (!unknownIds.Contains(p.UserId)) unknownIds.Add(p.UserId);
                        continue;
                    }

                    Queue.Add(new Punch(staffId, p.At,
                        "terminal " + _cfg.DeviceIp + " user " + p.UserId +
                        " status " + p.Status + " punch " + p.Punch));
                    queued++;

                    if (p.At > _mark) { _mark = p.At; _markIds.Clear(); }
                    _markIds.Add(p.UserId);
                }

                if (skippedOld > 0)
                    Log("skipped " + skippedOld + " record(s) older than the backfill window");
                if (unmapped > 0)
                {
                    Log("WARNING: " + unmapped + " punch(es) DROPPED, from device user " +
                        "id(s) " + string.Join(", ", unknownIds.ToArray()) +
                        " which no HMS staff member claims. They are counted here and " +
                        "nowhere else, and they are never guessed at. Set each id " +
                        "against the person in HMS: Administration > Staff > Edit > " +
                        "\"Id on the attendance terminal\", then they will be picked " +
                        "up on the next poll - the device keeps its log, so nothing " +
                        "is lost.");
                }

                if (queued > 0) SaveMark();
            }

            first = false;
            return queued;
        }

        /// <summary>
        /// One-shot diagnosis. The first thing to run, and the only thing
        /// that answers "is this going to work" without changing anything.
        ///
        /// It connects, reads the clock, counts what is on the device, lists
        /// the users and shows the most recent punches with whether each one
        /// maps to somebody in HMS. Posts nothing.
        /// </summary>
        private static int Probe(bool setTime, bool trace)
        {
            Console.WriteLine();
            Console.WriteLine("  Probing " + _cfg.DeviceIp + ":" + _cfg.DevicePort);
            Console.WriteLine();

            try { LoadRoster(); }
            catch (Exception e) { Console.WriteLine("  roster: " + Short(e)); }

            try
            {
                using (Terminal t = new Terminal(_cfg.DeviceIp, _cfg.DevicePort,
                                                 _cfg.DevicePassword, 10))
                {
                    if (trace) t.TraceOn();
                    t.Connect();
                    Console.WriteLine("  connected");

                    try
                    {
                        DateTime dev = t.GetTime();
                        double off = (dev - DateTime.Now).TotalMinutes;
                        Console.WriteLine("  device clock  " +
                            dev.ToString("yyyy-MM-dd HH:mm:ss") +
                            "   (this PC is " + Math.Round(-off) + " min different)");
                        if (setTime)
                        {
                            t.SetTime(DateTime.Now);
                            Console.WriteLine("  device clock set to this PC's time");
                        }
                    }
                    catch (Exception e) { Console.WriteLine("  clock: " + Short(e)); }

                    try
                    {
                        Sizes s = t.ReadSizes();
                        Console.WriteLine("  users " + s.Users + ", fingers " + s.Fingers +
                            ", records " + s.Records + " of " + s.RecordCapacity);
                    }
                    catch (Exception e) { Console.WriteLine("  counters: " + Short(e)); }

                    List<TerminalUser> users = new List<TerminalUser>();
                    try
                    {
                        users = t.GetUsers();
                        Console.WriteLine();
                        Console.WriteLine("  ON THE DEVICE                 IN HMS");
                        Console.WriteLine("  " + new string('-', 62));

                        int unmapped = 0, suspect = 0;
                        foreach (TerminalUser u in users)
                        {
                            int staffId;
                            bool have = _map.TryGetValue(u.UserId, out staffId);
                            string hmsName = _mapNames.ContainsKey(u.UserId)
                                ? _mapNames[u.UserId] : "";
                            bool guess = _guessed.Contains(u.UserId);

                            string right;
                            if (!have && !guess) { right = "-- NOBODY --"; unmapped++; }
                            else if (!have)
                            {
                                /* A guess the agent is not allowed to use. */
                                right = "not mapped (would be staff " + hmsName + ")";
                                unmapped++;
                            }
                            else if (guess)
                            {
                                /*
                                 * A guess the agent IS allowed to use. Flag it
                                 * when the two names do not look like the same
                                 * person, because that is the whole failure in
                                 * one line and it is readable at a glance.
                                 */
                                bool looksRight = Sameish(u.Name, hmsName);
                                right = "staff " + staffId + "  " + hmsName +
                                    (looksRight ? "   (guessed)" : "   <<< DIFFERENT PERSON");
                                if (!looksRight) suspect++;
                            }
                            else
                            {
                                right = "staff " + staffId + "  " + hmsName;
                            }

                            Console.WriteLine("  id " + Pad(u.UserId, 6) +
                                Pad(u.Name, 20) + right);
                        }

                        Console.WriteLine();
                        if (suspect > 0)
                        {
                            Console.WriteLine("  ** " + suspect + " of these pair two DIFFERENT " +
                                "names. TrustDeviceIds is on, so those");
                            Console.WriteLine("  ** punches would be filed against the wrong " +
                                "person. Set TrustDeviceIds=false");
                            Console.WriteLine("  ** in agent.ini and map people properly: " +
                                "Administration > Staff > Edit.");
                            Console.WriteLine();
                        }
                        if (unmapped > 0)
                        {
                            Console.WriteLine("  " + unmapped + " device user(s) are not mapped. " +
                                "Their punches are counted, named in");
                            Console.WriteLine("  the log and DROPPED - never guessed at. " +
                                "Set each person's device id");
                            Console.WriteLine("  under Administration > Staff > Edit, " +
                                "\"Id on the attendance terminal\".");
                            Console.WriteLine();
                        }
                    }
                    catch (Exception e) { Console.WriteLine("  users: " + Short(e)); }

                    try
                    {
                        List<TerminalPunch> p = t.GetAttendance(users);
                        Console.WriteLine();
                        Console.WriteLine("  " + p.Count + " punch(es) on the device" +
                            (p.Count > 0 ? ", last 10:" : ""));
                        int from = Math.Max(0, p.Count - 10);
                        for (int i = from; i < p.Count; i++)
                        {
                            int staffId;
                            Console.WriteLine("    " +
                                p[i].At.ToString("yyyy-MM-dd HH:mm:ss") +
                                "  id " + Pad(p[i].UserId, 8) +
                                (_map.TryGetValue(p[i].UserId, out staffId)
                                    ? "-> staff " + staffId
                                    : "-> NOT MAPPED") +
                                "   (" + p[i].Layout + "-byte record)");
                        }
                    }
                    catch (Exception e) { Console.WriteLine("  attendance: " + Short(e)); }
                }

                Console.WriteLine();
                Console.WriteLine("  Nothing was posted and nothing on the device was changed.");
                Console.WriteLine();
                return 0;
            }
            catch (Exception e)
            {
                Console.WriteLine();
                Console.WriteLine("  FAILED: " + e.Message);
                Console.WriteLine();
                Console.WriteLine("  Things to check, in order:");
                Console.WriteLine("    1. ping " + _cfg.DeviceIp);
                Console.WriteLine("    2. the device is on the same subnet as this PC");
                Console.WriteLine("    3. Menu > Comm > Ethernet on the device shows that address");
                Console.WriteLine("    4. ZKBio Time or any other software is CLOSED — some");
                Console.WriteLine("       firmware allows only one connection at a time");
                Console.WriteLine("    5. DevicePassword matches Comm > Security > Comm Key");
                Console.WriteLine();
                if (!trace)
                {
                    Console.WriteLine("  To see the actual packets, run:");
                    Console.WriteLine("    hms-attendance-agent.exe --probe --trace");
                    Console.WriteLine();
                }
                return 5;
            }
        }

        /// <summary>
        /// Do these two names plausibly belong to the same person?
        ///
        /// Deliberately loose. A device holds "Yasir" where HMS holds
        /// "Dr Yasir Habib", and those are the same man; it holds "Yasir"
        /// where HMS holds "Administrator", and those are not. So: letters
        /// only, lower case, and does either contain the other.
        ///
        /// It only decides whether to print a warning. Nothing is accepted
        /// or rejected on the strength of a name.
        /// </summary>
        private static bool Sameish(string a, string b)
        {
            string x = Letters(a), y = Letters(b);
            if (x.Length == 0 || y.Length == 0) return false;
            return x.IndexOf(y, StringComparison.Ordinal) >= 0
                || y.IndexOf(x, StringComparison.Ordinal) >= 0;
        }

        private static string Letters(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder();
            foreach (char c in s) if (char.IsLetter(c)) sb.Append(char.ToLowerInvariant(c));
            return sb.ToString();
        }

        private static string Pad(string s, int n)
        {
            if (s == null) s = "";
            if (s.Length >= n) return s.Substring(0, n - 1) + " ";
            return s + new string(' ', n - s.Length);
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
