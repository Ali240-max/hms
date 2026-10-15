using System;
using System.Reflection;

namespace HmsAttendance
{
    /// <summary>
    /// The ZKFinger SDK, reached by reflection.
    ///
    /// The SDK ships libzkfpcsharp.dll with TWO generations of wrapper in it,
    /// and which one a machine has depends on when the driver was installed:
    ///
    ///   zkfp    older, an instance class: fp.OpenDevice(1), no handles
    ///   zkfp2   current, static, handle based: zkfp2.OpenDevice(0) -> IntPtr
    ///
    /// A compile-time reference to the wrong one is a TypeLoadException on a
    /// machine I cannot test, at a hospital, with the device in somebody's
    /// hand. Binding by name at runtime costs a few milliseconds once and
    /// turns that into a sentence saying exactly which method was missing.
    ///
    /// It also means this agent COMPILES ON ANY WINDOWS MACHINE, with or
    /// without the SDK installed, which matters when the machine that has the
    /// reader is not the machine with a compiler on it.
    ///
    /// Signatures are from ZKFinger Reader SDK C# guide (V2), section 5.3.
    /// </summary>
    internal static class Zk
    {
        /* ----------------------------------------------------- error codes */
        /* Section 6.2 of the SDK guide. Only the ones this agent acts on. */
        public const int OK = 0;
        public const int ERR_ALREADY_INIT = 1;
        public const int ERR_NO_DEVICE = -3;
        public const int ERR_OPEN = -6;
        public const int ERR_CAPTURE = -8;        // no finger on the glass
        public const int ERR_EXTRACT_FP = -9;     // a smudge, not a print
        public const int ERR_BUSY = -12;
        public const int ERR_ADD_FINGER = -13;
        public const int ERR_FAIL = -17;
        public const int ERR_MERGE = -22;
        public const int ERR_NOT_OPENED = -23;
        public const int ERR_NOT_INIT = -24;

        /// <summary>The SDK recommends 2048 bytes for any template buffer.</summary>
        public const int TEMPLATE_BYTES = 2048;

        /*
         * The image buffer is deliberately oversized.
         *
         * The correct size is width * height, read with GetParameters using
         * parameter codes the SDK guide I could find does not state. Rather
         * than guess a code and have AcquireFingerprint write past the end of
         * a short buffer, the buffer is simply bigger than any reader in this
         * family produces. The SLK20R is 300x400; 640x480 covers it and the
         * rest of the ZK series with room to spare, and costs 300 KB once.
         */
        public const int IMAGE_BYTES = 640 * 480;

        private static Type _t;

        private static MethodInfo _init, _terminate, _deviceCount, _openDevice,
            _closeDevice, _acquire, _dbInit, _dbFree, _dbMerge, _dbAdd, _dbDel,
            _dbClear, _dbIdentify, _dbMatch;

        /// <summary>
        /// Find the wrapper and every method this agent uses.
        ///
        /// Everything is resolved up front so a missing method is reported at
        /// startup, in the log, by name — not at three in the morning when
        /// somebody enrols their first finger.
        /// </summary>
        public static void Bind()
        {
            Assembly asm = LoadWrapper();

            _t = asm.GetType("libzkfpcsharp.zkfp2", false)
                 ?? asm.GetType("zkfp2", false);

            if (_t == null)
            {
                throw new Exception(
                    "libzkfpcsharp.dll was loaded but has no zkfp2 class. " +
                    "This is the older SDK. Install ZKFinger SDK 5.x and try again.");
            }

            _init = Need("Init");
            _terminate = Need("Terminate");
            _deviceCount = Need("GetDeviceCount");
            _openDevice = Need("OpenDevice");
            _closeDevice = Need("CloseDevice");
            _acquire = Need("AcquireFingerprint");
            _dbInit = Need("DBInit");
            _dbFree = Need("DBFree");
            _dbMerge = Need("DBMerge");
            _dbAdd = Need("DBAdd");
            _dbDel = Need("DBDel");
            _dbClear = Need("DBClear");
            _dbIdentify = Need("DBIdentify");

            /*
             * The one method whose name differs from its own documentation.
             *
             * Section 5.3.17 is titled DBMatch and the method in it is called
             * Match. Both spellings are accepted because I cannot see which
             * one a given build actually exports, and it is only used during
             * enrolment to check three captures are the same finger.
             */
            _dbMatch = Find("DBMatch") ?? Find("Match");
            if (_dbMatch == null) throw new Exception(
                "Neither DBMatch nor Match found on zkfp2.");

            /*
             * Optional: the reader's own lights and buzzer.
             *
             * Not required, because the agent works without them and some
             * wrapper builds may not export it. Missing is said once in the
             * log and otherwise ignored.
             */
            _setParameters = Find("SetParameters");
        }

