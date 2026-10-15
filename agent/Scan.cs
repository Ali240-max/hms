using System;
using System.Collections.Generic;

namespace HmsAttendance
{
    /// <summary>
    /// Has the finger come off the glass since the last thing we did with it?
    ///
    /// THIS IS THE FIX FOR THE READER THAT TOOK FIVE PRESSES.
    ///
    /// The reader returns a capture many times a second for as long as a
    /// finger rests on it. Enrolment used to take a capture, sleep 900 ms
    /// and take the next, so a person who held their finger down for two
    /// seconds gave all three "presses" from ONE placement. The merged
    /// template then knew one small patch of one finger, very well.
    ///
    /// At the door, a finger lands slightly differently every time. Only a
    /// placement close to that one patch matched, which is a person pressing
    /// five or six times until they happen to put it down the same way —
    /// exactly the complaint, and exactly why enrolment itself "worked
    /// instantly": it never waited for anything.
    ///
    /// So every step now waits for the glass to be EMPTY before it will act on
    /// another capture: each enrolment press is a separate placement, and one
    /// placement at the door is one attempt and at most one punch.
    ///
    /// Pure bookkeeping, no SDK, so it can be tested without a reader.
    /// </summary>
    internal class FingerGate
    {
        /*
         * Empty reads in a row that count as "lifted".
         *
         * One empty read is not enough: a finger rocking on the glass can
         * drop a frame. Two in a row at the capture loop's pace is a couple
         * of hundred milliseconds of nothing, which is a finger that has
         * actually come off.
         */
        public const int LIFT_READS = 2;

        private int _emptyRun;
        private bool _armed;
        private int _failures;

        /// <summary>A new placement may be acted on.</summary>
        public bool Armed { get { return _armed; } }

        /// <summary>Failed attempts during the current placement.</summary>
        public int Failures { get { return _failures; } }

        public void SawEmpty()
        {
            if (_emptyRun < LIFT_READS) _emptyRun++;
            if (_emptyRun >= LIFT_READS)
            {
                _armed = true;
                _failures = 0;
            }
        }

        public void SawFinger()
        {
            _emptyRun = 0;
        }

        /// <summary>Act on nothing more until the finger has been lifted.</summary>
        public void WaitForLift()
        {
            _armed = false;
            _failures = 0;
        }

        /// <summary>Count a failed attempt on this placement; returns the count.</summary>
        public int Failed()
        {
            return ++_failures;
        }
    }

    /// <summary>
    /// The matching library, as far as the scan decisions need it.
    ///
    /// An interface so the decisions can be tested with a fake; the real one
    /// is in Program.cs and calls the ZKFinger SDK.
    /// </summary>
    internal interface IFingerOps
    {
        /// <summary>1:N. True, with the fid, when an enrolled finger matches.</summary>
        bool Identify(byte[] template, out int fid, out int score);

        /// <summary>1:1. True when the two templates are the same finger.</summary>
        bool Same(byte[] a, byte[] b);

        /// <summary>Three captures into one stored template, or null and why.</summary>
        byte[] Merge(byte[] a, byte[] b, byte[] c, out string why);

        /// <summary>Make a stored template live for identification.</summary>
        void Store(int fid, byte[] registered);
    }

    internal enum Outcome
    {
        /// <summary>Nothing on the glass, or a code that is not about a finger.</summary>
        Nothing,
        /// <summary>A finger is still down from something already dealt with.</summary>
        Waiting,
        /// <summary>No match yet on this placement; the next capture is another try.</summary>
        Retrying,
        Matched,
        /// <summary>Matched, but the same finger was accepted seconds ago. No punch.</summary>
        Repeat,
        NotRecognised,
        Unreadable,
        EnrolCaptured,
        EnrolDifferent,
        EnrolDone,
        EnrolFailed
    }

    internal class ScanResult
    {
        public Outcome Outcome;
        public int Fid;
        public int Score;
        public string Message = "";

        public ScanResult(Outcome o) { Outcome = o; }
        public ScanResult(Outcome o, string message) { Outcome = o; Message = message; }
    }

    /// <summary>
    /// What one capture means, given what came before it.
    ///
    /// The caller holds a lock around every call, the same lock that guards
    /// reloading the templates, so a reload can never empty the matching
    /// library halfway through an identification.
    /// </summary>
    internal class ReaderLogic
    {
        /*
         * Tries at matching ONE placement before saying "not recognised".
         *
         * Not a lower bar: every try is a full match at the SDK's own
         * threshold, and nothing is accepted without one. What it fixes is a
         * capture taken a moment too early — the finger still landing, half
         * of it on the glass — being reported as a failure when the next
         * frame of the same press would have matched. Three frames is well
         * under a second.
         */
        public const int MAX_ATTEMPTS = 3;

        /*
         * The same finger accepted again inside this window is not a second
         * punch. The lift check already stops one long press becoming many;
         * this is somebody lifting and pressing again because they did not
         * hear the beep. The server has its own five-minute rule as well.
         */
        public static readonly TimeSpan REPEAT = TimeSpan.FromSeconds(5);