        private static MethodInfo _setParameters;

        public static bool CanSignal { get { return _setParameters != null; } }

        /*
         * Parameter codes for the reader's lights and buzzer, from the
         * ZKFinger SDK's SetParameters: 101 white light, 102 green, 103 red,
         * 104 buzzer; a 4-byte 1 turns one on and 0 off.
         *
         * NOT YET SEEN WORKING ON THE LIVE20R AT THIS HOSPITAL. A code the
         * device does not know is refused with an error and does nothing,
         * which is why this can be tried safely and switched off in agent.ini
         * (Feedback=false) if it misbehaves.
         */
        private const int PARAM_GREEN = 102;
        private const int PARAM_RED = 103;
        private const int PARAM_BEEP = 104;

        private static void SetParam(IntPtr dev, int code, int value)
        {
            if (_setParameters == null) return;
            byte[] v = BitConverter.GetBytes(value);
            try { _setParameters.Invoke(null, new object[] { dev, code, v, v.Length }); }
            catch { /* a light that will not light must not stop the door */ }
        }

        /// <summary>
        /// Green and a short beep for yes, red and a longer beep for no.
        ///
        /// Called only from the capture thread, so it never talks to the
        /// device at the same moment as a capture.
        /// </summary>
        public static void Signal(IntPtr dev, bool ok)
        {
            if (_setParameters == null || dev == IntPtr.Zero) return;
            int light = ok ? PARAM_GREEN : PARAM_RED;
            SetParam(dev, light, 1);
            SetParam(dev, PARAM_BEEP, 1);
            System.Threading.Thread.Sleep(ok ? 150 : 400);
            SetParam(dev, PARAM_BEEP, 0);
            System.Threading.Thread.Sleep(ok ? 150 : 200);
            SetParam(dev, light, 0);
        }

        private static Assembly LoadWrapper()
        {
            /*
             * Beside the exe first, then wherever the SDK installer put it.
             *
             * Copying libzkfpcsharp.dll next to this agent is the arrangement
             * that survives a driver reinstall moving things around, so it is
             * tried first and documented as the thing to do.
             */
            string[] tries = new string[] {
                System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    "libzkfpcsharp.dll"),
                System.IO.Path.Combine(Environment.GetFolderPath(
                    Environment.SpecialFolder.System), "libzkfpcsharp.dll"),
                System.IO.Path.Combine(Environment.GetFolderPath(
                    Environment.SpecialFolder.SystemX86), "libzkfpcsharp.dll")
            };

            foreach (string path in tries)
            {
                try
                {
                    if (System.IO.File.Exists(path)) return Assembly.LoadFrom(path);
                }
                catch (Exception e)
                {
                    /*
                     * A BadImageFormatException here is the bitness problem,
                     * and it is the single most likely thing to go wrong on a
                     * machine I cannot test. Said plainly rather than left as
                     * a stack trace.
                     */
                    if (e is BadImageFormatException)
                    {
                        throw new Exception(
                            "Found " + path + " but it is the wrong architecture " +
                            "for this process. Build the agent for x86 (build.bat " +
                            "does this) — the ZKFinger DLLs are 32-bit.", e);
                    }
                }
            }

            throw new Exception(
                "libzkfpcsharp.dll not found. Install the ZKFinger SDK 5.x " +
                "driver, then copy libzkfpcsharp.dll next to this agent. " +
                "Looked in: " + string.Join(" , ", tries));
        }

        private static MethodInfo Find(string name)
        {
            return _t.GetMethod(name,
                BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy);
        }

        private static MethodInfo Need(string name)
        {
            MethodInfo m = Find(name);
            if (m == null) throw new Exception(
                "zkfp2." + name + " not found. The installed ZKFinger SDK is not " +
                "the version this agent expects (5.x).");
            return m;
        }

        /* --------------------------------------------------------- the API */

        public static int Init()
        {
            return (int)_init.Invoke(null, null);
        }

        public static int Terminate()
        {
            return (int)_terminate.Invoke(null, null);
        }

        public static int GetDeviceCount()
        {
            return (int)_deviceCount.Invoke(null, null);
        }

        public static IntPtr OpenDevice(int index)
        {
            return (IntPtr)_openDevice.Invoke(null, new object[] { index });
        }

        public static int CloseDevice(IntPtr dev)
        {
            return (int)_closeDevice.Invoke(null, new object[] { dev });
        }

        /// <summary>
        /// One capture. Returns OK when a finger was read and a template
        /// extracted; ERR_CAPTURE when the glass is empty, which is the
        /// normal answer most of the time.
        /// </summary>
        public static int AcquireFingerprint(IntPtr dev, byte[] image,
            byte[] template, ref int templateLength)
        {
            object[] args = new object[] { dev, image, template, templateLength };
            int r = (int)_acquire.Invoke(null, args);
            templateLength = (int)args[3];
            return r;
        }

        public static IntPtr DBInit()
        {
            return (IntPtr)_dbInit.Invoke(null, null);
        }

        public static int DBFree(IntPtr db)
        {
            return (int)_dbFree.Invoke(null, new object[] { db });
        }

        /// <summary>Three captures of one finger into one stored template.</summary>
        public static int DBMerge(IntPtr db, byte[] t1, byte[] t2, byte[] t3,
            byte[] regTemplate, ref int regLength)
        {
            object[] args = new object[] { db, t1, t2, t3, regTemplate, regLength };
            int r = (int)_dbMerge.Invoke(null, args);
            regLength = (int)args[5];
            return r;
        }

        public static int DBAdd(IntPtr db, int fid, byte[] regTemplate)
        {
            return (int)_dbAdd.Invoke(null, new object[] { db, fid, regTemplate });
        }

        public static int DBDel(IntPtr db, int fid)
        {
            return (int)_dbDel.Invoke(null, new object[] { db, fid });
        }

        public static int DBClear(IntPtr db)
        {
            return (int)_dbClear.Invoke(null, new object[] { db });
        }

        /// <summary>
        /// 1:N search. `fid` comes back as whatever was passed to DBAdd, which
        /// is how a match becomes a staff member.
        /// </summary>
        public static int DBIdentify(IntPtr db, byte[] template,
            ref int fid, ref int score)
        {
            object[] args = new object[] { db, template, fid, score };
            int r = (int)_dbIdentify.Invoke(null, args);
            fid = (int)args[2];
            score = (int)args[3];
            return r;
        }

        /// <summary>1:1 compare. Above zero is a match.</summary>
        public static int DBMatch(IntPtr db, byte[] t1, byte[] t2)
        {
            return (int)_dbMatch.Invoke(null, new object[] { db, t1, t2 });
        }

        /// <summary>Plain English for the codes that reach a log or a screen.</summary>
        public static string Explain(int code)
        {
            switch (code)
            {
                case OK: return "ok";
                case ERR_ALREADY_INIT: return "already initialised";
                case ERR_NO_DEVICE: return "no reader is plugged in";
                case ERR_OPEN: return "the reader would not start (driver or USB port)";
                case ERR_CAPTURE: return "nothing on the glass";
                case ERR_EXTRACT_FP: return "could not read that print — press flat and firm";
                case ERR_BUSY: return "already capturing";
                case ERR_ADD_FINGER: return "the template was refused";
                case ERR_MERGE: return "the three captures were not the same finger";
                case ERR_NOT_OPENED: return "the reader is not open";
                case ERR_NOT_INIT: return "the SDK is not initialised";
                case ERR_FAIL: return "the operation failed";
                default: return "error " + code;
            }
        }
    }
}