        public readonly FingerGate Gate = new FingerGate();
        private readonly IFingerOps _ops;
        private readonly Dictionary<int, DateTime> _accepted = new Dictionary<int, DateTime>();

        /// <summary>The enrolment in progress, if any.</summary>
        public Enrolment Enrolling;

        /// <summary>
        /// The last enrolment to finish, so the screen can read how it ended
        /// after it has ended.
        /// </summary>
        public Enrolment LastEnrolment;

        public ReaderLogic(IFingerOps ops) { _ops = ops; }

        public void StartEnrolment(int staffId, int fingerIndex)
        {
            LastEnrolment = null;
            Enrolling = new Enrolment(staffId, fingerIndex);
            Enrolling.Message = "Place the finger on the reader.";
            /* The first press must be a fresh one, not a finger already resting. */
            Gate.WaitForLift();
        }

        public void CancelEnrolment()
        {
            Enrolling = null;
            Gate.WaitForLift();
        }

        /// <summary>
        /// One capture. `code` is what AcquireFingerprint returned; `captured`
        /// the template it produced, when it produced one.
        /// </summary>
        public ScanResult OnCapture(int code, byte[] captured, DateTime now)
        {
            if (code == Zk.ERR_CAPTURE)
            {
                Gate.SawEmpty();
                return new ScanResult(Outcome.Nothing);
            }

            bool readable = code == Zk.OK && captured != null && captured.Length > 0;
            if (!readable && code != Zk.ERR_EXTRACT_FP && code != Zk.OK)
            {
                /* Busy, or a device error. Not about a finger either way. */
                return new ScanResult(Outcome.Nothing);
            }

            Gate.SawFinger();
            if (!Gate.Armed) return new ScanResult(Outcome.Waiting);

            if (!readable)
            {
                if (Gate.Failed() < MAX_ATTEMPTS) return new ScanResult(Outcome.Retrying);
                Gate.WaitForLift();
                const string msg = "Could not read that print. Lift, then press flat and firm.";
                if (Enrolling != null) Enrolling.Message = msg;
                return new ScanResult(Outcome.Unreadable, msg);
            }

            return Enrolling != null ? Enrol(captured) : Identify(captured, now);
        }

        private ScanResult Identify(byte[] captured, DateTime now)
        {
            int fid, score;
            if (!_ops.Identify(captured, out fid, out score))
            {
                if (Gate.Failed() < MAX_ATTEMPTS) return new ScanResult(Outcome.Retrying);
                Gate.WaitForLift();
                return new ScanResult(Outcome.NotRecognised,
                    "Not recognised. Lift your finger and try again.");
            }

            /* One placement, at most one punch. */
            Gate.WaitForLift();

            ScanResult r;
            DateTime last;
            if (_accepted.TryGetValue(fid, out last) && now - last < REPEAT)
            {
                r = new ScanResult(Outcome.Repeat);
            }
            else
            {
                _accepted[fid] = now;
                r = new ScanResult(Outcome.Matched);
            }
            r.Fid = fid;
            r.Score = score;
            return r;
        }

        private ScanResult Enrol(byte[] captured)
        {
            Enrolment job = Enrolling;

            /*
             * Every press must be the same finger as the first.
             *
             * Without this, somebody using a different finger each time
             * produces a merged template that matches none of the three, and
             * the failure only shows up weeks later at a door.
             */
            if (job.Captures.Count > 0 && !_ops.Same(job.Captures[0], captured))
            {
                Gate.WaitForLift();
                job.Message = "That is a different finger. Lift it and use the same one.";
                return new ScanResult(Outcome.EnrolDifferent, job.Message);
            }

            job.Captures.Add(captured);
            Gate.WaitForLift();

            if (job.Captures.Count < 3)
            {
                job.Message = "Lift your finger, then press it again.";
                return new ScanResult(Outcome.EnrolCaptured, job.Message);
            }

            string why;
            byte[] reg = _ops.Merge(job.Captures[0], job.Captures[1], job.Captures[2], out why);
            if (reg == null) return FailEnrol(job, why + " — start again");

            /*
             * What was made must recognise every press it was made from.
             *
             * Checked here, at the desk, rather than discovered at the door.
             * A template that cannot match its own captures will not match
             * the next placement either.
             */
            for (int i = 0; i < job.Captures.Count; i++)
            {
                if (!_ops.Same(reg, job.Captures[i]))
                {
                    return FailEnrol(job,
                        "The three presses did not agree well enough. Start again, " +
                        "lifting the finger fully between presses.");
                }
            }

            _ops.Store(Fid.Make(job.StaffId, job.FingerIndex), reg);
            job.Template = Convert.ToBase64String(reg);
            job.Done = true;
            job.Message = "Finger enrolled.";
            LastEnrolment = job;
            Enrolling = null;
            return new ScanResult(Outcome.EnrolDone, job.Message);
        }

        private ScanResult FailEnrol(Enrolment job, string message)
        {
            job.Failed = true;
            job.Message = message;
            LastEnrolment = job;
            Enrolling = null;
            Gate.WaitForLift();
            return new ScanResult(Outcome.EnrolFailed, message);
        }
    }
}
